import { access, constants, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { Document } from "@langchain/core/documents";
import { OllamaEmbeddings } from "@langchain/ollama";

const RAG_TABLE_NAME = "rag_documents";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STUDENTS_PATH = path.resolve(
  __dirname,
  "../../../server/data/students100.txt",
);

export interface RagQueryOptions {
  databaseUrl: string;
  ollamaHost: string;
  embedModel?: string;
  topK?: number;
  studentsFilePath?: string;
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

function parseStudentRecordLine(line: string): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  const head = line.match(/学生：(.+?)\s+id\s+(\d+)/);
  const headName = head?.[1]?.trim();
  const headId = head?.[2];
  if (headName && headId) {
    entities.push({ role: "学生", name: headName, id: headId });
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
    entities.push({ role: "老师", name: tName, id: tId });
  }
  return entities;
}

function entityToPageContent(entity: ParsedEntity): string {
  return `角色：${entity.role}，姓名：${entity.name}，id：${entity.id}`;
}

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

function extractMentionedNameFromPrompt(prompt: string): string | null {
  const patterns = [
    /([\u4e00-\u9fa5]{2,4})的学生/,
    /([\u4e00-\u9fa5]{2,4})的老师/,
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

function resolveSearchTopK(requested: number, corpusSize: number): number {
  const k =
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 5;
  return Math.min(k, Math.max(1, corpusSize));
}

/**
 * 从已入库的 PG 向量库检索知识（不重复灌库；需先用 apps/server 建好索引）
 */
export async function queryRagKnowledge(
  prompt: string,
  options: RagQueryOptions,
): Promise<string> {
  const studentsPath =
    options.studentsFilePath?.trim() || DEFAULT_STUDENTS_PATH;
  const topK = resolveSearchTopK(options.topK ?? 5, 100);

  const embeddings = new OllamaEmbeddings({
    model: options.embedModel ?? "mxbai-embed-large:latest",
    baseUrl: options.ollamaHost.replace(/\/$/, ""),
  });

  const dimensions = (await embeddings.embedQuery("__dim_probe__")).length;
  const vectorStore = await PGVectorStore.initialize(embeddings, {
    postgresConnectionOptions: { connectionString: options.databaseUrl },
    tableName: RAG_TABLE_NAME,
    dimensions,
    distanceStrategy: "cosine",
  });

  try {
    let corpusDocuments: Document[] = [];
    if (await fileExists(studentsPath)) {
      corpusDocuments =
        await loadStudentKnowledgeDocumentsFromText(studentsPath);
    }

    const effectiveTopK = resolveSearchTopK(
      topK,
      Math.max(corpusDocuments.length, 1),
    );

    const nameHint = extractMentionedNameFromPrompt(prompt);
    if (nameHint && corpusDocuments.length > 0) {
      const nameMatches = documentsMatchingPersonName(
        corpusDocuments,
        nameHint,
      );
      if (nameMatches.length > 0) {
        const synthetic: [Document, number][] = nameMatches.map((d) => [
          d,
          1,
        ]);
        return formatVectorResultsAsRagText(synthetic);
      }

      const fuzzy = documentsMatchingFuzzyPersonName(
        corpusDocuments,
        nameHint,
      );
      if (fuzzy !== null && fuzzy.docs.length > 0) {
        const note = `【检索说明】问句中的姓名「${nameHint}」在库中无完全一致记录，已按编辑距离最近匹配为「${fuzzy.matchedNames.join("、")}」（距离 ${fuzzy.distance}）。\n`;
        const synthetic: [Document, number][] = fuzzy.docs.map((d) => [d, 1]);
        return note + formatVectorResultsAsRagText(synthetic);
      }
    }

    const embedding = await embeddings.embedQuery(prompt);
    const results = await vectorStore.similaritySearchVectorWithScore(
      embedding,
      effectiveTopK,
    );
    if (results.length === 0) {
      return "知识库中未检索到相关内容。请确认 PostgreSQL 已启动且已用 apps/server 灌入数据。";
    }
    return formatVectorResultsAsRagText(results);
  } finally {
    await vectorStore.end();
  }
}
