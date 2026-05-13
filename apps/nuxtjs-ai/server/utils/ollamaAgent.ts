import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatOllama } from "@langchain/ollama";
import { createAgent } from "langchain";
import * as z from "zod";

import type { SseToolPayload } from "../../shared/demo-sse";

/** {@link runLangchainReactAgentStream} 的输入与流式回调 */
export interface LangchainAgentStreamOptions {
  /** Ollama 服务根地址，如 http://127.0.0.1:11434 */
  host: string;
  /** Ollama 模型名 */
  model: string;
  /** 已构造好的对话消息列表 */
  messages: BaseMessage[];
  /** 模型输出增量文本（按 chunk） */
  onDelta: (text: string) => void;
  /** LangGraph tools 流：结构化工具事件（前端可对 phase 分别展示） */
  onToolEvent?: (evt: SseToolPayload) => void;
}

/** 注册供 Agent 调用的内置工具（时间、算术） */
function buildTools() {
  const getServerTime = tool(
    () => ({ utc: new Date().toISOString() }),
    {
      name: "get_server_time",
      description: "获取当前服务器 UTC 时间的 ISO 字符串",
      schema: z.object({}),
    },
  );

  const calculator = tool(
    ({ expression }: { expression: string }) => {
      const trimmed = expression.trim();
      if (!/^[\d\s+\-*/().]+$/.test(trimmed)) {
        return "仅支持数字与运算符 + - * / ( )";
      }
      try {
        const n = Function(`"use strict"; return (${trimmed})`)();
        return String(n);
      } catch (e) {
        return `计算失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    {
      name: "calculator",
      description: "计算仅含数字与 +-*/() 的算术表达式",
      schema: z.object({
        expression: z.string().describe("算术表达式，如 (12+3)*2"),
      }),
    },
  );

  return [getServerTime, calculator];
}

/** 从 LangChain 消息的 content 字段抽出纯文本（兼容 string / 多块文本数组） */
function extractTextContent(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part)
          return String((part as { text: string }).text);
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * 将模型侧消息转为对用户可见的流式文本。
 * 流式阶段主要为 AIMessageChunk；完结且无 tool_calls 的 AIMessage 也会兜底输出正文。
 */
function dispatchModelToken(msg: BaseMessage, onDelta: (text: string) => void) {
  if (msg instanceof AIMessageChunk) {
    const text = extractTextContent(msg.content);
    if (text) onDelta(text);
    return;
  }
  if (
    msg instanceof AIMessage &&
    (!msg.tool_calls || msg.tool_calls.length === 0)
  ) {
    const text = extractTextContent(msg.content);
    if (text) onDelta(text);
  }
}

/**
 * 解析 LangGraph stream 的单帧（可能是 `[mode, payload]` 或直接 `[msg, meta]`）。
 * `messages` 走模型 token，`tools` 走工具生命周期文案。
 */
function handleStreamChunk(
  chunk: unknown,
  onDelta: (text: string) => void,
  onToolEvent?: (evt: SseToolPayload) => void,
): void {
  if (!Array.isArray(chunk)) return;

  if (chunk.length === 2 && typeof chunk[0] === "string") {
    const mode = chunk[0];
    const payload = chunk[1];
    if (mode === "messages") {
      const inner = payload as unknown;
      const msg = Array.isArray(inner)
        ? (inner[0] as BaseMessage)
        : (payload as BaseMessage);
      dispatchModelToken(msg, onDelta);
      return;
    }
    if (mode === "tools" && onToolEvent) {
      const toolEvt = payload as Record<string, unknown>;
      const ev = toolEvt.event as string | undefined;
      const name = String(toolEvt.name ?? "unknown");
      const toolCallId =
        typeof toolEvt.toolCallId === "string"
          ? toolEvt.toolCallId
          : undefined;
      if (ev === "on_tool_start") {
        onToolEvent({
          type: "tool",
          phase: "start",
          name,
          toolCallId,
          input: toolEvt.input,
        });
      } else if (ev === "on_tool_end") {
        onToolEvent({
          type: "tool",
          phase: "end",
          name,
          toolCallId,
          output: toolEvt.output,
        });
      } else if (ev === "on_tool_error") {
        onToolEvent({
          type: "tool",
          phase: "error",
          name,
          toolCallId,
          error: toolEvt.error,
        });
      }
    }
    return;
  }

  if (
    chunk.length >= 1 &&
    chunk[0] &&
    typeof chunk[0] === "object" &&
    "_getType" in chunk[0]
  ) {
    dispatchModelToken(chunk[0] as BaseMessage, onDelta);
  }
}

/**
 * 使用 LangChain `createAgent` + `ChatOllama`，按 ReAct 循环调用工具并流式回调。
 *
 * @param options.host / options.model — Ollama 连接参数
 * @param options.messages — 本轮输入消息
 * @param options.onDelta — 助手正文增量
 * @param options.onToolEvent — LangGraph 工具流结构化事件
 */
export async function runLangchainReactAgentStream(
  options: LangchainAgentStreamOptions,
): Promise<void> {
  const llm = new ChatOllama({
    baseUrl: options.host.replace(/\/$/, ""),
    model: options.model,
    temperature: 0.2,
  });

  const agent = createAgent({
    model: llm,
    tools: buildTools(),
    systemPrompt:
      "你是中文助手，可调用工具获取精确时间与算术结果；需要时使用工具，其余直接作答。",
  });

  const stream = await agent.stream(
    { messages: options.messages },
    {
      streamMode: ["messages", "tools"],
    },
  );

  for await (const chunk of stream) {
    handleStreamChunk(chunk, options.onDelta, options.onToolEvent);
  }
}
