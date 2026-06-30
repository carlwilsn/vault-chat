import { invoke } from "@tauri-apps/api/core";
import type { Conversation } from "./conversations";

function fmtAgo(min: number): string {
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// A compact, factual snapshot of what is ACTUALLY live right now — active
// missions, threads executing this instant, and the most recent worker
// outcomes — for injection into the agent's context each turn. This is the
// "read-path = write-path" anchor, and the sibling of the nowNote date stamp in
// agent.ts: without a ground-truth state block, an assistant asked "how's the
// mission going?" has nothing real in front of it and fills the gap with a
// plausible story — the confabulated "88% GPU... genuinely training" for a
// mission that had actually been torn down. With the real state injected, an
// absent mission is visibly absent, so the honest answer becomes the easy one.
// Built from the SAME in-memory store the UI and the run/notification records
// are written from. Returns "" for a quiet vault (no missions, nothing running,
// no recent workers) so it never bloats a normal chat.
export function buildLiveStateBlock(
  conversations: Conversation[],
  runningIds: Set<string>,
  now: number,
): string {
  const missions = conversations.filter(
    (c) => c.source === "mission" && !c.completedAt,
  );
  const recentWorkers = conversations
    .filter((c) => c.source === "worker")
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, 5);

  if (missions.length === 0 && runningIds.size === 0 && recentWorkers.length === 0) {
    return "";
  }

  const lines: string[] = [];
  if (missions.length === 0) {
    lines.push(
      "- Active missions: NONE. No mission is running right now. If asked about a mission, say there isn't one active — do not describe one.",
    );
  } else {
    lines.push("- Active missions (not yet completed):");
    for (const m of missions) {
      const key = (m.mission ?? m.title ?? "").trim();
      const workers = conversations.filter(
        (c) => c.source === "worker" && (c.mission ?? "").trim() === key,
      );
      const workersRunning = workers.filter((w) => runningIds.has(w.id)).length;
      const executing = runningIds.has(m.id) || workersRunning > 0;
      const ago = fmtAgo(Math.round((now - m.lastActivityAt) / 60000));
      lines.push(
        `    • "${m.title}" — ${executing ? "EXECUTING NOW" : "idle (nothing executing this instant)"}; ${workersRunning} of ${workers.length} workers running; last activity ${ago}.`,
      );
    }
  }
  if (runningIds.size > 0) {
    lines.push(`- Threads executing right now: ${runningIds.size}.`);
  }
  if (recentWorkers.length > 0) {
    lines.push("- Most recent workers:");
    for (const w of recentWorkers) {
      const last = w.messages[w.messages.length - 1];
      const c = typeof last?.content === "string" ? last.content.trim() : "";
      const crashed = c === "[object Object]" || c.startsWith("⚠️");
      const mark = runningIds.has(w.id)
        ? "running"
        : crashed
          ? "FAILED (crash bubble — NOT a real completion)"
          : "finished";
      lines.push(
        `    • "${w.title}" — ${mark}, ${fmtAgo(Math.round((now - w.lastActivityAt) / 60000))}.`,
      );
    }
  }

  return [
    "## Live state (ground truth, read from the store this turn)",
    "",
    'This is the ACTUAL runtime state right now. Trust THIS over memory, expectation, or what you set up earlier. Answer every status question — "how is it going", "is X done", "is it still running", "what is the mission doing" — from this block. If something is not listed here, it is not running: say so plainly. Never reconstruct, estimate, or imagine a status that is not here.',
    "",
    ...lines,
  ].join("\n");
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await invoke<string>("read_text_file", { path });
  } catch {
    return null;
  }
}

async function tryGlob(pattern: string, cwd: string): Promise<string[]> {
  try {
    return await invoke<string[]>("glob_files", { pattern, cwd });
  } catch {
    return [];
  }
}

export async function loadSessionContext(vault: string): Promise<string> {
  const pieces: string[] = [];

  // Load binding-rules files in priority order. First four are neutral /
  // industry conventions (AGENTS.md is the emerging cross-tool standard
  // used by Codex CLI, cline, etc.). CLAUDE.md kept for Claude Code
  // interop. LEARNING_RULES.md is the user-specific convention.
  const rulesPaths = [
    `${vault}/LEARNING_RULES.md`,
    `${vault}/learn/LEARNING_RULES.md`,
    `${vault}/AGENTS.md`,
    `${vault}/learn/AGENTS.md`,
    `${vault}/AGENT.md`,
    `${vault}/learn/AGENT.md`,
    `${vault}/CLAUDE.md`,
    `${vault}/learn/CLAUDE.md`,
  ];
  for (const p of rulesPaths) {
    const body = await tryRead(p);
    if (body) {
      pieces.push(`## ${p}\n\n${body}`);
    }
  }

  const goalPatterns = ["goals/*.md", "learn/goals/*.md"];
  for (const pat of goalPatterns) {
    const paths = await tryGlob(pat, vault);
    for (const path of paths) {
      const body = await tryRead(path);
      if (body) {
        pieces.push(`## ${path}\n\n${body}`);
      }
    }
    if (paths.length) break;
  }

  if (!pieces.length) return "";
  return [
    "# Session context (auto-loaded from vault)",
    "",
    "The following files describe the user's workflow, rules, and active goals. Treat them as binding.",
    "",
    pieces.join("\n\n---\n\n"),
  ].join("\n");
}
