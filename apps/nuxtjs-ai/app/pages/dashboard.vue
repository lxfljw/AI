<script setup lang="ts">
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { sseDemoPayloadSchema } from "~~/shared/demo-sse";

type UserTurn = { role: "user"; content: string; awaitingReply?: boolean };

type AssistantSegment =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      phase: "start" | "end" | "error";
      name: string;
      toolCallId?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
    };

type AssistantTurn = { role: "assistant"; segments: AssistantSegment[] };

type ChatTurn = UserTurn | AssistantTurn;

const inputMessage = ref("");
const messages = ref<ChatTurn[]>([]);
const streamingSegments = ref<AssistantSegment[]>([]);
const streaming = ref(false);
/** 防止上一轮请求的 finally 误清理当前轮 UI */
const streamGeneration = ref(0);
const abortController = ref<AbortController | null>(null);
let sseTail = "";

function previewUnknown(u: unknown, max = 360): string {
  try {
    const s = JSON.stringify(u);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(u);
  }
}

function toolPhaseLabel(phase: "start" | "end" | "error"): string {
  switch (phase) {
    case "start":
      return "调用";
    case "end":
      return "返回";
    case "error":
      return "失败";
    default:
      return phase;
  }
}

function toolPhaseStyles(
  phase: "start" | "end" | "error",
): { bar: string; badge: string } {
  switch (phase) {
    case "start":
      return {
        bar: "border-blue-500/35 bg-blue-500/[0.06]",
        badge: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
      };
    case "end":
      return {
        bar: "border-emerald-500/35 bg-emerald-500/[0.06]",
        badge: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
      };
    case "error":
      return {
        bar: "border-destructive/40 bg-destructive/[0.06]",
        badge: "bg-destructive/15 text-destructive",
      };
    default:
      return {
        bar: "border-border bg-muted/40",
        badge: "bg-muted text-muted-foreground",
      };
  }
}

function appendStreamToken(text: string) {
  const segs = streamingSegments.value;
  const last = segs[segs.length - 1];
  if (last?.kind === "text") last.text += text;
  else segs.push({ kind: "text", text });
}

function appendStreamTool(evt: {
  phase: "start" | "end" | "error";
  name: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}) {
  streamingSegments.value.push({
    kind: "tool",
    phase: evt.phase,
    name: evt.name,
    toolCallId: evt.toolCallId,
    input: evt.input,
    output: evt.output,
    error: evt.error,
  });
}

function parseSseBlocks(chunk: string) {
  sseTail += chunk;
  const blocks = sseTail.split("\n\n");
  sseTail = blocks.pop() ?? "";
  for (const block of blocks) {
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const parsed = sseDemoPayloadSchema.safeParse(json);
      if (!parsed.success) continue;
      const d = parsed.data;
      if (d.type === "end") continue;
      if (d.type === "token") appendStreamToken(d.message);
      else if (d.type === "tool") appendStreamTool(d);
      else if (d.type === "error")
        appendStreamToken(`\n[服务端错误 ${d.code}] ${d.message}`);
    }
  }
}

function snapshotAssistantSegments(): AssistantSegment[] {
  return streamingSegments.value.map((seg) =>
    seg.kind === "text"
      ? { kind: "text", text: seg.text }
      : {
          kind: "tool",
          phase: seg.phase,
          name: seg.name,
          toolCallId: seg.toolCallId,
          input: seg.input,
          output: seg.output,
          error: seg.error,
        },
  );
}

function clearAwaitingOnLastUser() {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i];
    if (!m || m.role !== "user") continue;
    m.awaitingReply = false;
    break;
  }
}

async function sendMessage() {
  const text = inputMessage.value.trim();
  if (!text) return;

  streamGeneration.value += 1;
  const gen = streamGeneration.value;

  abortController.value?.abort();
  abortController.value = new AbortController();
  const signal = abortController.value.signal;

  for (const m of messages.value) {
    if (m.role !== "user") continue;
    m.awaitingReply = false;
  }

  messages.value.push({ role: "user", content: text, awaitingReply: true });
  inputMessage.value = "";
  streamingSegments.value = [];
  sseTail = "";
  streaming.value = true;

  const payloadMessages = messages.value.reduce<
    { role: "user" | "assistant" | "system"; content: string }[]
  >((acc, turn) => {
    if (turn.role === "user") {
      acc.push({ role: "user", content: turn.content });
      return acc;
    }
    const text = turn.segments
      .filter((s): s is { kind: "text"; text: string } => s.kind === "text")
      .map((s) => s.text)
      .join("");
    if (text.trim().length > 0)
      acc.push({ role: "assistant", content: text });
    return acc;
  }, []);

  try {
    const res = await fetch("/api/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: payloadMessages }),
      signal,
    });

    if (gen !== streamGeneration.value) return;

    const reader = res.body?.getReader();
    if (!reader) {
      messages.value.push({
        role: "assistant",
        segments: [{ kind: "text", text: "[无法读取响应流]" }],
      });
      clearAwaitingOnLastUser();
      return;
    }
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (gen !== streamGeneration.value) {
          await reader.cancel();
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        parseSseBlocks(decoder.decode(value, { stream: true }));
      }
      if (gen === streamGeneration.value) parseSseBlocks(decoder.decode());
    } finally {
      reader.releaseLock();
    }

    if (gen !== streamGeneration.value) return;

    const snapshot = snapshotAssistantSegments();
    if (snapshot.length > 0)
      messages.value.push({ role: "assistant", segments: snapshot });
    clearAwaitingOnLastUser();
  } catch (e) {
    if (gen !== streamGeneration.value) return;
    if (e instanceof DOMException && e.name === "AbortError") return;
    messages.value.push({
      role: "assistant",
      segments: [{ kind: "text", text: "[请求失败，请检查网络或 Ollama 服务]" }],
    });
    clearAwaitingOnLastUser();
  } finally {
    if (gen === streamGeneration.value) {
      streamingSegments.value = [];
      streaming.value = false;
      abortController.value = null;
      sseTail = "";
    }
  }
}
</script>

<template>
  <SidebarProvider>
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg">
              <div
                class="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"
              >
                <!-- <GalleryVerticalEnd class="size-4" /> -->
              </div>
              <div class="grid flex-1 text-left text-sm leading-tight">
                <span class="truncate font-semibold">Acme Inc</span>
                <span class="truncate text-xs">Enterprise pro</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton as-child>
                  <a href="#">
                    <span>Home</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter />
      <SidebarRail />
    </Sidebar>
    <SidebarInset class="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div
        class="flex min-h-[12rem] flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-muted/30 p-4 text-sm"
      >
        <template v-for="(m, i) in messages" :key="i">
          <div
            v-if="m.role === 'user'"
            class="ml-auto flex max-w-[85%] items-start gap-2 rounded-lg bg-primary px-3 py-2 text-primary-foreground"
          >
            <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{{ m.content }}</span>
            <span
              v-if="m.awaitingReply"
              class="mt-0.5 inline-flex size-4 shrink-0 animate-spin rounded-full border-2 border-primary-foreground/25 border-t-primary-foreground"
              aria-hidden="true"
            />
          </div>
          <div v-else class="mr-auto max-w-[90%] space-y-2">
            <template v-for="(seg, j) in m.segments" :key="j">
              <div
                v-if="seg.kind === 'tool'"
                class="overflow-hidden rounded-lg border-l-4 text-xs shadow-sm"
                :class="toolPhaseStyles(seg.phase).bar"
              >
                <div class="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span
                    class="rounded px-1.5 py-0.5 font-semibold"
                    :class="toolPhaseStyles(seg.phase).badge"
                  >
                    {{ toolPhaseLabel(seg.phase) }}
                  </span>
                  <code class="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px]">{{ seg.name }}</code>
                  <span v-if="seg.toolCallId" class="text-muted-foreground font-mono text-[10px]">{{ seg.toolCallId }}</span>
                </div>
                <pre
                  v-if="seg.phase === 'start' && seg.input !== undefined"
                  class="max-h-32 overflow-auto border-t border-border/60 bg-background/50 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap"
                >{{ previewUnknown(seg.input) }}</pre>
                <pre
                  v-else-if="seg.phase === 'end' && seg.output !== undefined"
                  class="max-h-32 overflow-auto border-t border-border/60 bg-background/50 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap"
                >{{ previewUnknown(seg.output) }}</pre>
                <pre
                  v-else-if="seg.phase === 'error'"
                  class="max-h-32 overflow-auto border-t border-destructive/25 bg-background/50 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-destructive"
                >{{ previewUnknown(seg.error) }}</pre>
              </div>
              <div
                v-else
                class="rounded-lg border border-border bg-background px-3 py-2 whitespace-pre-wrap break-words"
              >
                {{ seg.text }}
              </div>
            </template>
          </div>
        </template>

        <div
          v-if="streaming && streamingSegments.length > 0"
          class="mr-auto max-w-[90%] space-y-2"
        >
          <template v-for="(seg, j) in streamingSegments" :key="j">
            <div
              v-if="seg.kind === 'tool'"
              class="overflow-hidden rounded-lg border-l-4 text-xs shadow-sm"
              :class="toolPhaseStyles(seg.phase).bar"
            >
              <div class="flex flex-wrap items-center gap-2 px-3 py-2">
                <span
                  class="rounded px-1.5 py-0.5 font-semibold"
                  :class="toolPhaseStyles(seg.phase).badge"
                >
                  {{ toolPhaseLabel(seg.phase) }}
                </span>
                <code class="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px]">{{ seg.name }}</code>
              </div>
              <pre
                v-if="seg.phase === 'start' && seg.input !== undefined"
                class="max-h-32 overflow-auto border-t border-border/60 bg-background/50 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap"
              >{{ previewUnknown(seg.input) }}</pre>
              <pre
                v-else-if="seg.phase === 'end' && seg.output !== undefined"
                class="max-h-32 overflow-auto border-t border-border/60 bg-background/50 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap"
              >{{ previewUnknown(seg.output) }}</pre>
              <pre
                v-else-if="seg.phase === 'error'"
                class="max-h-32 overflow-auto border-t border-destructive/25 bg-background/50 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-destructive"
              >{{ previewUnknown(seg.error) }}</pre>
            </div>
            <div
              v-else
              class="rounded-lg border border-border bg-background px-3 py-2 whitespace-pre-wrap break-words"
            >
              {{ seg.text }}
            </div>
          </template>
          <span
            class="inline-block h-3.5 w-1.5 animate-pulse bg-foreground/70 align-text-bottom"
          />
        </div>
      </div>

      <div class="flex shrink-0 flex-col gap-2">
        <textarea
          v-model="inputMessage"
          rows="3"
          placeholder="输入消息，发送后与本地模型对话…（生成中再次发送会打断当前回答）"
          class="placeholder:text-muted-foreground border-input w-full min-h-[5rem] resize-y rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none md:text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          @keydown.enter.exact.prevent="sendMessage"
        />
        <Button
          type="button"
          :disabled="!inputMessage.trim()"
          @click="sendMessage"
        >
          {{ streaming ? "发送（打断当前）" : "发送" }}
        </Button>
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
