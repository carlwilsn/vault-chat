// Conversation + schedule stores. Byte-for-byte the lib.rs on-disk layout:
// one append-only `<id>.jsonl` per conversation (meta line + one line per
// message, keys sorted like serde_json's default BTreeMap), tombstones in
// conversations-deleted.jsonl, never-shrink, write-temp-then-rename.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { renameRetry } from "../atomic";
import { join } from "node:path";
import type { CommandFn } from "./registry";

const NOTES_DIR = ".vault-chat"; // lib.rs:122
const CONVERSATIONS_DIR = "conversations"; // lib.rs:131
const CONVERSATIONS_FILE = "conversations.jsonl"; // lib.rs:125
const SCHEDULES_FILE = "schedules.jsonl"; // lib.rs:132
const SCHEDULES_DELETED_FILE = "schedules-deleted.jsonl"; // lib.rs:140

/** serde_json::to_string with default features: object keys sorted. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) continue;
      out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** lib.rs:936 conversation_file_stem. */
export function conversationFileStem(id: string): string {
  const safe = [...id].map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : "_")).join("");
  const trimmed = safe.replace(/^_+|_+$/g, "");
  return trimmed || "conversation";
}

function lines(s: string): string[] {
  return s.split("\n").map((l) => l.replace(/\r$/, ""));
}

/** lib.rs:969 conversation_tombstone_stems. */
export function conversationTombstoneStems(vault: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const l of lines(readFileSync(join(vault, NOTES_DIR, "conversations-deleted.jsonl"), "utf8"))) {
      const v = parse(l);
      if (v && typeof v.id === "string") out.add(conversationFileStem(v.id));
    }
  } catch {
    /* none */
  }
  return out;
}

/** lib.rs:1101 is_terminal_meta. */
function isTerminalMeta(v: any): boolean {
  return (v.completedAt !== undefined && v.completedAt !== null) || v.missionState === "DONE" || v.missionState === "KILLED";
}

/** lib.rs:1026 reconstruct_conversation. Returns the conversation object. */
export function reconstructConversation(contents: string): any | null {
  let meta: any = null;
  let metaActivity = -Infinity;
  const messages: any[] = [];
  let prevCanon: string | null = null;
  for (const raw of lines(contents)) {
    const t = raw.trim();
    if (!t) continue;
    const v = parse(t);
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    if ("id" in v) {
      const act = typeof v.lastActivityAt === "number" ? v.lastActivityAt : 0;
      const cand = isTerminalMeta(v);
      let take: boolean;
      if (!meta) take = true;
      else {
        const cur = isTerminalMeta(meta);
        take = cand !== cur ? cand : act >= metaActivity;
      }
      if (take) {
        metaActivity = act;
        meta = v;
      }
    } else if ("role" in v) {
      const canon = canonicalJson(v);
      const prev = messages[messages.length - 1];
      const twin = prev !== undefined && prev.role === v.role && prevCanon === canon;
      if (!twin) {
        messages.push(v);
        prevCanon = canon;
      }
    }
  }
  if (!meta) return null;
  return { ...meta, messages };
}

/** lib.rs:1188 deduped_line_count. */
export function dedupedLineCount(contents: string): number {
  let count = 0;
  let prevLine: string | null = null;
  let prevRole: string | undefined | null = null;
  for (const raw of lines(contents)) {
    const t = raw.trim();
    if (!t) continue;
    const v = parse(t);
    if (v === undefined) {
      count++;
      prevLine = null;
      prevRole = null;
      continue;
    }
    if (v && typeof v === "object" && "id" in v) {
      count++;
      prevLine = null;
      prevRole = null;
      continue;
    }
    const role = v?.role;
    const canon = canonicalJson(v);
    if (prevLine === canon && prevRole === role) continue;
    count++;
    prevLine = canon;
    prevRole = role;
  }
  return count;
}

/** All live conversations as objects (shared by the phone GET routes). */
export function readConversationObjects(vault: string): any[] {
  return conversationsRead(vault)
    .map((s) => parse(s))
    .filter((v) => v && typeof v === "object");
}

/** lib.rs:1110 conversations_read. */
export function conversationsRead(vault: string): string[] {
  const base = join(vault, NOTES_DIR);
  const dir = join(base, CONVERSATIONS_DIR);
  if (existsSync(dir)) {
    const out: string[] = [];
    const tomb = conversationTombstoneStems(vault);
    const seen = new Set<string>();
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const stem = n.slice(0, -6);
      if (tomb.has(stem)) {
        // The box authors conversations; a tombstone from the laptop removes the file here.
        if (!isSyncFollower(vault)) rmSync(join(dir, n), { force: true });
        continue;
      }
      let contents: string;
      try {
        contents = readFileSync(join(dir, n), "utf8");
      } catch {
        continue;
      }
      const conv = reconstructConversation(contents);
      if (conv) {
        seen.add(stem);
        out.push(canonicalJson(conv));
      }
    }
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const stem = n.slice(0, -5);
      if (seen.has(stem) || tomb.has(stem)) continue;
      try {
        const t = readFileSync(join(dir, n), "utf8").trim();
        if (t) out.push(t);
      } catch {
        /* skip */
      }
    }
    if (out.length) return out;
  }
  const legacy = join(base, CONVERSATIONS_FILE);
  if (!existsSync(legacy)) return [];
  return lines(readFileSync(legacy, "utf8")).filter((l) => l.trim());
}

/** lib.rs:5513 is_sync_follower — the role marker in the git dir. The box is
 * always the writer, but mirror the check so a misconfigured checkout behaves
 * exactly like the desktop would. */
export function isSyncFollower(vault: string): boolean {
  try {
    return readFileSync(join(vault, ".git", "vault-chat-sync-role"), "utf8").trim().toLowerCase() === "follower";
  } catch {
    return false;
  }
}

/** lib.rs:1225 conversations_write_all. */
export function conversationsWriteAll(vault: string, incoming: string[]): void {
  const base = join(vault, NOTES_DIR);
  const dir = join(base, CONVERSATIONS_DIR);
  mkdirSync(dir, { recursive: true });
  const tomb = conversationTombstoneStems(vault);
  const follower = isSyncFollower(vault);
  for (const line of incoming) {
    const t = String(line).trim();
    if (!t) continue;
    const v = parse(t);
    if (!v || typeof v !== "object") continue;
    if (follower && ["mission", "worker", "ask"].includes(String(v.source ?? ""))) continue;
    const id = typeof v.id === "string" ? v.id : "";
    if (!id) continue;
    const stem = conversationFileStem(id);
    if (tomb.has(stem)) {
      rmSync(join(dir, `${stem}.jsonl`), { force: true });
      rmSync(join(dir, `${stem}.json`), { force: true });
      continue;
    }
    const { messages, ...meta } = v;
    let body = canonicalJson(meta) + "\n";
    let prevLine: string | null = null;
    let prevRole: unknown = null;
    for (const m of Array.isArray(messages) ? messages : []) {
      const l = canonicalJson(m);
      const role = m?.role;
      if (prevLine === l && prevRole === role) continue;
      body += l + "\n";
      prevLine = l;
      prevRole = role;
    }
    const path = join(dir, `${stem}.jsonl`);
    const staleJson = join(dir, `${stem}.json`);
    let existing: string | null = null;
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      existing = null;
    }
    if (existing !== null) {
      if (existing === body) {
        rmSync(staleJson, { force: true });
        continue;
      }
      if (dedupedLineCount(body) < dedupedLineCount(existing)) continue; // never shrink
    }
    const tmp = join(base, `${stem}.jsonl.tmp`);
    writeFileSync(tmp, body);
    renameRetry(tmp, path);
    rmSync(staleJson, { force: true });
  }
  rmSync(join(base, CONVERSATIONS_FILE), { force: true });
}

function scheduleTombstoneIds(vault: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const l of lines(readFileSync(join(vault, NOTES_DIR, SCHEDULES_DELETED_FILE), "utf8"))) {
      const v = parse(l);
      if (v && typeof v.id === "string") out.add(v.id);
    }
  } catch {
    /* none */
  }
  return out;
}

export const conversationCommands: Record<string, CommandFn> = {
  // lib.rs:1110
  conversations_read: ({ vault }) => conversationsRead(vault),
  // lib.rs:1225
  conversations_write_all: ({ vault, lines: ls }) => {
    // The box never writes a conversation file: its conversations are the event log (server/convlog).
    if ((globalThis as { __VC_HEADLESS__?: unknown }).__VC_HEADLESS__) return null;
    conversationsWriteAll(vault, ls ?? []);
    return null;
  },
  // lib.rs:986 — tombstone first, then remove the file.
  conversation_delete: ({ vault, id }) => {
    const p = join(vault, NOTES_DIR, "conversations-deleted.jsonl");
    mkdirSync(join(vault, NOTES_DIR), { recursive: true });
    appendFileSync(p, canonicalJson({ id, ts: Date.now() }) + "\n");
    const dir = join(vault, NOTES_DIR, CONVERSATIONS_DIR);
    const stem = conversationFileStem(String(id));
    rmSync(join(dir, `${stem}.jsonl`), { force: true });
    rmSync(join(dir, `${stem}.json`), { force: true });
    return null;
  },
  // lib.rs:1413 — tombstoned rows dropped.
  schedules_read: ({ vault }) => {
    const p = join(vault, NOTES_DIR, SCHEDULES_FILE);
    if (!existsSync(p)) return [];
    const tomb = scheduleTombstoneIds(vault);
    return lines(readFileSync(p, "utf8"))
      .filter((l) => l.trim())
      .filter((l) => {
        const v = parse(l);
        return !(v && typeof v.id === "string" && tomb.has(v.id));
      });
  },
  // lib.rs:1444
  schedules_write_all: ({ vault, lines: ls }) => {
    const dir = join(vault, NOTES_DIR);
    mkdirSync(dir, { recursive: true });
    let body = (ls as string[]).join("\n");
    if (body && !body.endsWith("\n")) body += "\n";
    const tmp = join(dir, `${SCHEDULES_FILE}.tmp`);
    writeFileSync(tmp, body);
    renameRetry(tmp, join(dir, SCHEDULES_FILE));
    return null;
  },
  // lib.rs:1386
  schedule_tombstone_add: ({ vault, id }) => {
    mkdirSync(join(vault, NOTES_DIR), { recursive: true });
    appendFileSync(join(vault, NOTES_DIR, SCHEDULES_DELETED_FILE), canonicalJson({ id, ts: Date.now() }) + "\n");
    return null;
  },
  // lib.rs:5525
  vault_sync_role: ({ vault }) => (isSyncFollower(vault) ? "follower" : "writer"),
};
