// What a thread shows beside the text on the phone: the model's thinking, a
// reply's cost, the summarized-earlier divider (compaction / roll-over), the
// subagents a turn spawned, the to-do list and the Done verdict. HTML strings
// in the page's own vocabulary (the "N steps" pill, the option cards, the quiet
// system line). The presentation choices Carl has open are the laptop's
// localStorage switches (src/uiChoices.ts), read here under the same keys.

const CHOICES = {
  thinking: ["vc_ui_thinking", "line", "toggle"],
  subagents: ["vc_ui_subagents", "inline", "strip"],
  cost: ["vc_ui_cost", "reply", "total"],
  todos: ["vc_ui_todos", "inline", "pinned"],
  verdict: ["vc_ui_verdict", "thread", "ongoing"],
} as const;
type ChoiceName = keyof typeof CHOICES;

const memo = new Map<string, string>();
export function choice(c: ChoiceName): string {
  if (memo.has(c)) return memo.get(c)!;
  const [key, a, b] = CHOICES[c];
  let v: string | null = null;
  try {
    v = localStorage.getItem(key);
  } catch {
    v = null;
  }
  const out = v === b ? b : a;
  memo.set(c, out);
  return out;
}

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CHEV = '<svg class="xcv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';

export function fmtCost(usd: unknown): string {
  return typeof usd === "number" && usd > 0 ? (usd < 0.01 ? "<$0.01" : "$" + usd.toFixed(2)) : "";
}

/** The reply's thinking: a collapsed "Thought" pill ("line"), or hidden until
 *  the header's toggle shows it ("toggle": body.show-thinking). */
export function thoughtHtml(text: string | undefined): string {
  if (!text || !String(text).trim()) return "";
  if (choice("thinking") === "toggle") return '<div class="thought-x" data-el="thinking">' + esc(text) + "</div>";
  return '<div class="xblk thought" data-el="thinking"><button class="xh">Thought' + CHEV + '</button><div class="xbody">' + esc(text) + "</div></div>";
}

export function costHtml(usd: unknown): string {
  const c = fmtCost(usd);
  return c && choice("cost") === "reply" ? '<div class="rcost" data-el="reply-cost">' + c + "</div>" : "";
}

/** "Earlier conversation summarized", tap to read the summary. `body` is the summary's html. */
export function dividerHtml(bodyHtml: string): string {
  return '<div class="xblk pdiv" data-el="divider"><button class="xh"><span class="pl"></span>Earlier conversation summarized' + CHEV + '<span class="pl"></span></button><div class="xbody md">' + bodyHtml + "</div></div>";
}

export type PhoneSubagent = { threadId: string; task?: string; agent?: string; model?: string; state?: string; costUsd?: number; summary?: string; toolCallId?: string };

export function subagentsHtml(list: PhoneSubagent[], variant: "inline" | "strip"): string {
  if (!list.length) return "";
  const running = list.filter((s) => (s.state ?? "running") === "running").length;
  const rows = list
    .map((s) => {
      const st = s.state ?? "running";
      const on = st === "running";
      const meta = [on ? "running" : st, (s.model ?? "").split("/").pop(), fmtCost(s.costUsd)].filter(Boolean).join(" · ");
      return (
        '<div class="sa" data-el="subagent" data-sid="' + esc(s.threadId) + '" data-state="' + esc(st) + '">' +
        '<div class="sa-h"><span class="sd ' + (on ? "run" : st === "completed" ? "ok" : "bad") + '"></span><span class="sa-t">' + esc(s.task ?? "subagent") + "</span></div>" +
        '<div class="sa-m">' + esc(meta) + (on ? '<button class="sa-b" data-op="steer">Steer</button><button class="sa-b" data-op="stop">Stop</button>' : "") + "</div>" +
        (!on && s.summary ? '<div class="sa-s" data-el="subagent-summary">' + esc(s.summary) + "</div>" : "") +
        "</div>"
      );
    })
    .join("");
  return '<div class="pcard sas ' + variant + '" data-el="subagents" data-variant="' + variant + '"><div class="pc-h"><span>Subagents</span><span>' + (running ? running + " running" : list.length + " done") + "</span></div>" + rows + "</div>";
}

export type PhoneTodo = { content: string; status: string; activeForm?: string };

export function todosHtml(todos: PhoneTodo[]): string {
  if (!todos?.length) return "";
  const done = todos.filter((t) => t.status === "completed").length;
  const rows = todos
    .map((t) => '<div class="td ' + esc(t.status) + '"><span class="tdd"></span><span>' + esc(t.status === "in_progress" && t.activeForm ? t.activeForm : t.content) + "</span></div>")
    .join("");
  return '<div class="pcard todos" data-el="todos"><div class="pc-h"><span>Plan</span><span>' + done + "/" + todos.length + "</span></div>" + rows + "</div>";
}

export type PhoneVerdict = { verdict: string; notes?: string[] };

export function verdictLabel(v: PhoneVerdict): string {
  const word = v.verdict === "pass" ? "passed" : v.verdict === "fail" ? "failed" : "unsure";
  const note = (v.notes ?? []).find((n) => n && n.trim());
  return "Done · verifier " + word + (note ? " — " + note.trim() : "");
}

/** The Done verdict as the thread's last line ("thread" option). */
export function verdictHtml(v: PhoneVerdict | undefined, state: string | undefined): string {
  if (!v || state !== "done" || choice("verdict") !== "thread") return "";
  return '<div class="pverdict ' + esc(v.verdict) + '" data-el="verdict" data-verdict="' + esc(v.verdict) + '"><span class="od ' + (v.verdict === "pass" ? "done" : v.verdict === "fail" ? "blocked" : "waiting") + '"></span><span>' + esc(verdictLabel(v)) + "</span></div>";
}

/** The box writes an AskUser's options into the text too ("1. …\n2. …"); where
 *  they are drawn as cards, that list goes. */
export function withoutOptionList(content: string, options: { answer: string }[]): string {
  const list = options.map((o, i) => `${i + 1}. ${o.answer}`).join("\n");
  return content.endsWith(list) ? content.slice(0, -list.length).trimEnd() : content;
}

/** The subagents of one reply (by the child ids its `subagent` call carries). */
export function spawnsOf(spawns: string[] | undefined, all: PhoneSubagent[]): PhoneSubagent[] {
  if (!spawns?.length) return [];
  const ids = new Set(spawns);
  return all.filter((s) => ids.has(s.threadId));
}

/** A runtime event onto the live text (src/streamWire.ts's applyStream: the
 *  box sends the reply's growth as offset + delta, with whole-text keyframes). */
export type StreamState = { text: string; whole: boolean };
export function applyStream(cur: StreamState | null | undefined, ev: { text?: unknown; offset?: unknown; delta?: unknown; len?: unknown }): StreamState {
  const tail = typeof ev.text === "string" ? ev.text : "";
  if (typeof ev.offset !== "number" || typeof ev.delta !== "string") return { text: tail, whole: false };
  if (ev.offset === 0) return { text: ev.delta, whole: true };
  if (cur?.whole && cur.text.length >= ev.offset) return { text: cur.text.slice(0, ev.offset) + ev.delta, whole: true };
  return { text: tail, whole: typeof ev.len === "number" && tail.length >= ev.len };
}
