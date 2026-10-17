// A picture (./reduce.ts) as the desktop's chat components draw it: the
// finished items as messages, in log order, and the open tail as the live
// stream. A pure function of the picture — the desktop, the popout and the
// box's own reads (the engine, the old routes) all project through here.
//
// One item is one message, except that consecutive tool calls share one (the
// "N tool calls" fold). So the screen shows exactly the log's order.
import type { Item, PendingInput, Todo } from "./protocol";
import { isOpen, openAsk, planOf, type Picture } from "./reduce";

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
  /** A voice line. */
  voice?: boolean;
};

export type ViewTool = { id: string; name: string; input: any; result?: string; startedAt?: number; inputChars?: number };

export type ChatView = {
  messages: ViewMessage[];
  /** The open tail: what streams now. */
  live: { text: string; reasoning: string; tools: ViewTool[]; items: string[] };
  running: boolean;
  /** Parked on a question to Carl. */
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

function askText(it: Item): string {
  const opts = it.options ?? [];
  return `**❓ ${it.question ?? ""}**${opts.length ? `\n\n${opts.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : ""}`;
}

/** One non-tool item → its message. */
function messageOf(it: Item): ViewMessage | null {
  switch (it.kind) {
    case "user":
      return {
        role: "user",
        content: it.text ?? "",
        mid: it.id,
        direct: true,
        ...(it.hidden ? { hidden: true } : {}),
        ...(it.via === "answer" ? { decision: true } : {}),
        ...(it.via === "voice" ? { voice: true } : {}),
        ...(it.images?.length ? { attachments: it.images.map((i) => ({ imageDataUrl: i.dataUrl ?? "", capturedFilePath: i.path })) } : {}),
      };
    case "assistant":
      return { role: "assistant", content: it.text ?? "", mid: it.id, ...(it.via === "voice" ? { voice: true } : {}) };
    case "thinking":
      return (it.text ?? "").trim() ? { role: "assistant", content: "", thinking: it.text, mid: it.id } : null;
    case "compaction":
      if (isOpen(it)) return { role: "assistant", system: true, content: "Summarizing the earlier conversation…", mid: it.id };
      return it.rollover
        ? { role: "assistant", system: true, content: DIVIDER_TEXT, mid: it.id, rollover: { recap: it.text ?? "", at: it.at } }
        : { role: "assistant", system: true, content: DIVIDER_TEXT, mid: it.id, compaction: { summary: it.text ?? "", at: it.at } };
    case "notice":
      return { role: "assistant", system: true, content: it.text ?? "", mid: it.id, ...(it.level === "error" ? { failed: true } : {}) };
    case "ask":
      return {
        role: "assistant",
        content: askText(it),
        mid: it.id,
        ...(it.options?.length ? { askOptions: it.options.map((o) => ({ answer: o, title: o, body: "" })) } : {}),
      };
    case "wake":
      return { role: "user", system: true, content: `${it.wake === "wake" || it.wake === "job" ? "⏰" : "↻"} ${it.text ?? ""}`.trim(), mid: it.id };
    case "plan":
    case "tool":
      return null;
  }
}

function toolCall(it: Item): NonNullable<ViewMessage["toolCalls"]>[number] {
  return {
    id: it.id,
    name: it.name ?? "tool",
    input: argsOf(it),
    ...(it.result !== undefined ? { result: it.result } : isOpen(it) ? {} : { result: it.status === "stopped" ? "(stopped)" : "" }),
    ...(it.subagents?.length ? { subagents: it.subagents } : {}),
  };
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
  while (j > 0 && items[j - 1]!.kind === "tool") j--;
  if (j < k && items.slice(j, k).some(isOpen)) k = j;
  return k;
}

type Cached = { deps: Item[]; msg: ViewMessage };

/** A projector that hands back the same message object for an item that did not change (React's memo keeps its row). */
export function makeChatView(): (p: Picture, opts?: { split?: boolean }) => ChatView {
  let cache = new Map<string, Cached>();
  return (p, opts = {}) => {
    const split = opts.split !== false;
    const items = p.items;
    const cut = split && p.turn ? liveStart(items) : items.length;
    const next = new Map<string, Cached>();
    const messages: ViewMessage[] = [];
    const use = (key: string, deps: Item[], make: () => ViewMessage | null) => {
      const hit = cache.get(key);
      if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) {
        next.set(key, hit);
        messages.push(hit.msg);
        return;
      }
      const msg = make();
      if (!msg) return;
      msg.items = deps.map((d) => d.id);
      next.set(key, { deps, msg });
      messages.push(msg);
    };
    for (let i = 0; i < cut; ) {
      const it = items[i]!;
      if (it.kind === "plan") {
        i++;
        continue;
      }
      if (it.kind === "tool") {
        const group: Item[] = [];
        while (i < cut && items[i]!.kind === "tool") group.push(items[i++]!);
        use(`t:${group[0]!.id}`, group, () => ({ role: "assistant", content: "", mid: group[0]!.id, toolCalls: group.map(toolCall) }));
        continue;
      }
      use(it.id, [it], () => messageOf(it));
      i++;
    }
    // Each turn's cost on its last reply (its last text, else its last step).
    if (Object.keys(p.turnCost).length) {
      const byId = new Map(items.map((x) => [x.id, x]));
      const lastOf = new Map<string, number>();
      const lastText = new Map<string, number>();
      messages.forEach((m, idx) => {
        if (m.role !== "assistant" || m.system) return;
        const it = byId.get(m.items?.[0] ?? "");
        if (!it?.turn) return;
        lastOf.set(it.turn, idx);
        if (m.content.trim()) lastText.set(it.turn, idx);
      });
      for (const [t, i] of lastText) lastOf.set(t, i);
      for (const [turn, idx] of lastOf) {
        const usd = p.turnCost[turn];
        if (typeof usd === "number" && messages[idx]!.costUsd !== usd) messages[idx] = { ...messages[idx]!, costUsd: usd };
      }
    }
    cache = next;
    const tail = items.slice(cut);
    const text = tail.filter((x) => x.kind === "assistant").map((x) => x.text ?? "").filter((s) => s.trim()).join("\n\n");
    const reasoning = tail.filter((x) => x.kind === "thinking").map((x) => x.text ?? "").filter((s) => s.trim()).join("\n\n");
    const tools: ViewTool[] = tail
      .filter((x) => x.kind === "tool")
      .map((x) => ({
        id: x.id,
        name: x.name ?? "tool",
        input: argsOf(x),
        ...(x.result !== undefined ? { result: x.result } : {}),
        startedAt: x.at,
        ...(x.args === undefined && x.argsText ? { inputChars: x.argsText.length } : {}),
      }));
    const ask = openAsk(p);
    return {
      messages,
      live: { text, reasoning, tools, items: tail.map((x) => x.id) },
      running: !!p.turn && !ask,
      waiting: !!ask,
      startedAt: p.turn?.startedAt ?? null,
      todos: planOf(p),
      pending: p.pending,
      context: p.usage?.context ?? null,
      window: p.usage?.window ?? null,
    };
  };
}

/** The transcript as messages (everything, nothing split off as live): the box's own reads. */
export function messagesOf(p: Picture): ViewMessage[] {
  return makeChatView()(p, { split: false }).messages;
}
