// Global view, original files: no migration or copied notes. The existing
// Main/workspace registry is the authority, never the viewer or a thread owner.
import { readFileSync, mkdirSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { conversationRoot, legacyProjectRoots } from './context/config';
import { dedupeNotes, type Note } from '../src/notes';

export function noteRoots(fallback: string): string[] {
  return [...new Set([conversationRoot(fallback), ...legacyProjectRoots()].map(v => resolve(v)))];
}
const file = (root: string) => join(root, '.vault-chat/notes.jsonl');
function local(root: string): Note[] {
  let text: string;
  try { text = readFileSync(file(root), 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  return dedupeNotes(text.split('\n').flatMap(line => {
    try { const n = JSON.parse(line); return typeof n.id === 'string' ? [n] : []; } catch { return []; }
  }));
}
export function globalNotes(fallback: string): Note[] {
  const byId = new Map<string, Note>();
  for (const root of noteRoots(fallback)) for (const n of local(root)) {
    // Stable owner for an existing id. Do not collapse unrelated same-text notes
    // across workspaces, nor mint ids to conceal a routing failure.
    if (!byId.has(n.id)) byId.set(n.id, { ...n, origin_vault: root });
  }
  return [...byId.values()];
}
function persistEdits(root: string, edits: Map<string, Note>): void {
  const p = file(root);
  const emitted = new Set<string>();
  const lines = readFileSync(p, 'utf8').split('\n').flatMap(line => {
    let id: string;
    try { id = JSON.parse(line).id; } catch { return [line]; }
    const note = edits.get(id);
    if (!note) return [line]; // unrelated human notes remain byte-for-byte
    if (emitted.has(id)) return [];
    emitted.add(id);
    const { origin_vault: _, ...body } = note;
    return [JSON.stringify(body)];
  });
  const tmp = p + '.tmp';
  writeFileSync(tmp, lines.join('\n'));
  renameSync(tmp, p);
}
export function appendGlobalNote(fallback: string, note: Note): void {
  if (globalNotes(fallback).some(n => n.id === note.id)) throw new Error('note id already exists');
  const root = conversationRoot(fallback);
  const p = file(root);
  mkdirSync(dirname(p), { recursive: true });
  const { origin_vault: _, ...body } = note;
  let prefix = '';
  try { const text = readFileSync(p, 'utf8'); if (text && !text.endsWith('\n')) prefix = '\n'; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  appendFileSync(p, prefix + JSON.stringify(body) + '\n');
}
export function writeGlobalNotes(fallback: string, incoming: Note[]): void {
  const current = globalNotes(fallback);
  const changes = new Map<string, Map<string, Note>>();
  for (const note of incoming) {
    const old = current.find(n => n.id === note.id);
    if (!old) throw new Error('unknown note; use append');
    const { origin_vault: _, ...body } = note;
    const { origin_vault: owner, ...previous } = old;
    if (JSON.stringify(body) === JSON.stringify(previous)) continue;
    // A whole-panel save is a set of edits, not a replacement snapshot. Omitted
    // and concurrently-created notes stay put; older snapshots cannot win.
    if ((note.last_updated || note.timestamp) < (old.last_updated || old.timestamp)) continue;
    if (old.status === 'cleared' && note.status !== 'cleared') continue;
    let edits = changes.get(owner!);
    if (!edits) changes.set(owner!, edits = new Map());
    edits.set(note.id, body);
  }
  // Synchronous read/modify/rename in this one server owner: no async gap in
  // which another API/tool write can be lost. No startup writes or migration.
  for (const [owner, edits] of changes) persistEdits(owner, edits);
}

/** Resolve a file link against the original note, not a same-name viewer file. */
export function noteSourceOwner(fallback: string, path: string): string | null {
  for (const n of globalNotes(fallback)) {
    if (n.anchors.some(a => resolve(n.origin_vault!, a.source_path) === path)) return n.origin_vault!;
  }
  return null;
}
