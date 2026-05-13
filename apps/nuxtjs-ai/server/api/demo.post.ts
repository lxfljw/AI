import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { defineEventHandler, readBody, setResponseHeaders } from "h3";
import { runLangchainReactAgentStream } from "../utils/ollamaAgent";

function bodyToMessages(body: Record<string, unknown>): BaseMessage[] {
  const history = body.messages;
  if (Array.isArray(history) && history.length > 0) {
    return history.map((item) => {
      const row = item as Record<string, unknown>;
      const content = String(row.content ?? "");
      switch (row.role) {
        case "system":
          return new SystemMessage(content);
        case "assistant":
          return new AIMessage(content);
        default:
          return new HumanMessage(content);
      }
    });
  }
  const single =
    typeof body.message === "string"
      ? body.message
      : String(body.message ?? "");
  return [new HumanMessage(single)];
}

export default defineEventHandler(async (event) => {
  const raw = await readBody(event);
  const body =
    typeof raw === "string"
      ? (JSON.parse(raw) as Record<string, unknown>)
      : (raw as Record<string, unknown>);
  const messages = bodyToMessages(body ?? {});

  const config = useRuntimeConfig(event);
  const host = String(config.ollamaHost).trim();
  const model = String(config.ollamaModel).trim();

  setResponseHeaders(event, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (payload: object) => {
    event.node.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    await runLangchainReactAgentStream({
      host,
      model,
      messages,
      onDelta: (text) => {
        send({ type: "token", message: text });
      },
      onToolEvent: (evt) => {
        send(evt);
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    send({ type: "error", code: 500, message: msg });
  }

  send({ type: "end" });
  event.node.res.end();
});
