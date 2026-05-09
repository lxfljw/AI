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
    const k = Number.isFinite(requested) && requested > 0
        ? Math.floor(requested)
        : 5;
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
async function loadStudentKnowledgeDocumentsFromText(filePath) {
    const raw = await readFile(filePath, "utf8");
    const basename = path.basename(filePath);
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((pageContent, index) => new Document({
        pageContent,
        metadata: { source: basename, line: index },
    }));
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
async function main() {
    const dimensions = (await embeddings.embedQuery("__dim_probe__")).length;
    const vectorStore = await PGVectorStore.initialize(embeddings, {
        postgresConnectionOptions,
        tableName: RAG_TABLE_NAME,
        dimensions,
        distanceStrategy: "cosine",
    });
    await persistStudentKnowledgeTextToDatabase(vectorStore, STUDENTS_TEXT_PATH);
    const documents = await loadStudentKnowledgeDocumentsFromText(STUDENTS_TEXT_PATH);
    const requestedK = Number.parseInt(process.env.RAG_SEARCH_TOP_K ?? "5", 10);
    const topK = resolveSearchTopK(requestedK, documents.length);
    const results = await search(vectorStore, "蒋子墨", topK);
    console.log(results);
}
main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
//# sourceMappingURL=2.rag.js.map