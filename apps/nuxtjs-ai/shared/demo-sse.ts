import * as z from "zod";

/** 模型正文增量 */
export const sseTokenSchema = z.object({
  type: z.literal("token"),
  message: z.string(),
});

/** 工具生命周期（与 LangGraph streamMode tools 对齐） */
export const sseToolSchema = z.object({
  type: z.literal("tool"),
  phase: z.enum(["start", "end", "error"]),
  name: z.string(),
  toolCallId: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
});

export const sseErrorSchema = z.object({
  type: z.literal("error"),
  code: z.number(),
  message: z.string(),
});

export const sseEndSchema = z.object({
  type: z.literal("end"),
});

/** /api/demo SSE 单行 data JSON 的联合类型 */
export const sseDemoPayloadSchema = z.union([
  sseTokenSchema,
  sseToolSchema,
  sseErrorSchema,
  sseEndSchema,
]);

export type SseDemoPayload = z.infer<typeof sseDemoPayloadSchema>;
export type SseToolPayload = z.infer<typeof sseToolSchema>;
