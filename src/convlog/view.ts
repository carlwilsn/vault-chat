// A picture (./reduce.ts) as the desktop's chat components draw it: what pi
// wrote, as messages, in its order, and the open tail as the live stream. A
// pure function of the picture — the desktop, the popout and the box's own
// reads (the engine, the old routes) all project through here.
//
// One item is one message, except that consecutive tool calls share one (the
// "N tool calls" fold). So the screen shows exactly the log's order.
import type { PendingInput, Todo } from "./protocol";
import { isOpen, pendingOf, planOf, shown, type Item, type Picture } from "./reduce";
import { ASK_TOOLS, REVIEW_TOOL, reviewCard } from "../review";
import { hostToolName } from "../mcpNames";

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
  askOptions?: { answer: string; title: string; body: string; primary?: boolean }[];
  compaction?: { summary: string; at?: number };
  rollover?: { at?: number; recap?: string };
  /** The items this message shows (in order). */
  items?: string[];
  voice?: boolean;
  /** A background job that ended (StartJob's wake): one quiet row, its last output lines folded under it. */
  job?: JobEnd;
  /** A voice Ask (server/voice.ts, a background side request): one collapsed row. */
  voiceAsk?: { request: string; result: string; failed: boolean; act?: boolean };
  /** The failed line of the turn that ended on it, the last thing in the chat: offers Try again (RETRY_TEXT). */
  retry?: boolean;
};

/** What Try again sends (a "send" intent with via "retry"): shown as a quiet system line, not as Carl's words. */
export const RETRY_TEXT = "Try again: the last reply failed before it finished. Continue from where you were.";

/** A failed request a turn ended on (reduce.ts blocksOf's `<ts>:-1` line, closed). */
const isTurnFailure = (it: Item) => it.kind === "notice" && it.level === "error" && it.id.endsWith(":-1") && !isOpen(it);

export type ViewTool = { id: string; name: string; input: any; result?: string; partial?: string; startedAt?: number; inputChars?: number };

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
export const toolName = (n: string | undefined): string => TOOL_NAMES[hostToolName(n)] ?? (hostToolName(n) || "tool");

const ENGINE_VIA = new Set(["wake", "nudge", "resume", "job", "delegate"]);

export type JobEnd = { id: string; name: string; status: string; failed: boolean; output: string; task?: boolean };

/** A background worker's report turn (Delegate, server/engine/engine.ts reportWhenDone): "Delegated work <how>: "<title>"".
 *  Its row says which task ended and how; the report itself is the agent's to tell (its next message), never shown raw. */
export function taskEndOf(text: string): JobEnd | null {
  const m = /^Delegated work (finished|failed(?: \(([^)]*)\))?): "([^"\n]*)"/.exec(text.trim());
  if (!m) return null;
  const failed = m[1] !== "finished";
  const why = m[2] ?? "";
  const status = !failed ? "finished" : why === "stopped" ? "stopped" : why === "killed" ? "lost in a restart" : why === "timeout" ? "timed out" : "failed";
  return { id: m[3]!, name: m[3]!, status, failed: failed && why !== "stopped", output: "", task: true };
}

/** The wake a job's end gives its conversation (server/engine/engine.ts tickJobs): "Job <id> <how>." then its last output. */
export function jobEndOf(text: string): JobEnd | null {
  const m = /^Job (\S+) (finished: exit (-?\d+)|was stopped by its time limit|was stopped|ended without an exit code[^\n]*?)\.\s*(?:\n--- last output ---\n([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const id = m[1]!;
  const exit = m[3] !== undefined ? Number(m[3]) : null;
  const how = m[2]!;
  const status = exit !== null ? (exit === 0 ? "finished" : `failed (exit ${exit})`) : /time limit/.test(how) ? "timed out" : /^was stopped/.test(how) ? "stopped" : "ended without an exit code";
  const failed = exit !== null ? exit !== 0 : !/^was stopped$/.test(how);
  // StartJob's id is its name, slugged, then 8 random characters.
  const name = id.replace(/-[a-z0-9]{8}$/, "").replace(/[-_]+/g, " ").trim() || id;
  const out = (m[4] ?? "").replace(/\s+$/, "");
  const output = out && out !== "(none)" ? out.split("\n").slice(-8).join("\n") : "";
  return { id, name, status, failed, output };
}

/** One non-tool item → its message(s). `retry`: the turn that ended on this failure is the last thing here (Try again). */
function messagesOfItem(it: Item, retry = false): ViewMessage[] {
  switch (it.kind) {
    case "user":
      if (it.via === "job") {
        const job = jobEndOf(it.text ?? "");
        if (job) return [{ role: "user", system: true, content: `Job ${job.status} · ${job.name}`, mid: it.id, job }];
      }
      if (it.via === "delegate") {
        const job = taskEndOf(it.text ?? "");
        if (job) return [{ role: "user", system: true, content: `Background task ${job.status} · ${job.name}`, mid: it.id, job }];
      }
      // Try again on a failed turn: a quiet line, not Carl's words (the agent gets RETRY_TEXT).
      if (it.via === "retry") return [{ role: "user", system: true, content: "↻ Trying again", mid: it.id }];
      if (ENGINE_VIA.has(it.via ?? "")) return [{ role: "user", system: true, content: `${it.via === "wake" || it.via === "job" || it.via === "delegate" ? "⏰" : "↻"} ${it.text ?? ""}`.trim(), mid: it.id }];
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
      // A failed request pi may still retry (reduce.ts blocksOf): not shown; the quiet "Retrying…" line says it.
      if (it.level === "error" && isOpen(it)) return [];
      return [{ role: "assistant", system: true, content: it.text ?? "", mid: it.id, ...(it.level === "error" ? { failed: true } : {}), ...(retry ? { retry: true } : {}) }];
    case "tool":
      return [];
  }
}

/** The name of voice's background Ask row (server/voice.ts runAsk). */
export const VOICE_ASK = "VoiceAsk";

function voiceAskMessage(it: Item): ViewMessage {
  const a = argsOf(it);
  const result = String(it.result ?? "");
  return {
    role: "assistant",
    content: "",
    mid: it.id,
    voiceAsk: {
      request: String(a?.request ?? ""),
      result: result.replace(/^Error:\s*/, ""),
      failed: it.status === "error" || /^error/i.test(result),
      ...(a?.act ? { act: true } : {}),
      ...(Array.isArray(a?.tools) ? { tools: (a.tools as unknown[]).map(String) } : {}),
      ...(typeof a?.ms === "number" ? { ms: a.ms } : {}),
      // Still working: its row shows that (a spinner, the time it has run) until the result lands in place.
      ...(it.status === "pending" ? { running: true, startedAt: typeof a?.startedAt === "number" ? a.startedAt : it.at } : {}),
    },
  };
}

/** AskUser: the question (its options as cards); Carl's answer is his own line after it (the reducer's).
 *  ReadyForReview (src/review.ts): the proof card, with Keep and Send back. */
function askMessages(it: Item): ViewMessage[] {
  const a = argsOf(it);
  if (it.name === REVIEW_TOOL) {
    const card = reviewCard(it.id, a);
    return [{ role: "assistant", content: card.content, mid: it.id, askOptions: card.options }];
  }
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
  while (j > 0 && items[j - 1]!.kind === "tool" && !ASK_TOOLS.has(String(items[j - 1]!.name)) && items[j - 1]!.name !== VOICE_ASK) j--;
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
      // Voice's background Ask: its own row, never one of the agent's tool calls.
      if (it.kind === "tool" && it.name === VOICE_ASK) {
        use(it.id, [it], "", () => [voiceAskMessage(it)]);
        i++;
        continue;
      }
      if (it.kind === "tool") {
        const group: Item[] = [];
        while (i < cut && items[i]!.kind === "tool" && items[i]!.name !== VOICE_ASK) {
          group.push(items[i++]!);
          if (ASK_TOOLS.has(String(group[group.length - 1]!.name))) break;
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
        if (ASK_TOOLS.has(String(last.name))) use(`ask:${last.id}`, [last], "", () => askMessages(last));
        continue;
      }
      // A turn that ended on a failed request, and nothing since: its line offers Try again.
      const retry = isTurnFailure(it) && i === items.length - 1 && !p.meta.running;
      use(it.id, [it], retry ? "retry" : "", () => messagesOfItem(it, retry));
      i++;
    }
    cache = next;
    const tail = items.slice(cut);
    const text = tail.filter((x) => x.kind === "assistant").map((x) => x.text ?? "").filter((s) => s.trim()).join("\n\n");
    const reasoning = tail.filter((x) => x.kind === "thinking").map((x) => x.text ?? "").filter((s) => s.trim()).join("\n\n");
    const tools: ViewTool[] = tail
      .filter((x) => x.kind === "tool" && x.name !== VOICE_ASK)
      .map((x) => ({
        id: x.id,
        name: toolName(x.name),
        input: argsOf(x),
        ...(x.result !== undefined ? { result: x.result } : {}),
        ...(isOpen(x) && x.partial ? { partial: x.partial } : {}),
        startedAt: x.at,
        ...(x.args === undefined && x.argsText ? { inputChars: x.argsText.length } : {}),
      }));
    const asking = !!p.meta.asking;
    return {
      messages,
      live: { text, reasoning, tools, items: tail.map((x) => x.id) },
      running: !!p.meta.running && !asking && !p.meta.clearing,
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

/** Clear is per surface (Carl, 2026-10-23): each device keeps the id of the last message it showed when he cleared. */
/** The messages after this surface's Clear (its last shown message's id, or one of the items a message shows); all of them when the mark is not there. */
export function afterClear<T extends { mid?: string; items?: string[] }>(messages: T[], mark: string | undefined): T[] {
  if (!mark) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.mid === mark || m.items?.includes(mark)) return messages.slice(i + 1);
  }
  return messages;
}
