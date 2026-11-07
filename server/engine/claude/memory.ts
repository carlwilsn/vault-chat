// vault-chat's memory, the way Claude Code reads memory.
//
// Carl's memory is the files he and the agent already keep —
// .vault-chat/MEMORY.md — and those stay the only memory: Claude Code's own
// auto-memory is off (session.ts). What changes here is how the file REACHES a
// session: instead of riding in front of every turn, it is imported by a
// CLAUDE.md in the session's own config dir, which Claude Code loads itself.
// That puts it in the cached part of the context rather than in each prompt.
//
// Measured on this box, not assumed: Claude Code reads
// $CLAUDE_CONFIG_DIR/CLAUDE.md with settingSources ['user'] (NOT
// <HOME>/.claude/CLAUDE.md, and NOT the cwd's with ['project']), and an `@`
// import resolves an absolute path.
//
// A mid-session change is a separate problem: CLAUDE.md is read when the
// session starts, so an edit Carl makes while it is up would never arrive. The
// host watches the file's mark and hands the new text to the next prompt
// through a UserPromptSubmit hook — which is also where the near-cap reminder
// goes, so it is said by the engine that is near the cap.
import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_REL, loadedMemory, memoryPath } from "../../context/memory";

/** What the file looked like when a session last carried it. */
export type MemoryMark = { mtimeMs: number; size: number } | null;

export function memoryMark(vault: string): MemoryMark {
  try {
    const st = statSync(memoryPath(vault));
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export const sameMark = (a: MemoryMark, b: MemoryMark): boolean =>
  a === b || (!!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size);

/**
 * Write the CLAUDE.md a session's config dir is read from, importing the vault's
 * memory file by absolute path. Returns the mark the file had, so a later change
 * can be told from no change.
 */
export function writeClaudeMd(configDir: string, vault: string): MemoryMark {
  mkdirSync(configDir, { recursive: true });
  const path = memoryPath(vault);
  const mem = loadedMemory(vault);
  const body = [
    `# ${MEMORY_REL}`,
    "",
    "This is Carl's memory for this vault: what you have learned about how he works,",
    "kept by you with your ordinary file tools. Add a dated line when something is",
    "worth remembering; merge and drop stale lines rather than letting it grow.",
    "",
    `@${path}`,
    "",
    ...(mem?.note ? [`> ${mem.note}`, ""] : []),
  ].join("\n");
  writeFileSync(join(configDir, "CLAUDE.md"), body);
  return memoryMark(vault);
}

/** The memory a running session has not been told about yet, or null (nothing new). */
export function memoryUpdate(vault: string, since: MemoryMark): { text: string; mark: MemoryMark } | null {
  const now = memoryMark(vault);
  if (sameMark(now, since)) return null;
  const mem = loadedMemory(vault);
  const text = mem
    ? `<memory file="${MEMORY_REL}" changed="true">\n${mem.text}\n</memory>${mem.note ? `\n<memory-note>${mem.note}</memory-note>` : ""}`
    : `<memory file="${MEMORY_REL}" changed="true">(empty)</memory>`;
  return { text, mark: now };
}
