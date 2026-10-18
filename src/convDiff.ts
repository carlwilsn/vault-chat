// Conversation-state diffs → the phone's /poll events (message / title / meta /
// status / runtime). The headless app's store drives one (src/phoneApp.ts); the
// box keeps one more per extra vault (server/engine/convs.ts), whose events
// carry that vault's name.
import type { ChatMessage, ConvRuntime } from "./store";
import type { Conversation } from "./conversations";
import { StreamWire } from "./streamWire";

const MSG_CAP = 20_000;
const REASONING_TAIL = 2_000;

/** What a live tool line names beside the tool ("Write dog.svg"): its path, command, pattern or url — never its content. */
export function toolArg(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  for (const k of ["path", "file_path", "command", "pattern", "url"]) {
    const v = (input as any)[k];
    if (typeof v === "string" && v) return v.split("\n")[0]!.slice(0, 200);
  }
  return "";
}

/** The slice of the store a diff reads. The foreground fields exist only in the app's store. */
export type DiffState = {
  conversations: Conversation[];
  convRuntime: Record<string, ConvRuntime>;
  busy?: boolean;
  activeConversationId?: string | null;
  streamingText?: string;
  liveTools?: { name: string }[];
  busyStartedAt?: number | null;
};

type ConvSnap = { status: string; msgCount: number; title: string; meta: string };

/** The meta a client shows beside the thread (state, wake, cost, verdict, the
 *  to-do list, subagents): a change sends one `meta` event so it re-reads them. */
function metaSig(c: Conversation): string {
  return JSON.stringify([c.state ?? "", c.nextWakeAt ?? 0, c.costUsd ?? 0, c.verdict ?? null, c.todos ?? null, c.subagents ?? null, c.working ?? false]);
}

function toolNames(m: ChatMessage): string[] {
  return (m.toolCalls ?? []).map((t) => t.name);
}

/** What a live message event carries beyond the text, like the phone's
 *  /conversation detail (server/phoneData.ts phoneExtras). */
function liveExtras(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (m.thinking?.trim()) out.thinking = m.thinking.slice(0, 8_000);
  const cost = m.costUsd ?? m.usage?.costUsd;
  if (typeof cost === "number") out.costUsd = cost;
  const summary = m.compaction?.summary ?? m.rollover?.recap;
  if (m.system && typeof summary === "string") out.divider = summary.slice(0, 12_000);
  const spawns = (m.toolCalls ?? []).flatMap((t) => t.subagents ?? []);
  if (spawns.length) out.spawns = spawns;
  const imgs = (m.attachments ?? []).map((a) => a.capturedFilePath ?? a.sourcePath).filter((x): x is string => !!x);
  if (imgs.length) out.images = imgs;
  return out;
}

/** A diff over `get()`: each call broadcasts what changed since the last. The first call only seeds. */
export function makeConvDiff(
  get: () => DiffState,
  broadcast: (ev: Record<string, unknown>) => void,
  onRunEnded?: (convId: string) => void,
): () => void {
  let snaps = new Map<string, ConvSnap>();
  const lastStreamSent = new Map<string, string>();
  const wire = new StreamWire();
  return () => {
    const s = get();
    const next = new Map<string, ConvSnap>();
    for (const c of s.conversations) {
      const prev = snaps.get(c.id);
      const visible = c.messages.filter((m) => !m.hidden);
      const meta = metaSig(c);
      next.set(c.id, { status: c.status, msgCount: visible.length, title: c.title, meta });
      if (!prev) continue; // newly-seen conv: list view refreshes via status events
      // New finalized messages.
      if (visible.length > prev.msgCount) {
        for (const m of visible.slice(prev.msgCount)) {
          broadcast({
            type: "message",
            convId: c.id,
            role: m.role,
            // Its identity: a client shows the event's copy at once and puts the
            // stored one in its place by this id.
            ...(m.mid ? { mid: m.mid } : {}),
            content: (m.content ?? "").slice(0, MSG_CAP),
            tools: toolNames(m).filter((n, i) => !(n === "Subagent" && String(m.toolCalls?.[i]?.id ?? "").startsWith("sub-"))),
            // [unified ask] Inline option cards ride the live message event too,
            // so a presence-gated ask renders its tappable cards the moment the
            // reply lands — not only on a thread reopen.
            ...(m.askOptions && m.askOptions.length ? { askOptions: m.askOptions } : {}),
            ...(m.decision ? { decision: true } : {}),
            ...(m.system ? { system: true } : {}),
            ...liveExtras(m),
          });
        }
      }
      if (c.title !== prev.title) {
        broadcast({ type: "title", convId: c.id, title: c.title });
      }
      if (meta !== prev.meta) broadcast({ type: "meta", convId: c.id });
      // Status transitions.
      if (c.status !== prev.status) {
        broadcast({ type: "status", convId: c.id, status: c.status });
        if (prev.status === "running" && c.status === "idle") {
          lastStreamSent.delete(c.id);
          wire.reset(c.id);
          onRunEnded?.(c.id);
        }
      }
    }
    snaps = next;

    // Streaming progress: background runs mirror into convRuntime; the
    // foreground run streams into the global view for the active conversation.
    // Keyed on text AND current tool — a worker grinding through tool calls
    // with no prose yet must still show signs of life on the phone (the old
    // text-only gate left its thread a silent "running…" for minutes).
    // Per-conversation run-start, so the phone can render an elapsed clock that
    // counts from when the prompt was sent — the same start the desktop uses,
    // continuous across leave/return.
    const startedAtById = new Map(s.conversations.map((c) => [c.id, c.runStartedAt]));
    // The whole text travels in pieces (offset + delta, keyframes): a long reply
    // never loses its start (src/streamWire.ts). The thinking rides as a short
    // tail (a live preview; the finished turn keeps all of it), and the live
    // context size with the model's window, for the dial.
    for (const [id, rt] of Object.entries(s.convRuntime)) {
      const full = rt.streamingText ?? "";
      const reasoning = (rt.streamingReasoning ?? "").slice(-REASONING_TAIL);
      const lastTool = rt.liveTools?.length ? rt.liveTools[rt.liveTools.length - 1]! : null;
      const tool = lastTool?.name ?? "";
      const arg = lastTool ? toolArg(lastTool.input) : "";
      // The live thought-by-thought timeline for this run - the phone renders it
      // as a growing list so a thread opened mid-run shows it working step by step.
      const steps = (rt.liveSteps ?? []).slice(-40);
      const lastAction = steps.length ? steps[steps.length - 1]!.action : "";
      const sig = [tool, arg, full.length, full.slice(-200), reasoning.length, reasoning.slice(-80), steps.length, lastAction, rt.lastContext ?? 0].join("|");
      if ((full || reasoning || tool || steps.length) && lastStreamSent.get(id) !== sig) {
        lastStreamSent.set(id, sig);
        broadcast({
          type: "runtime",
          convId: id,
          ...wire.next(id, full),
          tool,
          ...(arg ? { toolArg: arg } : {}),
          steps,
          ...(reasoning ? { reasoning } : {}),
          ...(rt.lastContext ? { context: rt.lastContext } : {}),
          ...(rt.contextWindow ? { window: rt.contextWindow } : {}),
          startedAt: startedAtById.get(id) ?? rt.startedAt,
        });
      }
    }
    if (s.busy && s.activeConversationId && (s.streamingText || s.liveTools?.length)) {
      const id = s.activeConversationId;
      const full = s.streamingText ?? "";
      const tool = s.liveTools?.length ? s.liveTools[s.liveTools.length - 1]!.name : "";
      const sig = [tool, full.length, full.slice(-200)].join("|");
      if (lastStreamSent.get(id) !== sig) {
        lastStreamSent.set(id, sig);
        broadcast({ type: "runtime", convId: id, ...wire.next(id, full), tool, startedAt: startedAtById.get(id) ?? s.busyStartedAt ?? undefined });
      }
    }
  };
}
