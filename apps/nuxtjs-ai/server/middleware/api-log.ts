import type { H3Event } from "h3";
import { getQuery, readBody } from "h3";

const MAX_LOG_CHARS = 4000;

function truncate(text: string, max = MAX_LOG_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

function serializeForLog(value: unknown): string {
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return truncate(String(value));
  }
}

export default defineEventHandler(async (event) => {
  const path = event.path;
  if (!path.startsWith("/api/")) return;

  const requestLog: Record<string, unknown> = {
    at: new Date().toISOString(),
    method: event.method,
    path,
    query: getQuery(event),
  };

  if (event.method !== "GET" && event.method !== "HEAD") {
    try {
      requestLog.body = await readBody(event);
    } catch (err) {
      requestLog.body = `[readBody failed: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }

  console.log("[api:request]", serializeForLog(requestLog));
  attachResponseLogger(event);
});

function attachResponseLogger(event: H3Event) {
  const res = event.node.res;
  const chunks: Buffer[] = [];
  let logged = false;

  const logResponse = () => {
    if (logged) return;
    logged = true;

    const status = res.statusCode;
    const contentType = String(res.getHeader("content-type") ?? "");
    const raw = Buffer.concat(chunks).toString("utf8");

    let body: string;
    if (contentType.includes("text/event-stream")) {
      body = `[SSE ${raw.length} bytes] ${truncate(raw.replace(/\r?\n/g, " "), 800)}`;
    } else if (!raw) {
      body = "(empty)";
    } else {
      body = truncate(raw);
    }

    console.log(
      "[api:response]",
      serializeForLog({
        at: new Date().toISOString(),
        path: event.path,
        status,
        contentType: contentType || undefined,
        body,
      }),
    );
  };

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = ((chunk: unknown, ...args: unknown[]) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return originalWrite(chunk as never, ...(args as never[]));
  }) as typeof res.write;

  res.end = ((chunk: unknown, ...args: unknown[]) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    logResponse();
    return originalEnd(chunk as never, ...(args as never[]));
  }) as typeof res.end;

  res.once("close", logResponse);
}
