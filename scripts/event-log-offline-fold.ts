/** Offline canonical hydration: native streams retain ONLY IDs actually requested
 * by original feed pointers. No runtime fallback, no copied history authority. */
import { statSync } from "node:fs";
import { isAbsolute, resolve, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { offlineEntries } from "../server/convlog/piSession.ts";
import { emptyPicture, expandSubagents, reduce, REDUCER_VERSION, type Picture } from "../src/convlog/reduce.ts";
import type { PiEntry, LogRecord, StoredRecord } from "../src/convlog/protocol.ts";
import { identity, same } from "./event-log-stream.ts";
export type Reference = { v: number; rv: number; seq: number; picture: Picture };
export class OfflineFold {
  picture?: Picture;
  readonly pointed: Record<string, string[]> = Object.create(null);
  private pointedSets = new Map<string, Set<string>>();
  private files = new Map<string, { identity: ReturnType<typeof identity> | null; stream: Generator<PiEntry>; found: Map<string, PiEntry> }>();
  private referenceSeen = false;
  constructor(readonly events: string, readonly strict = true, readonly reference?: Reference, readonly nativePaths?: ReadonlyMap<string, string>) {
    if (reference && (![2, 3].includes(reference.v) || reference.rv !== REDUCER_VERSION || reference.seq !== reference.picture?.seq)) throw new Error("authoritative-checkpoint-incompatible");
  }
  private stamp(file: string) {
    try { return identity(statSync(file)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  resolve(rec: LogRecord): LogRecord {
    if (rec.type !== "entry") return rec;
    const p = rec as unknown as { file: string; id: string };
    if (typeof p.file !== "string" || typeof p.id !== "string" || !p.id) throw new Error("invalid-native-pointer");
    const file = isAbsolute(p.file) ? p.file : resolve(this.events, p.file);
    const r = relative(this.events, file);
    const key = !r.startsWith("..") && !isAbsolute(r) ? r.replace(/\\/g, "/") : file;
    const ids = this.pointed[key] ??= [];
    const seen = this.pointedSets.get(key) ?? new Set<string>();
    this.pointedSets.set(key, seen);
    if (!seen.has(p.id)) { seen.add(p.id); ids.push(p.id); }
    const physicalFile = this.nativePaths?.get(file) ?? file;
    let f = this.files.get(physicalFile);
    if (!f) {
      f = { identity: this.stamp(physicalFile), stream: offlineEntries(physicalFile), found: new Map() };
      this.files.set(physicalFile, f);
    }
    if (!same(f.identity, this.stamp(physicalFile))) throw new Error("native-session-changed");
    let entry = f.found.get(p.id);
    if (!entry && f.identity) {
      // Historical pointers normally follow native append order. Rewind ONLY
      // for an out-of-order requested ID, without retaining unrelated entries.
      for (let attempt = 0; attempt < 2 && !entry; attempt++) {
        for (let next = f.stream.next(); !next.done; next = f.stream.next()) {
          if (next.value.id === p.id) { entry = next.value; break; }
        }
        if (!entry && attempt === 0) { f.stream.return(undefined); f.stream = offlineEntries(physicalFile); }
      }
      if (entry) f.found.set(p.id, entry);
    }
    if (!entry && this.strict) throw new Error("native-pointer-missing-preserve-original-checkpoint");
    const { file: _file, id: _id, ...extra } = rec as unknown as Record<string, unknown>;
    // Match ConvLog.resolve's presentation overrides (shown/clientId/etc).
    return { file, entry: entry ?? { type: "missing", id: p.id }, ...extra } as LogRecord;
  }
  add(stored: StoredRecord) {
    if (!stored || typeof stored.conv !== "string" || !stored.conv || !Number.isSafeInteger(stored.seq) || stored.seq < 1 || !Number.isFinite(stored.at) || !["meta", "subagents", "entry", "live", "history-import"].includes(stored.type)) throw new Error("invalid-conversation-record");
    if (stored.type === "meta" && (!stored.patch || typeof stored.patch !== "object" || Array.isArray(stored.patch))) throw new Error("invalid-metadata-patch");
    const before = this.picture ?? emptyPicture(stored.conv);
    if (stored.conv !== before.id || stored.seq <= before.seq) throw new Error("conversation-sequence-mismatch");
    const logical = stored.type === "subagents" ? expandSubagents(before, stored) : stored;
    // Import provenance preserves the COMPLETE original pointer index, including
    // entries hidden by a source-local Clear. Do not replay source controls.
    if (logical.type === "history-import" && logical.sourceRecord?.type === "entry") this.resolve(logical.sourceRecord);
    this.picture = reduce(before, this.resolve(logical));
    if (this.reference && logical.seq === this.reference.seq) {
      // Compare persisted canonical state, not JS-only optional undefined keys
      // (e.g. a completed tool's cleared `partial` field is omitted on disk).
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(this.picture)), this.reference.picture)) throw new Error("authoritative-checkpoint-fold-mismatch-preserve-original");
      this.referenceSeen = true;
    }
    return { before, logical };
  }
  verify() {
    if (!this.picture || (this.reference && !this.referenceSeen)) throw new Error("authoritative-checkpoint-boundary-not-found");
    for (const [file, f] of this.files) if (!same(f.identity, this.stamp(file))) throw new Error("native-session-changed");
    return this.picture;
  }
  get nativeFiles() { return [...this.files].map(([path, f]) => ({ path, identity: f.identity })); }
  close() { for (const f of this.files.values()) f.stream.return(undefined); }
}
