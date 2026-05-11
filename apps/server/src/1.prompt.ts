import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, SystemMessage } from "langchain";
import { getStudentKnowledgeDocuments } from "./2.rag.js";

const llm = new ChatOllama({
  model: "qwen3.5:2b",
  /** 关闭 Ollama 思维链，避免 reasoning_content 无限拖长、与正文打架 */
  think: false,
  temperature: 0.1,
  numPredict: 512,
});

const SYSTEM_INSTRUCTION = `你是题库问答助手。用户消息中有【参考资料】和【用户问题】。你只能根据【参考资料】里出现的文字作答，禁止编造；资料内人名为虚构数据，勿以「个人隐私」拒答。

【硬规则】若【参考资料】里已有与用户所问人物对应的条目（含「角色」「姓名」「id」等字段），应用一两句中文给出该条目的完整信息：须包含资料中出现的全部字段（至少含角色、姓名、id），可原样引用或简短概括，不要只回答 id 数字而省略其它字段。禁止回复「参考资料中未找到」或「不知道」。

若【参考资料】开头有【检索说明】（姓名近似匹配），仍须根据紧随其后的条目完整作答，并可在回答里说明「按资料中的近似姓名……」。

仅当【参考资料】中完全不存在与问题相关的人名或条目时，才回复「参考资料中未找到」。

禁止思维过程、禁止长段英文。`;

/** 检索结果里会夹相似度分数（单独一行的数字），给小模型容易误判，进模型前去掉。 */
function ragTextForModel(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t === "") return false;
      return !/^\d+(\.\d+)?$/.test(t);
    })
    .join("\n");
}

/** 与 2.rag 问句人名规则保持一致，便于和资料里「姓名：」对齐。 */
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

function parseRagEntityLines(
  rag: string,
): { role: string; name: string; id: string }[] {
  const re = /角色：([^，\n]+)，姓名：([^，\n]+)，id：(\d+)/g;
  const out: { role: string; name: string; id: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rag)) !== null) {
    out.push({ role: m[1]!, name: m[2]!, id: m[3]! });
  }
  return out;
}

/** 从 2.rag 生成的【检索说明】里解析「最近匹配为「xxx」」中的人名列表。 */
function parseFuzzyTargetNamesFromRag(rag: string): string[] {
  const m = rag.match(/最近匹配为「([^」]+)」/);
  if (!m?.[1]) return [];
  return m[1]
    .split(/[、，,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 精确命中或【检索说明】+ 资料行：注入硬事实，避免小模型在模糊命中时仍答「未找到」。 */
function buildVerifiedFactSystemMessage(
  prompt: string,
  ragForLlm: string,
): SystemMessage | null {
  const hint = extractMentionedNameFromPrompt(prompt);
  if (!hint) return null;
  const rows = parseRagEntityLines(ragForLlm);

  const exact = rows.find((r) => r.name === hint);
  if (exact) {
    const line = `角色：${exact.role}，姓名：${exact.name}，id：${exact.id}`;
    return new SystemMessage(
      `【已核验·须遵守】参考资料中与「${exact.name}」对应的完整条目为：${line}。回答时必须包含上述全部字段（角色、姓名、id），不得只答 id、不得遗漏字段，禁止使用「参考资料中未找到」「不知道」「无法提供」。`,
    );
  }

  if (!ragForLlm.includes("【检索说明】")) return null;
  const fuzzyNames = parseFuzzyTargetNamesFromRag(ragForLlm);
  if (fuzzyNames.length === 0) return null;
  const hits = rows.filter((r) => fuzzyNames.includes(r.name));
  if (hits.length === 0) return null;

  const lines = hits
    .map((h) => `角色：${h.role}，姓名：${h.name}，id：${h.id}`)
    .join("；");
  return new SystemMessage(
    `【已核验·须遵守】用户问句姓名为「${hint}」；【参考资料】已按近似匹配到资料姓名「${fuzzyNames.join("、")}」。以下条目为有效事实，必须据此完整作答（角色、姓名、id 缺一不可），并说明问句姓名与资料姓名为近似匹配：${lines}。禁止使用「参考资料中未找到」「不知道」「无法提供」。`,
  );
}

async function main() {
  const prompt = "你好，卢想阳的学生信息是什么？";
  const ragInfo = await getStudentKnowledgeDocuments(prompt);
  console.log("ragInfo", ragInfo);
  console.log("开始调用大模型");
  const ragForLlm = ragTextForModel(ragInfo);
  const verified = buildVerifiedFactSystemMessage(prompt, ragForLlm);
  const messages: (SystemMessage | HumanMessage)[] = [
    new SystemMessage(SYSTEM_INSTRUCTION),
  ];
  if (verified) messages.push(verified);
  messages.push(
    new HumanMessage(`【参考资料】\n${ragForLlm}\n\n【用户问题】\n${prompt}`),
  );
  const res = await llm.invoke(messages);
  console.log("大模型返回的结果：", res.content);
  return res;
}

main()
  .then()
  .catch((err) => {
    console.error(err);
  });
