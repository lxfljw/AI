import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ingestStudentKnowledgeFile } from "./2.rag.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, "..", "data", "students1000.txt");

const SURNAMES = [
  "赵", "钱", "孙", "李", "周", "吴", "郑", "王", "冯", "陈", "褚", "卫", "蒋",
  "沈", "韩", "杨", "朱", "秦", "尤", "许", "何", "吕", "施", "张", "孔", "曹",
  "严", "华", "金", "魏", "陶", "姜", "戚", "谢", "邹", "喻", "柏", "水", "窦",
  "章", "云", "苏", "潘", "葛", "奚", "范", "彭", "郎", "鲁", "韦", "昌", "马",
];

const GIVEN_PARTS = [
  "子轩", "梓涵", "雨桐", "思远", "嘉怡", "宇航", "诗琪", "俊杰", "欣妍", "浩然",
  "雅馨", "文博", "梦洁", "天佑", "佳琪", "明轩", "晓彤", "建国", "秀英", "志强",
  "丽华", "海涛", "春梅", "国庆", "桂英", "小红", "小明", "晓东", "雪梅", "建军",
];

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomId(): string {
  return String(randomInt(10000, 999999));
}

function randomName(): string {
  const s = SURNAMES[randomInt(0, SURNAMES.length - 1)]!;
  const g1 = GIVEN_PARTS[randomInt(0, GIVEN_PARTS.length - 1)]!;
  const g2 = GIVEN_PARTS[randomInt(0, GIVEN_PARTS.length - 1)]!;
  return `${s}${g1}${g2.slice(0, 1)}`;
}

function pickDistinctNames(count: number): string[] {
  const names: string[] = [];
  const used = new Set<string>();
  let guard = 0;
  while (names.length < count && guard < count * 50) {
    guard += 1;
    const name = randomName();
    if (used.has(name)) continue;
    used.add(name);
    names.push(name);
  }
  while (names.length < count) {
    names.push(`学员${names.length + 1}`);
  }
  return names;
}

/** 与 students100.txt 同行格式，便于 2.rag 解析 */
function buildRecordLine(main: string, peer: string, teacher: string): string {
  return `学生：${main} id ${randomId()}， 学生，${peer}，id：${randomId()}，老师：${teacher}，id：${randomId()}`;
}

function generateMockLines(lineCount: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    const names = pickDistinctNames(3);
    const main = names[0]!;
    const peer = names[1]!;
    const teacher = names[2]!;
    lines.push(buildRecordLine(main, peer, teacher));
  }
  return lines;
}

async function main() {
  const lineCount = Number.parseInt(process.env.SEED_COUNT ?? "1000", 10);
  if (!Number.isFinite(lineCount) || lineCount <= 0) {
    throw new Error(`SEED_COUNT 无效: ${process.env.SEED_COUNT}`);
  }

  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://rag:rag@127.0.0.1:5432/rag";
  const ollamaBase = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

  console.log("[seed-rag] 生成模拟数据…", { lineCount, output: OUTPUT_FILE });
  const lines = generateMockLines(lineCount);
  await writeFile(OUTPUT_FILE, `${lines.join("\n")}\n`, "utf8");
  console.log("[seed-rag] 文本已写入", OUTPUT_FILE);

  console.log("[seed-rag] 开始向量化并写入 PostgreSQL…", {
    databaseUrl,
    ollamaBase,
  });
  const started = Date.now();
  const { lineCount: parsedLines, documentCount } =
    await ingestStudentKnowledgeFile(OUTPUT_FILE);
  console.log("[seed-rag] 完成", {
    ms: Date.now() - started,
    parsedLines,
    documentCount,
    hint: "飞书/Nuxt 检索使用表 rag_documents，无需改 students100.txt",
  });
}

main().catch((err) => {
  console.error("[seed-rag] 失败", err);
  process.exit(1);
});
