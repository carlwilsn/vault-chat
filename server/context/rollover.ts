// Rolling sessions: when a Codex thread's context grows past a per-model
// threshold, a cheap model writes a recap and ENGINE starts a new thread for the
// same conversation id, with the recap in its developer instructions.
import { randomUUID } from "node:crypto";
import { ctxConfig } from "./config";
import { cap } from "./files";
import { latestRollover } from "./builder";
import { callResponses, modelWindow } from "./model";
import { readProject } from "./projects";
import type { ContextConv, ContextMessage, ThreadTokenUsage } from "./types";

export const ROLLOVER_TEXT = "Rolled over to a fresh session";

/** The token count past which a thread on `model` rolls over. */
export function rollThreshold(model: string, window?: number | null): number {
  const { rollFraction, rollMaxTokens } = ctxConfig();
  const w = window && window > 0 ? window : modelWindow(model);
  return Math.min(Math.floor(w * rollFraction), rollMaxTokens);
}

/**
 * True when the thread's current context (the last model call's totalTokens,
 * from `thread/tokenUsage/updated` → params.tokenUsage) is past the threshold.
 * The window is the one Codex reports, else the catalog's.
 */
export function shouldRoll(conv: ContextConv, usage: ThreadTokenUsage | null | undefined): boolean {
  const last = usage?.last;
  if (!last) return false;
  const used = last.totalTokens || (last.inputTokens ?? 0) + (last.outputTokens ?? 0);
  const model = conv.model ?? ctxConfig().agentModel;
  return used > rollThreshold(model, usage?.modelContextWindow);
}

const RECAP_INSTRUCTIONS = `You write the recap that lets a fresh session of an agent continue a long conversation with Carl. The new session sees only your recap, the project's memory files and Carl's rules.

Write, in plain markdown, under 1,200 words:
- The goal, in Carl's terms, and whether it is done.
- What was decided, and why (Carl's words where they matter).
- What was done: files written (paths), commands run, results with the numbers.
- What is in flight: running jobs (how to check them), scheduled wakes, questions waiting on Carl.
- What comes next.
Facts only; write nothing the conversation does not support. Mark anything unverified as such.`;

function renderTranscript(msgs: ContextMessage[], maxChars: number): string {
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.rollover) continue;
    const who = m.role === "user" ? (m.hidden ? "Context" : "Carl") : "Agent";
    if (m.system && !m.content?.trim()) continue;
    let s = `${who}: ${(m.content ?? "").trim()}`;
    for (const t of m.toolCalls ?? []) {
      const input = JSON.stringify(t.input ?? {}).slice(0, 400);
      const result = (t.result ?? "").slice(0, 600);
      s += `\n  [tool ${t.name} ${input}${result ? ` → ${result}` : ""}]`;
    }
    lines.push(s);
  }
  const all = lines.join("\n\n");
  if (all.length <= maxChars) return all;
  const head = Math.floor(maxChars * 0.15);
  return `${all.slice(0, head)}\n\n[… ${all.length - maxChars} characters of the middle left out …]\n\n${all.slice(all.length - (maxChars - head))}`;
}

export type Recap = {
  /** Summary + project memory; goes into the new thread's developer instructions via the marker. */
  recap: string;
  /** Append this message to the conversation (a quiet divider in both renderers), then thread/start. */
  marker: ContextMessage;
  model: string;
  costUsd: number | null;
  /** True when the model failed and the recap is a mechanical excerpt instead. */
  fallback: boolean;
};

/**
 * Summarise the conversation (since its last roll-over, plus that recap) with a
 * cheap model, combined with the project memory. Never throws: a failed model
 * call yields a mechanical recap (fallback: true).
 */
export async function buildRecap(conv: ContextConv, opts: { signal?: AbortSignal } = {}): Promise<Recap> {
  const cfg = ctxConfig();
  const msgs = conv.messages ?? [];
  let from = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.rollover) {
      from = i + 1;
      break;
    }
  }
  const prev = latestRollover(conv);
  const project = conv.project ? readProject(conv.project) : null;
  const memory = project ? cap(project.memory, 6_000, "the rest is in memory.md") : "";

  const input =
    (prev ? `## The recap from the session before\n\n${prev.recap}\n\n` : "") +
    (project ? `## Project ${project.name}: memory.md\n\n${memory}\n\n## progress.md\n\n${cap(project.progress, 3_000, "older entries in progress.md", "tail")}\n\n` : "") +
    `## The conversation${prev ? " since then" : ""}\n\n${renderTranscript(msgs.slice(from), 200_000)}`;

  let summary = "";
  let costUsd: number | null = null;
  let fallback = false;
  try {
    const r = await callResponses({
      model: cfg.recapModel,
      instructions: RECAP_INSTRUCTIONS,
      input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
      maxOutputTokens: 6_000,
      signal: opts.signal,
    });
    summary = r.text.trim();
    costUsd = r.costUsd;
  } catch {
    summary = "";
  }
  if (!summary) {
    fallback = true;
    summary =
      `(The recap model was unavailable; this is the end of the conversation, verbatim.)\n\n` +
      renderTranscript(msgs.slice(from), 8_000);
  }

  const recap =
    summary +
    (project ? `\n\n## Project memory at roll-over (${project.name})\n\n${memory}` : "");
  const marker: ContextMessage = {
    role: "assistant",
    content: ROLLOVER_TEXT,
    system: true,
    mid: randomUUID().slice(0, 12),
    rollover: { at: Date.now(), fromThread: conv.codexThreadId, recap },
  };
  return { recap, marker, model: cfg.recapModel, costUsd, fallback };
}
