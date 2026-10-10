// The fake backend: one table of every `invoke` command the app can reach.
//   • server/commands/{fs,conversations}.ts — the repo's own node ports of
//     lib.rs, run unchanged against the in-memory FS (shims/memfs.ts);
//   • memgit.ts — history; misc.ts — desktop-only file ops + inert host calls;
//   • host.ts — scenario-scripted sync, keys, shell and Tauri plugins.
// An unknown command shows a "not faked: <cmd>" toast and rejects, so a gap
// is visible at once (and the self-test fails on it).

import { fsCommands } from "../../../server/commands/fs";
import { conversationCommands } from "../../../server/commands/conversations";
import DEFAULT_SYSTEM_MD from "../../../src-tauri/defaults/system.md?raw";
import DEFAULT_VOICE_MD from "../../../src-tauri/defaults/voice.md?raw";
import DEFAULT_SUPERVISOR_MD from "../../../src-tauri/defaults/supervisor.md?raw";
import DEFAULT_ASSISTANT_MD from "../../../src-tauri/defaults/assistant.md?raw";
import { gitCommands } from "./memgit";
import { miscCommands } from "./misc";
import { hostCommands, windowCommand } from "./host";
import { report } from "../overlay";

type Fn = (a: Record<string, any>) => unknown;

const table: Record<string, Fn> = {
  ...(fsCommands as Record<string, Fn>),
  ...(conversationCommands as Record<string, Fn>),
  ...gitCommands,
  ...miscCommands,
  ...hostCommands,
  default_system_prompt: () => DEFAULT_SYSTEM_MD,
  default_voice_prompt: () => DEFAULT_VOICE_MD,
  default_supervisor_prompt: () => DEFAULT_SUPERVISOR_MD,
  default_assistant_prompt: () => DEFAULT_ASSISTANT_MD,
};

export type CallRecord = { at: number; cmd: string; args: unknown; ok: boolean; ms: number; error?: string; unknown?: boolean };
export const calls: CallRecord[] = [];
export const unknownCommands = new Set<string>();
let overrides: Record<string, unknown> = {};

/** Scenario overrides: a value, a function, or {error} to reject with. */
export function setOverrides(o: Record<string, unknown> | undefined): void {
  overrides = o ?? {};
}

export function knownCommands(): string[] {
  return Object.keys(table).sort();
}

function summarize(args: Record<string, any>): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === "string") out[k] = v.length > 200 ? v.slice(0, 200) + `… (${v.length})` : v;
    else if (Array.isArray(v)) out[k] = v.length > 20 ? `[${v.length} items]` : v;
    else out[k] = v;
  }
  return out;
}

export async function dispatch(cmd: string, args: Record<string, any>): Promise<unknown> {
  const t0 = performance.now();
  const rec: CallRecord = { at: Date.now(), cmd, args: summarize(args), ok: true, ms: 0 };
  calls.push(rec);
  if (calls.length > 5000) calls.splice(0, 1000);
  try {
    if (cmd in overrides) {
      const o = overrides[cmd] as any;
      if (o && typeof o === "object" && "error" in o) throw o.error;
      return typeof o === "function" ? await o(args) : o;
    }
    const w = windowCommand(cmd, args);
    if (w.handled) return w.value;
    const fn = table[cmd];
    if (!fn) {
      rec.unknown = true;
      unknownCommands.add(cmd);
      report("unfaked", cmd);
      console.warn(`[preview] not faked: ${cmd}`, args);
      throw `preview: command "${cmd}" is not faked`;
    }
    return await fn(args ?? {});
  } catch (e) {
    rec.ok = false;
    rec.error = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    // Tauri rejects with the Err(String) as-is.
    throw typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  } finally {
    rec.ms = Math.round(performance.now() - t0);
  }
}
