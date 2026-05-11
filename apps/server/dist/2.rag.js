// RAG：Retrieval-Augmented Generation 检索增强生成
import { access, constants, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OllamaEmbeddings } from "@langchain/ollama";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { Document } from "@langchain/core/documents";
import pg from "pg";
const RAG_TABLE_NAME = "rag_documents";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDENTS_TEXT_PATH = path.join(__dirname, "..", "data", "students100.txt");
const connectionString = process.env.DATABASE_URL ?? "postgresql://rag:rag@127.0.0.1:5432/rag";
const postgresConnectionOptions = {
    connectionString,
};
const embeddings = new OllamaEmbeddings({
    model: "mxbai-embed-large:latest",
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
});
async function search(vectorStore, text, topK) {
    const embedding = await embeddings.embedQuery(text);
    return vectorStore.similaritySearchVectorWithScore(embedding, topK);
}
function resolveSearchTopK(requested, corpusSize) {
    const k = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 5;
    return Math.min(k, Math.max(1, corpusSize));
}
async function fileExists(filePath) {
    try {
        await access(filePath, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
/** 将一行「学生：… id …，学生，…，id：…，老师：…，id：…」拆成多条独立事实，便于向量检索区分人名。 */
function parseStudentRecordLine(line) {
    const entities = [];
    const head = line.match(/学生：(.+?)\s+id\s+(\d+)/);
    const headName = head?.[1]?.trim();
    const headId = head?.[2];
    if (headName && headId) {
        entities.push({
            role: "学生",
            name: headName,
            id: headId,
        });
    }
    for (const m of line.matchAll(/学生，(.+?)，id：(\d+)/g)) {
        const name = m[1]?.trim();
        const id = m[2];
        if (name && id)
            entities.push({ role: "学生", name, id });
    }
    const teacher = line.match(/老师：(.+?)，id：(\d+)/);
    const tName = teacher?.[1]?.trim();
    const tId = teacher?.[2];
    if (tName && tId) {
        entities.push({
            role: "老师",
            name: tName,
            id: tId,
        });
    }
    return entities;
}
function entityToPageContent(entity) {
    return `角色：${entity.role}，姓名：${entity.name}，id：${entity.id}`;
}
/** Levenshtein 距离，用于姓名笔误/近似匹配。 */
function levenshteinDistance(a, b) {
    if (a === b)
        return 0;
    const m = a.length;
    const n = b.length;
    if (m === 0)
        return n;
    if (n === 0)
        return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++)
        dp[i][0] = i;
    for (let j = 0; j <= n; j++)
        dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return dp[m][n];
}
function maxNameEditDistanceForQuery(queryLen) {
    if (queryLen <= 2)
        return 1;
    if (queryLen <= 4)
        return 2;
    return 3;
}
/** 精确匹配失败时，按与问句人名的编辑距离在库中人名里找最近者（如「崔用例」→「崔瑞霖」）。 */
function documentsMatchingFuzzyPersonName(documents, queryName) {
    const names = new Set();
    for (const d of documents) {
        const n = d.metadata.name;
        if (typeof n === "string" && n.length > 0)
            names.add(n);
    }
    if (names.size === 0)
        return null;
    const maxDist = maxNameEditDistanceForQuery(queryName.length);
    let best = Infinity;
    const scores = new Map();
    for (const n of names) {
        const d = levenshteinDistance(queryName, n);
        scores.set(n, d);
        if (d < best)
            best = d;
    }
    if (best === Infinity || best > maxDist)
        return null;
    const matchedNames = [...names].filter((n) => scores.get(n) === best);
    const docs = documents.filter((d) => {
        const meta = d.metadata.name;
        return typeof meta === "string" && matchedNames.includes(meta);
    });
    return { docs, matchedNames, distance: best };
}
/** 从常见问法里抽人名，用于结构化精确匹配，弥补纯向量对中文短名区分不足。 */
function extractMentionedNameFromPrompt(prompt) {
    const patterns = [
        /([\u4e00-\u9fa5]{2,4})的学生/,
        /([\u4e00-\u9fa5]{2,4})的老师/,
        // 口语常省略「的」：如「崔用例学生 id」
        /([\u4e00-\u9fa5]{2,4}?)学生/,
        /([\u4e00-\u9fa5]{2,4}?)老师/,
        /学生[：:]\s*([\u4e00-\u9fa5]{2,4})/,
        /老师[：:]\s*([\u4e00-\u9fa5]{2,4})/,
    ];
    for (const re of patterns) {
        const m = prompt.match(re);
        const name = m?.[1];
        if (name && name.length >= 2)
            return name;
    }
    return null;
}
function documentsMatchingPersonName(documents, name) {
    return documents.filter((d) => {
        const metaName = d.metadata.name;
        return typeof metaName === "string" && metaName === name;
    });
}
function formatVectorResultsAsRagText(results) {
    return results
        .map((result) => result
        .map((res) => typeof res === "number" ? String(res) : res.pageContent || "")
        .join("\n"))
        .join("\n");
}
async function loadStudentKnowledgeDocumentsFromText(filePath) {
    const raw = await readFile(filePath, "utf8");
    const basename = path.basename(filePath);
    const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const documents = [];
    lines.forEach((line, index) => {
        const entities = parseStudentRecordLine(line);
        if (entities.length === 0) {
            documents.push(new Document({
                pageContent: line,
                metadata: { source: basename, line: index },
            }));
            return;
        }
        for (const entity of entities) {
            documents.push(new Document({
                pageContent: entityToPageContent(entity),
                metadata: {
                    source: basename,
                    line: index,
                    role: entity.role,
                    name: entity.name,
                    id: entity.id,
                },
            }));
        }
    });
    return documents;
}
async function clearRagDocumentsTable() {
    const pool = new pg.Pool({ connectionString });
    await pool.query(`TRUNCATE TABLE ${RAG_TABLE_NAME}`);
    await pool.end();
}
async function saveRagDocumentsToDatabase(vectorStore, documents) {
    await vectorStore.addDocuments(documents);
}
async function persistStudentKnowledgeTextToDatabase(vectorStore, textFilePath) {
    if (!(await fileExists(textFilePath))) {
        throw new Error(`知识库文本不存在: ${textFilePath}`);
    }
    const documents = await loadStudentKnowledgeDocumentsFromText(textFilePath);
    if (documents.length === 0) {
        throw new Error(`知识库文本无非空行: ${textFilePath}`);
    }
    if (process.env.RAG_APPEND !== "1") {
        await clearRagDocumentsTable();
    }
    await saveRagDocumentsToDatabase(vectorStore, documents);
}
export async function getStudentKnowledgeDocuments(prompt) {
    console.log("rag 提示词", prompt);
    const dimensions = (await embeddings.embedQuery("__dim_probe__")).length;
    const vectorStore = await PGVectorStore.initialize(embeddings, {
        postgresConnectionOptions,
        tableName: RAG_TABLE_NAME,
        dimensions,
        distanceStrategy: "cosine",
    });
    try {
        await persistStudentKnowledgeTextToDatabase(vectorStore, STUDENTS_TEXT_PATH);
        const documents = await loadStudentKnowledgeDocumentsFromText(STUDENTS_TEXT_PATH);
        const requestedK = Number.parseInt(process.env.RAG_SEARCH_TOP_K ?? "5", 10);
        const topK = resolveSearchTopK(requestedK, documents.length);
        const nameHint = extractMentionedNameFromPrompt(prompt);
        const nameMatches = nameHint !== null
            ? documentsMatchingPersonName(documents, nameHint)
            : [];
        if (nameMatches.length > 0) {
            const synthetic = nameMatches.map((d) => [d, 1]);
            return formatVectorResultsAsRagText(synthetic);
        }
        if (nameHint !== null) {
            const fuzzy = documentsMatchingFuzzyPersonName(documents, nameHint);
            if (fuzzy !== null && fuzzy.docs.length > 0) {
                const note = `【检索说明】问句中的姓名「${nameHint}」在库中无完全一致记录，已按编辑距离最近匹配为「${fuzzy.matchedNames.join("、")}」（距离 ${fuzzy.distance}）。\n`;
                const synthetic = fuzzy.docs.map((d) => [d, 1]);
                return note + formatVectorResultsAsRagText(synthetic);
            }
        }
        const results = await search(vectorStore, prompt, topK);
        return formatVectorResultsAsRagText(results);
    }
    finally {
        await vectorStore.end();
    }
}
//# sourceMappingURL=2.rag.js.map