import { HumanMessage } from "@langchain/core/messages";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { SseToolPayload } from "~~/shared/demo-sse";
import { runLangchainReactAgentOnce } from "../utils/ollamaAgent";

function logStage(stage: string, detail?: Record<string, unknown>) {
  if (detail) {
    console.log(`[feishu-ws] ${stage}`, detail);
  } else {
    console.log(`[feishu-ws] ${stage}`);
  }
}

const AGENT_LOG_PREVIEW_MAX = 800;
const AGENT_MODEL_CHUNK_FLUSH = 300;

function previewForAgentLog(value: unknown, max = AGENT_LOG_PREVIEW_MAX): unknown {
  if (value === undefined || value === null) return value;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 0);
  if (text.length <= max) return value;
  return `${text.slice(0, max)}…(${text.length} 字符)`;
}

function flushAgentModelBuffer(buffer: string) {
  if (!buffer) return;
  logStage("Agent 模型中间输出", {
    length: buffer.length,
    preview: previewForAgentLog(buffer),
  });
}

function logAgentToolEvent(evt: SseToolPayload, modelBuffer: { value: string }) {
  flushAgentModelBuffer(modelBuffer.value);
  modelBuffer.value = "";

  if (evt.phase === "start") {
    logStage("Agent 工具开始", {
      name: evt.name,
      toolCallId: evt.toolCallId,
      input: previewForAgentLog(evt.input),
    });
    return;
  }
  if (evt.phase === "end") {
    logStage("Agent 工具结束", {
      name: evt.name,
      toolCallId: evt.toolCallId,
      output: previewForAgentLog(evt.output),
    });
    return;
  }
  logStage("Agent 工具失败", {
    name: evt.name,
    toolCallId: evt.toolCallId,
    error: previewForAgentLog(evt.error),
  });
}

const RECENT_MESSAGE_TTL_MS = 120_000;
const recentMessageKeys = new Map<string, number>();

function pruneRecentMessageKeys(now: number) {
  for (const [key, ts] of recentMessageKeys) {
    if (now - ts > RECENT_MESSAGE_TTL_MS) recentMessageKeys.delete(key);
  }
}

/** 同一 message_id / event_id 只处理一次 */
function isDuplicateInboundMessage(dedupeKey: string): boolean {
  const now = Date.now();
  pruneRecentMessageKeys(now);
  if (recentMessageKeys.has(dedupeKey)) return true;
  recentMessageKeys.set(dedupeKey, now);
  return false;
}

function parseReceiveEvent(data: unknown) {
  const root = data as Record<string, unknown>;
  const event = (root.event ?? root) as Record<string, unknown>;
  const message = event.message as
    | {
        chat_id?: string;
        content?: string;
        message_id?: string;
      }
    | undefined;
  const sender = event.sender as { sender_type?: string } | undefined;
  const header = root.header as { event_id?: string } | undefined;
  const senderType = sender?.sender_type ?? (message as { sender_type?: string } | undefined)?.sender_type;

  return {
    message,
    sender_type: senderType,
    event_id: typeof header?.event_id === "string" ? header.event_id : undefined,
    message_id:
      typeof message?.message_id === "string" ? message.message_id : undefined,
  };
}

/** 仅处理 sender_type 为 user 的消息（app / 机器人消息一律忽略） */
function isUserInboundMessage(senderType: string | undefined): boolean {
  return senderType === "user";
}

function parseIncomingText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? content;
  } catch {
    return content;
  }
}

export interface FeishuTextMessagePayload {
  content: string;
  msg_type: "text";
}

/** 构造飞书文本消息 content（JSON 字符串） */
export function buildFeishuTextContent(text: string): FeishuTextMessagePayload {
  return {
    msg_type: "text",
    content: JSON.stringify({ text }),
  };
}

/** 一次性发送一条文本消息到指定 chat */
export async function sendFeishuTextOnce(
  client: Lark.Client,
  chatId: string,
  text: string,
  stage?: string,
): Promise<void> {
  logStage(stage ? `发送消息 → ${stage}` : "发送消息", {
    chat_id: chatId,
    preview: text.length > 120 ? `${text.slice(0, 120)}…` : text,
  });
  const { content, msg_type } = buildFeishuTextContent(text);
  await client.im.v1.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: chatId,
      content,
      msg_type,
    },
  });
  logStage(stage ? `发送完成 → ${stage}` : "发送完成", { chat_id: chatId });
}

export interface ReplyOnceWithOllamaOptions {
  host: string;
  model: string;
}

/** 调用 Agent 生成完整回复文本（不发飞书） */
export async function generateOllamaAnswer(
  userText: string,
  ollama: ReplyOnceWithOllamaOptions,
): Promise<string> {
  const started = Date.now();
  logStage("Agent 生成开始", {
    host: ollama.host,
    model: ollama.model,
    userText:
      userText.length > 80 ? `${userText.slice(0, 80)}…` : userText,
  });
  try {
    const modelBuffer = { value: "" };
    const answer = await runLangchainReactAgentOnce({
      host: ollama.host,
      model: ollama.model,
      messages: [new HumanMessage(userText)],
      onDelta: (delta: string) => {
        if (!delta) return;
        modelBuffer.value += delta;
        if (
          modelBuffer.value.length >= AGENT_MODEL_CHUNK_FLUSH ||
          delta.includes("\n")
        ) {
          flushAgentModelBuffer(modelBuffer.value);
          modelBuffer.value = "";
        }
      },
      onToolEvent: (evt) => logAgentToolEvent(evt, modelBuffer),
    });
    flushAgentModelBuffer(modelBuffer.value);
    const trimmed = answer.trim();
    const result = trimmed || "（无回复内容）";
    logStage("Agent 生成完成", {
      ms: Date.now() - started,
      length: result.length,
      preview: result.length > 120 ? `${result.slice(0, 120)}…` : result,
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStage("Agent 生成失败", { ms: Date.now() - started, error: msg });
    return `抱歉，处理失败：${msg}`;
  }
}

/** 一次性回复：Ollama 跑完后发送一条飞书消息 */
export async function replyOnceWithOllama(
  client: Lark.Client,
  chatId: string,
  userText: string,
  ollama: ReplyOnceWithOllamaOptions,
): Promise<void> {
  const answer = await generateOllamaAnswer(userText, ollama);
  await sendFeishuTextOnce(client, chatId, answer);
}

/** 处理 im.message.receive_v1：先回复「正在处理」，再发 AI 完整结果 */
export async function replyImMessageReceiveV1(
  client: Lark.Client,
  data: unknown,
) {
  const flowStarted = Date.now();
  logStage("[1/4] 收到 im.message.receive_v1");

  const { message, sender_type, event_id, message_id } = parseReceiveEvent(data);
  const chat_id = message?.chat_id;
  const content = message?.content;

  if (!chat_id || !content) {
    console.warn(
      "[feishu-ws] im.message.receive_v1 缺少 chat_id 或 content",
      JSON.stringify(data),
    );
    return;
  }

  if (!isUserInboundMessage(sender_type)) {
    logStage("跳过：仅处理 user 消息", { sender_type, message_id });
    return;
  }

  const userText = parseIncomingText(content);

  const dedupeKey =
    message_id ?? event_id ?? `${chat_id}:${userText}`;
  if (isDuplicateInboundMessage(dedupeKey)) {
    logStage("跳过：重复消息", { dedupeKey, message_id, event_id });
    return;
  }
  const config = useRuntimeConfig();
  const ollama = {
    host: String(config.ollamaHost).trim(),
    model: String(config.ollamaModel).trim(),
  };

  logStage("[2/4] 解析完成", { chat_id, userText });

  try {
    logStage("[3/4] 发送「正在处理」提示");
    await sendFeishuTextOnce(
      client,
      chat_id,
      `正在处理你的提问：${userText}，请稍后。。。`,
      "正在处理",
    );

    const answer = await generateOllamaAnswer(userText, ollama);

    logStage("[4/4] 发送 AI 完整回复");
    await sendFeishuTextOnce(client, chat_id, answer, "AI回复");

    logStage("流程结束", { chat_id, totalMs: Date.now() - flowStarted });
  } catch (err) {
    console.error("[feishu-ws] 流程失败", {
      chat_id,
      totalMs: Date.now() - flowStarted,
      err,
    });
  }
}
