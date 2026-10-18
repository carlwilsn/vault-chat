// A picture (./reduce.ts) as the desktop's chat components draw it: what pi
// wrote, as messages, in its order, and the open tail as the live stream. A
// pure function of the picture — the desktop, the popout and the box's own
// reads (the engine, the old routes) all project through here.
//
// One item is one message, except that consecutive tool calls share one (the
// "N tool calls" fold). So the screen shows exactly the log's order.
import type { PendingInput, Todo } from "./protocol";
import { isOpen, pendingOf, planOf, shown, type Item, type Picture } from "./reduce";

export const DIVIDER_TEXT = "Earlier conversation summarized";

/** The subset of src/store.ts ChatMessage this projection fills (structurally compatible). */
export type ViewMessage = {
  role: "user" | "assistant";
  content: string;
  mid?: string;
  system?: boolean;
  hidden?: boolean;
  direct?: boolean;
  decision?: boolean;
  failed?: boolean;
  thinking?: string;
  costUsd?: number;
  toolCalls?: { id?: string; name: string; input: any; result?: string; subagents?: string[] }[];
  attachments?: { imageDataUrl: string; capturedFilePath?: string; sourcePath?: string }[];
  askOptions?: { answer: string; title: string; body: string }[];
  compaction?: { summary: string; at?: number };
  rollover?: { at?: number; recap?: string };
  /** The items this message shows (in order). */
  items?: string[];
  voice?: boolean;
};

export type ViewTool = { id: string; name: string; input: any; result?: string; startedAt?: number; inputChars?: number };

export type ChatView = {
  messages: ViewMessage[];
  /** The open tail: what streams now. */
  live: { text: string; reasoning: string; tools: ViewTool[]; items: string[] };
  running: boolean;
  /** Waiting on Carl's answer to a question. */
  waiting: boolean;
  startedAt: number | null;
  todos: Todo[] | null;
  pending: PendingInput[];
  context: number | null;
  window: number | null;
};

/** What a tool call is about while its arguments still stream (path, command…), parsed as far as it goes. */
export function argsOf(it: Item): any {
  if (it.args !== undefined) return it.args;
  const raw = it.argsText ?? "";
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const out: Record<string, string> = {};
    for (const k of ["path", "file_path", "command", "pattern", "url"]) {
      const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(raw);
      if (m) out[k] = m[1]!.replace(/\\n/g, "\n").replace(/\\"/g, '"').slice(0, 300);
    }
    return out;
  }
}

/** pi's tool names → the names the clients' renderers know. */
const TOOL_NAMES: Record<string, string> = { bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", find: "Glob", ls: "LS" };
export const toolName = (n: string | undefined): string => TOOL_NAMES[n ?? ""] ?? (n || "tool");

const ENGINE_VIA = new Set(["wake", "nudge", "resume", "job"]);

/** One non-tool item → its message(s). */
function messagesOfItem(it: Item): ViewMessage[] {
  switch (it.kind) {
    case "user":
      if (ENGINE_VIA.has(it.via ?? "")) return [{ role: "user", system: true, content: `${it.via === "wake" || it.via === "job" ? "⏰" : "↻"} ${it.text ?? ""}`.trim(), mid: it.id }];
      return [
        {
          role: "user",
          content: it.text ?? "",
          mid: it.id,
          direct: true,
          ...(it.via === "answer" ? { decision: true } : {}),
          ...(it.via === "voice" ? { voice: true } : {}),
          ...(it.images?.length ? { attachments: it.images.map((i) => ({ imageDataUrl: i.dataUrl ?? "", capturedFilePath: i.path })) } : {}),
        },
      ];
    case "assistant":
      return [{ role: "assistant", content: it.text ?? "", mid: it.id, ...(it.via === "voice" ? { voice: true } : {}) }];
    case "thinking":
      return (it.text ?? "").trim() ? [{ role: "assistant", content: "", thinking: it.text, mid: it.id }] : [];
    case "compaction":
      if (isOpen(it)) return [{ role: "assistant", system: true, content: "Summarizing the earlier conversation…", mid: it.id }];
      return it.rollover
        ? [{ role: "assistant", system: true, content: DIVIDER_TEXT, mid: it.id, rollover: { recap: it.text ?? "", at: it.at } }]
        : [{ role: "assistant", system: true, content: DIVIDER_TEXT, mid: it.id, compaction: { summary: it.text ?? "", at: it.at } }];
    case "notice":
      return [{ role: "assistant", system: true, content: it.text ?? "", mid: it.id, ...(it.level === "error" ? { failed: true } : {}) }];
    case "tool":
      return [];
  }
}

/** AskUser: the question (its options as cards); Carl's answer is his own line after it (the reducer's). */
function askMessages(it: Item): ViewMessage[] {
  const a = argsOf(it);
  const options: string[] = Array.isArray(a?.options) ? a.options.map(String) : [];
  const q: ViewMessage = {
    role: "assistant",
    content: `**❓ ${String(a?.question ?? "")}**${options.length ? `\n\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : ""}`,
    mid: it.id,
    ...(options.length ? { askOptions: options.map((o) => ({ answer: o, title: o, body: "" })) } : {}),
  };
  return [q];
}

/** Where the live tail starts: trailing streaming text/thinking, or a trailing run of tool calls of which one is still open. */
export function liveStart(items: Item[]): number {
  let k = items.length;
  while (k > 0) {
    const it = items[k - 1]!;
    if ((it.kind === "assistant" || it.kind === "thinking") && it.status === "streaming") k--;
    else break;
  }
  let j = k;
  while (j > 0 && items[j - 1]!.kind === "tool" && items[j - 1]!.name !== "AskUser") j--;
  if (j < k && items.slice(j, k).some(isOpen)) k = j;
  return k;
}

type Cached = { deps: Item[]; extra: string; msgs: ViewMessage[] };

/** A projector that hands back the same message objects for items that did not change (React's memo keeps their rows). */
export function makeChatView(): (p: Picture, opts?: { split?: boolean }) => ChatView {
  let cache = new Map<string, Cached>();
  return (p, opts = {}) => {
    const split = opts.split !== false;
    const items = shown(p).filter((x) => !(x.kind === "assistant" && !(x.text ?? "").trim() && x.status !== "streaming"));
    const cut = split && p.meta.running ? liveStart(items) : items.length;
    const subs = (p.meta.subagents ?? []) as { threadId: string; toolCallId?: string }[];
    const spawnsOf = (id: string) => subs.filter((s) => s.toolCallId === id).map((s) => s.threadId);
    const next = new Map<string, Cached>();
    const messages: ViewMessage[] = [];
    const use = (key: string, deps: Item[], extra: string, make: () => ViewMessage[]) => {
      const hit = cache.get(key);
      if (hit && hit.extra === extra && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) {
        next.set(key, hit);
        messages.push(...hit.msgs);
        return;
      }
      const msgs = make();
      for (const m of msgs) m.items = deps.map((d) => d.id);
      next.set(key, { deps, extra, msgs });
      messages.push(...msgs);
    };
    for (let i = 0; i < cut; ) {
      const it = items[i]!;
      if (it.kind === "tool") {
        const group: Item[] = [];
        while (i < cut && items[i]!.kind === "tool") {
          group.push(items[i++]!);
          if (group[group.length - 1]!.name === "AskUser") break;
        }
        const extra = group.map((t) => spawnsOf(t.id).join(",")).join("|");
        use(`t:${group[0]!.id}`, group, extra, () => [
          {
            role: "assistant",
            content: "",
            mid: group[0]!.id,
            toolCalls: group.map((t) => {
              const sp = spawnsOf(t.id);
              return {
                id: t.id,
                name: toolName(t.name),
                input: argsOf(t),
                ...(t.result !== undefined ? { result: t.result } : isOpen(t) ? {} : { result: t.status === "stopped" ? "(stopped)" : "" }),
                ...(sp.length ? { subagents: sp } : {}),
              };
            }),
          },
        ]);
        // A question: its card after the call (Carl's answer is his own line after that).
        const last = group[group.length - 1]!;
        if (last.name === "AskUser") use(`ask:${last.id}`, [last], "", () => askMessages(last));
        continue;
      }
      use(it.id, [it], "", () => messagesOfItem(it));
      i++;
    }
    cache = next;
    const tail = items.slice(cut);
    const text = tail.filter((x) => x.kind === "assistant").map((x) => x.text ?? "").filter((s) => s.trim()).join("\n\n");
    const reasoning = tail.filter((x) => x.kind === "thinking").map((x) => x.text ?? "").filter((s) => s.trim()).join("\n\n");
    const tools: ViewTool[] = tail
      .filter((x) => x.kind === "tool")
      .map((x) => ({
        id: x.id,
        name: toolName(x.name),
        input: argsOf(x),
        ...(x.result !== undefined ? { result: x.result } : {}),
        startedAt: x.at,
        ...(x.args === undefined && x.argsText ? { inputChars: x.argsText.length } : {}),
      }));
    const asking = !!p.meta.asking;
    return {
      messages,
      live: { text, reasoning, tools, items: tail.map((x) => x.id) },
      running: !!p.meta.running && !asking,
      waiting: asking,
      startedAt: p.meta.running?.startedAt ?? null,
      todos: planOf(p),
      pending: pendingOf(p),
      context: p.usage?.context ?? null,
      window: typeof p.meta.contextWindow === "number" ? p.meta.contextWindow : null,
    };
  };
}

/** The transcript as messages (everything, nothing split off as live): the box's own reads. */
export function messagesOf(p: Picture): ViewMessage[] {
  return makeChatView()(p, { split: false }).messages;
}
