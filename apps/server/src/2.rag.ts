// RAG：Retrieval-Augmented Generation 检索增强生成

import { access, constants, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OllamaEmbeddings } from "@langchain/ollama";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { Document } from "@langchain/core/documents";
import type { PoolConfig } from "pg";
import pg from "pg";

const RAG_TABLE_NAME = "rag_documents";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDENTS_TEXT_PATH = path.join(
  __dirname,
  "..",
  "data",
  "students100.txt",
);

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://rag:rag@127.0.0.1:5432/rag";

const postgresConnectionOptions: PoolConfig = {
  connectionString,
};

const embeddings = new OllamaEmbeddings({
  model: "mxbai-embed-large:latest",
  baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
});

/** LangChain PGVectorStore 单次 SQL INSERT 的行数上限（库内默认 500） */
const PGVECTOR_SQL_INSERT_CHUNK = 500;

function logRag(stage: string, detail?: Record<string, unknown>) {
  if (detail) console.log(`[rag-ingest] ${stage}`, detail);
  else console.log(`[rag-ingest] ${stage}`);
}

function resolveIngestBatchSize(): number {
  const n = Number.parseInt(process.env.RAG_INGEST_BATCH_SIZE ?? "50", 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

async function search(
  vectorStore: PGVectorStore,
  text: string,
  topK: number,
): Promise<[Document, number][]> {
  const embedding = await embeddings.embedQuery(text);
  return vectorStore.similaritySearchVectorWithScore(embedding, topK);
}

function resolveSearchTopK(requested: number, corpusSize: number): number {
  const k =
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 5;
  return Math.min(k, Math.max(1, corpusSize));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

type ParsedRole = "学生" | "老师";

interface ParsedEntity {
  role: ParsedRole;
  name: string;
  id: string;
}

/** 将一行「学生：… id …，学生，…，id：…，老师：…，id：…」拆成多条独立事实，便于向量检索区分人名。 */
function parseStudentRecordLine(line: string): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
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
    if (name && id) entities.push({ role: "学生", name, id });
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

function entityToPageContent(entity: ParsedEntity): string {
  return `角色：${entity.role}，姓名：${entity.name}，id：${entity.id}`;
}

/** Levenshtein 距离，用于姓名笔误/近似匹配。 */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}

function maxNameEditDistanceForQuery(queryLen: number): number {
  if (queryLen <= 2) return 1;
  if (queryLen <= 4) return 2;
  return 3;
}

/** 精确匹配失败时，按与问句人名的编辑距离在库中人名里找最近者（如「崔用例」→「崔瑞霖」）。 */
function documentsMatchingFuzzyPersonName(
  documents: Document[],
  queryName: string,
): { docs: Document[]; matchedNames: string[]; distance: number } | null {
  const names = new Set<string>();
  for (const d of documents) {
    const n = d.metadata.name;
    if (typeof n === "string" && n.length > 0) names.add(n);
  }
  if (names.size === 0) return null;

  const maxDist = maxNameEditDistanceForQuery(queryName.length);
  let best = Infinity;
  const scores = new Map<string, number>();
  for (const n of names) {
    const d = levenshteinDistance(queryName, n);
    scores.set(n, d);
    if (d < best) best = d;
  }
  if (best === Infinity || best > maxDist) return null;

  const matchedNames = [...names].filter((n) => scores.get(n) === best);
  const docs = documents.filter((d) => {
    const meta = d.metadata.name;
    return typeof meta === "string" && matchedNames.includes(meta);
  });
  return { docs, matchedNames, distance: best };
}

/** 从常见问法里抽人名，用于结构化精确匹配，弥补纯向量对中文短名区分不足。 */
function extractMentionedNameFromPrompt(prompt: string): string | null {
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
    if (name && name.length >= 2) return name;
  }
  return null;
}

function documentsMatchingPersonName(
  documents: Document[],
  name: string,
): Document[] {
  return documents.filter((d) => {
    const metaName = d.metadata.name;
    return typeof metaName === "string" && metaName === name;
  });
}

function formatVectorResultsAsRagText(
  results: [Document, number][],
): string {
  return results
    .map((result) =>
      result
        .map((res) =>
          typeof res === "number" ? String(res) : res.pageContent || "",
        )
        .join("\n"),
    )
    .join("\n");
}

async function loadStudentKnowledgeDocumentsFromText(
  filePath: string,
): Promise<Document[]> {
  const raw = await readFile(filePath, "utf8");
  const basename = path.basename(filePath);
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const documents: Document[] = [];
  lines.forEach((line, index) => {
    const entities = parseStudentRecordLine(line);
    if (entities.length === 0) {
      documents.push(
        new Document({
          pageContent: line,
          metadata: { source: basename, line: index },
        }),
      );
      return;
    }
    for (const entity of entities) {
      documents.push(
        new Document({
          pageContent: entityToPageContent(entity),
          metadata: {
            source: basename,
            line: index,
            role: entity.role,
            name: entity.name,
            id: entity.id,
          },
        }),
      );
    }
  });
  return documents;
}

async function clearRagDocumentsTable(): Promise<void> {
  logRag("清空表", { table: RAG_TABLE_NAME });
  const pool = new pg.Pool({ connectionString });
  await pool.query(`TRUNCATE TABLE ${RAG_TABLE_NAME}`);
  await pool.end();
}

/**
 * 分批灌库：每批一次 Ollama embed（批量 texts）+ PG 批量 INSERT。
 * 不是「一条一条 commit」；完成一批后库里才能查到该批行数增加。
 */
async function saveRagDocumentsToDatabase(
  vectorStore: PGVectorStore,
  documents: Document[],
): Promise<void> {
  const batchSize = resolveIngestBatchSize();
  const total = documents.length;
  const batchTotal = Math.ceil(total / batchSize);
  const started = Date.now();

  logRag("写入策略", {
    totalDocuments: total,
    ingestBatchSize: batchSize,
    ingestBatches: batchTotal,
    ollamaEmbed: "每批一次 client.embed({ input: texts[] })",
    postgresInsert: `每批向量算完后 SQL 批量 INSERT（单条 SQL 最多 ${PGVECTOR_SQL_INSERT_CHUNK} 行）`,
    env: "RAG_INGEST_BATCH_SIZE 可调每批文档数",
  });

  for (let i = 0; i < total; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);
    const batchNo = Math.floor(i / batchSize) + 1;
    const batchStarted = Date.now();
    logRag("批次开始", {
      batch: `${batchNo}/${batchTotal}`,
      docRange: `${i + 1}-${i + batch.length}`,
      count: batch.length,
    });
    await vectorStore.addDocuments(batch);
    logRag("批次完成", {
      batch: `${batchNo}/${batchTotal}`,
      ms: Date.now() - batchStarted,
      progress: `${Math.min(i + batch.length, total)}/${total}`,
    });
  }

  logRag("全部批次完成", {
    totalDocuments: total,
    ms: Date.now() - started,
  });
}

async function persistStudentKnowledgeTextToDatabase(
  vectorStore: PGVectorStore,
  textFilePath: string,
): Promise<void> {
  if (!(await fileExists(textFilePath))) {
    throw new Error(`知识库文本不存在: ${textFilePath}`);
  }
  logRag("解析文本", { file: textFilePath });
  const documents = await loadStudentKnowledgeDocumentsFromText(textFilePath);
  if (documents.length === 0) {
    throw new Error(`知识库文本无非空行: ${textFilePath}`);
  }
  logRag("解析完成", {
    file: textFilePath,
    documentCount: documents.length,
    note: "一行学籍通常拆成约 3 条 Document（主学生+同学+老师）",
  });
  if (process.env.RAG_APPEND !== "1") {
    await clearRagDocumentsTable();
  } else {
    logRag("追加模式", { RAG_APPEND: "1", skipTruncate: true });
  }
  await saveRagDocumentsToDatabase(vectorStore, documents);
}

/** 将指定文本文件灌入 PG 向量表（默认先 TRUNCATE，设 RAG_APPEND=1 则追加） */
export async function ingestStudentKnowledgeFile(
  textFilePath: string,
): Promise<{ lineCount: number; documentCount: number }> {
  const ingestStarted = Date.now();
  logRag("灌库开始", {
    file: textFilePath,
    database: connectionString.replace(/:[^:@/]+@/, ":***@"),
    ollama: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    embedModel: "mxbai-embed-large:latest",
  });

  const raw = await readFile(textFilePath, "utf8");
  const lineCount = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;

  logRag("探测向量维度…");
  const dimensions = (await embeddings.embedQuery("__dim_probe__")).length;
  logRag("初始化 PGVectorStore", { table: RAG_TABLE_NAME, dimensions });

  const vectorStore = await PGVectorStore.initialize(embeddings, {
    postgresConnectionOptions,
    tableName: RAG_TABLE_NAME,
    dimensions,
    distanceStrategy: "cosine",
  });

  try {
    await persistStudentKnowledgeTextToDatabase(vectorStore, textFilePath);
    const documents =
      await loadStudentKnowledgeDocumentsFromText(textFilePath);
    logRag("灌库结束", {
      lineCount,
      documentCount: documents.length,
      ms: Date.now() - ingestStarted,
    });
    return { lineCount, documentCount: documents.length };
  } finally {
    await vectorStore.end();
  }
}

export async function getStudentKnowledgeDocuments(prompt: string) {
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

    const documents =
      await loadStudentKnowledgeDocumentsFromText(STUDENTS_TEXT_PATH);
    const requestedK = Number.parseInt(process.env.RAG_SEARCH_TOP_K ?? "5", 10);
    const topK = resolveSearchTopK(requestedK, documents.length);

    const nameHint = extractMentionedNameFromPrompt(prompt);
    const nameMatches =
      nameHint !== null
        ? documentsMatchingPersonName(documents, nameHint)
        : [];
    if (nameMatches.length > 0) {
      const synthetic: [Document, number][] = nameMatches.map((d) => [d, 1]);
      return formatVectorResultsAsRagText(synthetic);
    }

    if (nameHint !== null) {
      const fuzzy = documentsMatchingFuzzyPersonName(documents, nameHint);
      if (fuzzy !== null && fuzzy.docs.length > 0) {
        const note = `【检索说明】问句中的姓名「${nameHint}」在库中无完全一致记录，已按编辑距离最近匹配为「${fuzzy.matchedNames.join("、")}」（距离 ${fuzzy.distance}）。\n`;
        const synthetic: [Document, number][] = fuzzy.docs.map((d) => [d, 1]);
        return note + formatVectorResultsAsRagText(synthetic);
      }
    }

    const results = await search(vectorStore, prompt, topK);
    return formatVectorResultsAsRagText(results);
  } finally {
    await vectorStore.end();
  }
}
