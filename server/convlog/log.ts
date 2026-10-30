// The box's conversation feed for one vault (src/convlog/protocol.ts). The box
// server is its only writer. A conversation's transcript is pi's own session
// files; the feed holds only pointers into them, pi's live events for the
// message in flight, the conversation's fields and vault-level signals.
//
// Layout: <vault>/.vault-chat/events/
//   <conv>.jsonl      one conversation's records, in seq order (one JSON line each);
//                     an entry record is a pointer {file, id, clientId?, shown?, via?};
//                     worker snapshots store changed rows plus identity references; reads expand full meta
//   <conv>.ckpt.json  its picture at some seq K, exactly fold(records <= K) (a cache: deleting it is harmless)
//   sessions/         pi-format session files for what no pi wrote (an imported older
//                     conversation, a voice-only chat, a line after a failed start)
//   _signals.jsonl    vault-level signals (conv: null)
//   _seq              the highest seq reserved (blocks of 1000): seqs never go back
//   _epoch            this feed's identity: a client holding a cursor from another starts over
//
// Why one file per conversation under ONE vault-wide sequence: a client opens a
// conversation by replaying its file (or its checkpoint plus the tail), while
// /poll?after=N still answers exactly the records after N across the vault (in
// memory for the recent tail, from the files for anything older).
//
// Every record is written (appendFileSync) before anyone is told about it, and
// an entry is pointed to only once pi has written it: a record a client has
// seen is on disk, and a restart loses nothing it showed. On the wire (and in
// memory) an entry record carries the entry itself, read from pi's file.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, ftruncateSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { renameRetry } from "../atomic";
import type { EventBody, LogRecord, PiEntry, PollAnswer, StoredRecord } from "../../src/convlog/protocol";
import { readEntries } from "./piSession";
import { REDUCER_VERSION, compactSubagents, emptyPicture, emptyRow, expandSubagents, foldInto, reduce, reduceRow, rowFromPicture, type Picture, type RowState } from "../../src/convlog/reduce";

const BLOCK = 1000;
/** Records kept in memory for /poll's fast path. */
const RECENT_MAX = 20_000;
/** At most this many records per /poll answer (`more` says to come back at once). */
const POLL_LIMIT = 2_000;
/** A checkpoint after this many records since the last one (and at every turn's end). */
const CKPT_EVERY = 400;

const SIGNALS = "_signals";

export type LegacySource = {
  /** The conversations an older file holds that are not in the log yet: their list rows. */
  rows(): RowState[];
  /** The records that bring one older conversation into the feed, its transcript written as a
   *  pi-format session file under `dir` (null: not a legacy one). The original is never touched. */
  records(id: string, dir: string): EventBody[] | null;
  /** The `at` its records carry (the original activity time, so opening it does not move it in the list). */
  at(id: string): number;
};

type Conv = {
  id: string;
  file: string;
  /** The highest seq in its file. */
  maxSeq: number;
  picture: Picture;
  row: RowState;
  sinceCkpt: number;
};

const SEQ_AT_START = /^\{"seq":(\d+),/;

function seqOfLine(line: string): number {
  const m = SEQ_AT_START.exec(line);
  if (m) return Number(m[1]);
  try {
    return Number(JSON.parse(line)?.seq) || 0;
  } catch {
    return 0;
  }
}

/** A conversation id as a file name (no separators, no dots at the start). */
export function fileStem(id: string): string {
  const s = [...id].map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : "_")).join("");
  return s || "conv";
}

/** Drop a torn last line (a crash mid-write), so the next append starts on a fresh line. */
function healTail(file: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r+");
    const size = fstatSync(fd).size;
    if (!size) return;
    const look = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(look);
    readSync(fd, buf, 0, look, size - look);
    if (buf[look - 1] === 0x0a) return;
    const nl = buf.lastIndexOf(0x0a);
    const keep = nl < 0 ? (look === size ? 0 : size) : size - look + nl + 1;
    if (keep < size) ftruncateSync(fd, keep);
  } catch {
    /* missing: nothing to heal */
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readRecords(file: string, after = 0, resolveEntry?: (rec: any) => LogRecord, base?: Picture): LogRecord[] {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: LogRecord[] = [];
  // Only metadata is needed to expand worker rows. Reuse the reducer, not a second
  // worker registry. Disk polls replay the prefix; checkpoint loads start at K.
  let projection = base;
  for (const line of raw.split("\n")) {
    if (!line || (base && seqOfLine(line) <= base.seq)) continue;
    let stored: StoredRecord;
    try {
      stored = JSON.parse(line);
    } catch {
      continue; // existing torn/invalid JSON recovery
    }
    projection ??= emptyPicture(stored.conv ?? "");
    // Validation errors in a framed delta are NOT torn JSON: fail closed.
    const rec = stored.type === "subagents" ? expandSubagents(projection, stored) : stored;
    if (rec.type === "meta") projection = reduce(projection, rec);
    else projection = { ...projection, seq: rec.seq };
    if (rec.seq <= after) continue;
    out.push(resolveEntry && rec.type === "entry" ? resolveEntry(rec) : rec);
  }
  return out;
}

/** pi's session files, read as needed: an entry record on disk names its file and entry id. */
class Entries {
  private files = new Map<string, Map<string, PiEntry>>();
  get(file: string, id: string): PiEntry | null {
    let m = this.files.get(file);
    if (!m || !m.has(id)) {
      // Not read yet, or written since: read it again.
      m = new Map(readEntries(file).map((e) => [e.id, e] as const));
      this.files.delete(file);
      this.files.set(file, m);
      while (this.files.size > 24) this.files.delete(this.files.keys().next().value!);
    }
    return m.get(id) ?? null;
  }
  /** pi wrote this entry (it is in hand already: no read). */
  put(file: string, e: PiEntry): void {
    this.files.get(file)?.set(e.id, e);
  }
}

export function lastSeq(file: string): number {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (!size) return 0;
    // The tail, wider until it holds a whole record: a last record longer than the window (a big tool result:
    // 186 KB on the box, 2026-10-30) must not read as "no seq" — the checkpoint would be refused and the whole log
    // folded from the start (past half a gigabyte, more than a string can hold: the conversation vanished).
    for (let look = Math.min(size, 1 << 16); ; look = Math.min(size, look * 4)) {
      const buf = Buffer.alloc(look);
      readSync(fd, buf, 0, look, size - look);
      const text = buf.toString("utf8");
      // Only whole lines: the first piece is a line's tail unless the window starts the file.
      const lines = text.split("\n");
      if (look < size) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        const s = lines[i] ? seqOfLine(lines[i]!) : 0;
        if (s) return s;
      }
      if (look >= size) return 0;
    }
  } catch {
    return 0;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Where seqs come from. A log alone has its own; the box's logs share one (setSharedClock), so every seq any of them
 *  hands out is above every seq any of them handed out before, and the global feed (GlobalFeed) stays one sequence. */
export type SeqClock = { next: number; floorFile?: string; floor?: number };

export class ConvLog {
  readonly dir: string;
  readonly epoch: string;
  /** The highest seq written (the head a client sees); new seqs start above the reserved floor. */
  private last = 0;
  private reservedUpTo = 0;
  private convs = new Map<string, Conv>();
  private signalsFile: string;
  private signalsMax = 0;
  /** The recent records of the whole vault, in seq order (the /poll fast path). */
  private recent: LogRecord[] = [];
  private waiters = new Set<() => void>();
  private listeners = new Set<(r: LogRecord) => void>();
  private legacyRows = new Map<string, RowState>();
  private entries = new Entries();
  /** Per conversation: the entries of each session file the feed points to (read on first use, kept up to date). */
  private pointed = new Map<string, Map<string, Set<string>>>();
  /** Where vault-chat's own pi-format session files live. */
  readonly sessionsDir: string;

  constructor(
    readonly vault: string,
    private legacy: LegacySource | null = null,
    dir?: string,
    private clock: SeqClock = { next: 1 },
  ) {
    this.dir = dir ?? join(vault, ".vault-chat", "events");
    mkdirSync(this.dir, { recursive: true });
    this.signalsFile = join(this.dir, `${SIGNALS}.jsonl`);
    this.sessionsDir = join(this.dir, "sessions");
    this.epoch = this.loadEpoch();
    let max = 0;
    for (const n of readdirSync(this.dir)) {
      if (!n.endsWith(".jsonl") || n.startsWith("_")) continue;
      const file = join(this.dir, n);
      healTail(file);
      const c = this.load(file);
      if (c) {
        this.convs.set(c.id, c);
        max = Math.max(max, c.maxSeq);
      }
    }
    healTail(this.signalsFile);
    this.signalsMax = lastSeq(this.signalsFile);
    max = Math.max(max, this.signalsMax);
    let floor = 0;
    try {
      floor = Number(readFileSync(join(this.dir, "_seq"), "utf8").trim()) || 0;
    } catch {
      floor = 0;
    }
    this.last = max;
    this.clock.next = Math.max(this.clock.next, max + 1, floor + 1, (this.clock.floor ?? 0) + 1);
    this.reserve(this.clock.next);
    this.refreshLegacy();
  }

  private loadEpoch(): string {
    const p = join(this.dir, "_epoch");
    try {
      const v = readFileSync(p, "utf8").trim();
      if (v) return v;
    } catch {
      /* new log */
    }
    const v = randomBytes(8).toString("hex");
    writeFileSync(p, v);
    return v;
  }

  private reserve(from: number): void {
    this.reservedUpTo = from + BLOCK - 1;
    const p = join(this.dir, "_seq");
    try {
      writeFileSync(p + ".tmp", String(this.reservedUpTo));
      renameRetry(p + ".tmp", p);
    } catch (e) {
      console.warn("[convlog] could not persist the seq floor:", (e as Error).message);
    }
    // A shared clock keeps its own floor too: a log opened late after a restart never hands out a seq below one
    // another log handed out before it.
    const c = this.clock;
    if (c.floorFile && (c.floor ?? 0) < this.reservedUpTo) {
      c.floor = this.reservedUpTo;
      try {
        writeFileSync(c.floorFile + ".tmp", String(c.floor));
        renameRetry(c.floorFile + ".tmp", c.floorFile);
      } catch (e) {
        console.warn("[convlog] could not persist the shared seq floor:", (e as Error).message);
      }
    }
  }

  /** A conversation's file → its picture (its checkpoint plus the records after it). */
  private load(file: string): Conv | null {
    const fileMax = lastSeq(file);
    let ck: { pic: Picture; seq: number } | null = null;
    try {
      const v = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".ckpt.json"), "utf8"));
      if (v?.v === 2 && v.rv === REDUCER_VERSION && v.picture && typeof v.seq === "number" && v.seq <= fileMax) ck = { pic: v.picture as Picture, seq: v.seq };
    } catch {
      /* none, or unreadable: fold from the start */
    }
    let pic: Picture;
    let tail: LogRecord[];
    if (ck) {
      tail = readRecords(file, ck.seq, this.resolve, ck.pic);
      pic = foldInto(ck.pic, tail);
    } else {
      tail = readRecords(file, 0, this.resolve);
      const id = tail.find((r) => typeof r.conv === "string")?.conv;
      if (!id) return null;
      pic = foldInto(emptyPicture(id), tail);
    }
    return { id: pic.id, file, maxSeq: Math.max(pic.seq, fileMax), picture: pic, row: rowFromPicture(pic), sinceCkpt: tail.length };
  }

  private legacyAt = -1;
  private legacyStamp(): number {
    try {
      return statSync(join(this.vault, ".vault-chat", "conversations")).mtimeMs;
    } catch {
      return 0;
    }
  }
  private refreshLegacy(): void {
    this.legacyAt = this.legacyStamp();
    this.legacyRows.clear();
    if (!this.legacy) return;
    try {
      for (const r of this.legacy.rows()) if (!this.convs.has(r.id)) this.legacyRows.set(r.id, r);
    } catch (e) {
      console.warn("[convlog] legacy conversations unreadable:", (e as Error).message);
    }
  }

  // ---------------------------------------------------------------- writing

  /** Append one record for `conv` (null: a vault-level signal). Written before anyone hears of it. */
  emit(conv: string | null, body: EventBody, at = Date.now()): LogRecord {
    const seq = this.clock.next++;
    if (seq >= this.reservedUpTo) this.reserve(seq);
    const rec = { seq, conv, at, ...body } as LogRecord;
    if (rec.type === "entry") rec.file = this.abs(rec.file);
    this.last = seq;
    const line = JSON.stringify(this.pointer(rec)) + "\n";
    if (conv === null) {
      appendFileSync(this.signalsFile, line);
      this.signalsMax = seq;
    } else {
      let c = this.convs.get(conv);
      if (!c) {
        const file = join(this.dir, `${fileStem(conv)}.jsonl`);
        c = { id: conv, file, maxSeq: 0, picture: emptyPicture(conv), row: emptyRow(conv), sinceCkpt: 0 };
        this.convs.set(conv, c);
        this.legacyRows.delete(conv);
      }
      appendFileSync(c.file, line);
      c.maxSeq = seq;
      c.picture = reduce(c.picture, rec);
      c.row = reduceRow(c.row, rec);
      c.sinceCkpt++;
      if (rec.type === "entry") {
        this.entries.put(rec.file, rec.entry);
        this.pointed.get(conv)?.get(rec.file)?.add(rec.entry.id);
      }
      if (c.sinceCkpt >= CKPT_EVERY || (rec.type === "meta" && rec.patch.running === null)) this.checkpoint(c);
    }
    this.recent.push(rec);
    if (this.recent.length > RECENT_MAX) this.recent.splice(0, this.recent.length - RECENT_MAX);
    for (const l of [...this.listeners]) {
      try {
        l(rec);
      } catch (e) {
        console.warn("[convlog] listener failed:", e);
      }
    }
    for (const w of [...this.waiters]) w();
    return rec;
  }

  /** A session file as an entry record names it on disk: relative to the feed's folder when inside it. */
  private rel(file: string): string {
    const r = relative(this.dir, file);
    return !r.startsWith("..") && !isAbsolute(r) ? r.replace(/\\/g, "/") : file;
  }
  private abs(file: string): string {
    return isAbsolute(file) ? file : resolve(this.dir, file);
  }

  /** Disk-only presentation; listeners, checkpoints and poll keep full public records. */
  private pointer(rec: LogRecord): unknown {
    if (rec.type === "meta" && rec.conv !== null) return compactSubagents(this.convs.get(rec.conv)?.picture ?? emptyPicture(rec.conv), rec);
    if (rec.type !== "entry") return rec;
    const { entry, file, images, ...rest } = rec;
    // An image the entry itself carries (pi stores it base64) is not copied: only its path.
    const inEntry = Array.isArray(entry.message?.content) && entry.message!.content.some((b: any) => b?.type === "image");
    const imgs = images?.map((i) => (inEntry ? { path: i.path } : i));
    return { ...rest, file: this.rel(file), id: entry.id, ...(imgs?.length ? { images: imgs } : {}) };
  }

  /** A pointer read back → the entry record (the entry from pi's file; gone: a placeholder no fold shows). */
  private resolve = (p: any): LogRecord => {
    const file = this.abs(String(p.file ?? ""));
    const id = String(p.id ?? "");
    const { seq, conv, at, type, file: _f, id: _id, ...extra } = p;
    const entry = this.entries.get(file, id) ?? ({ type: "missing", id } as PiEntry);
    // The same record (key for key) a client was handed when it was written.
    return { seq, conv, at, type, file, entry, ...extra } as LogRecord;
  };

  /** The entries of `file` this conversation's feed already points to (the engine's catch-up skips them). */
  pointedIn(conv: string, file: string): Set<string> {
    let byFile = this.pointed.get(conv);
    if (!byFile) {
      byFile = new Map();
      this.pointed.set(conv, byFile);
      const c = this.convs.get(conv);
      if (c) {
        for (const line of (() => {
          try {
            return readFileSync(c.file, "utf8").split("\n");
          } catch {
            return [];
          }
        })()) {
          if (!line.includes('"type":"entry"')) continue;
          try {
            const r = JSON.parse(line);
            if (r?.type !== "entry") continue;
            const f = this.abs(String(r.file));
            let set = byFile.get(f);
            if (!set) byFile.set(f, (set = new Set()));
            set.add(String(r.id));
          } catch {
            /* torn */
          }
        }
      }
    }
    let set = byFile.get(file);
    if (!set) byFile.set(file, (set = new Set()));
    return set;
  }

  /** Every session file this conversation's feed points into (SearchHistory reads them). */
  sessionFilesOf(conv: string): string[] {
    this.pointedIn(conv, "");
    return [...(this.pointed.get(conv)?.keys() ?? [])].filter(Boolean);
  }

  /** This conversation's own pi-format session file (for what no pi writes). */
  ownSession(conv: string): string {
    return join(this.sessionsDir, `${fileStem(conv)}.jsonl`);
  }

  private checkpoint(c: Conv): void {
    const ck = c.file.replace(/\.jsonl$/, ".ckpt.json");
    try {
      writeFileSync(ck + ".tmp", JSON.stringify({ v: 2, rv: REDUCER_VERSION, seq: c.picture.seq, picture: c.picture }));
      renameRetry(ck + ".tmp", ck);
      c.sinceCkpt = 0;
    } catch (e) {
      console.warn("[convlog] checkpoint failed:", (e as Error).message);
    }
  }

  /** Called for every record, after it is written. */
  onRecord(fn: (r: LogRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------------------------------------------------------------- reading

  latest(): number {
    return this.last;
  }

  /** In the log (or an older file the importer can bring in). */
  has(id: string): boolean {
    return this.convs.has(id) || this.legacyRows.has(id) || !!this.picture(id);
  }

  /** A conversation's picture; an older file is imported first. Null: unknown. */
  picture(id: string): Picture | null {
    const c = this.convs.get(id);
    if (c) return c.picture;
    // An older file, listed or one that arrived since (the importer reads it fresh).
    if (!this.legacy) return null;
    this.importLegacy(id);
    return this.convs.get(id)?.picture ?? null;
  }

  private importLegacy(id: string): void {
    const recs = this.legacy?.records(id, this.sessionsDir);
    this.legacyRows.delete(id);
    if (!recs?.length) return;
    const at = this.legacy!.at(id);
    for (const b of recs) this.emit(id, b, at);
    const c = this.convs.get(id);
    if (c) this.checkpoint(c);
  }

  /** Every conversation's list row (older files included, not imported yet). */
  rows(): RowState[] {
    // An older conversation file that appeared since (the folder changed): listed too.
    if (this.legacyStamp() !== this.legacyAt) this.refreshLegacy();
    const out: RowState[] = [...this.legacyRows.values()];
    for (const c of this.convs.values()) if (c.picture.exists) out.push(c.row);
    return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  ids(): string[] {
    return [...this.convs.keys()];
  }

  /** One conversation's records after `after` (all of them from 0). */
  eventsOf(id: string, after = 0): LogRecord[] {
    if (!this.convs.has(id)) this.picture(id);
    const c = this.convs.get(id);
    if (!c) return [];
    // The recent tail in memory covers it when it reaches back far enough.
    const r0 = this.recent[0]?.seq ?? Infinity;
    if (after >= r0 - 1) return this.recent.filter((r) => r.conv === id && r.seq > after);
    return readRecords(c.file, after, this.resolve);
  }

  /** Exactly the records after `after`, in seq order (at most POLL_LIMIT; `more` when there are others). */
  after(after: number, limit = POLL_LIMIT): PollAnswer {
    const latest = this.latest();
    if (after > latest) return { next: latest, events: [], reset: true };
    if (after === latest) return { next: latest, events: [] };
    const r0 = this.recent[0]?.seq ?? Infinity;
    let events: LogRecord[];
    if (after >= r0 - 1) {
      // Fast path: the tail in memory holds everything after `after`.
      let lo = 0;
      let hi = this.recent.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.recent[mid]!.seq <= after) lo = mid + 1;
        else hi = mid;
      }
      events = this.recent.slice(lo, lo + limit + 1);
    } else {
      // Older than the tail: from the files (every file holding a record after `after`).
      const all: LogRecord[] = [];
      for (const c of this.convs.values()) if (c.maxSeq > after) all.push(...readRecords(c.file, after, this.resolve));
      if (this.signalsMax > after) all.push(...readRecords(this.signalsFile, after));
      all.sort((a, b) => a.seq - b.seq);
      events = all.slice(0, limit + 1);
    }
    const more = events.length > limit;
    if (more) events = events.slice(0, limit);
    const next = events.length ? events[events.length - 1]!.seq : latest;
    return { next: more ? next : Math.max(next, latest), events, ...(more ? { more: true } : {}) };
  }

  /** Resolve when a record is written or after `ms`. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      t.unref?.();
      this.waiters.add(done);
    });
  }

  /** The legacy list was changed by someone else (a conversation file the sync brought). */
  rescanLegacy(): void {
    this.refreshLegacy();
  }

  /** Tests: the checkpoint as written (seq + picture). */
  checkpointOf(id: string): { seq: number; picture: Picture } | null {
    const c = this.convs.get(id);
    if (!c) return null;
    try {
      const v = JSON.parse(readFileSync(c.file.replace(/\.jsonl$/, ".ckpt.json"), "utf8"));
      return { seq: v.seq, picture: v.picture };
    } catch {
      return null;
    }
  }

  /** Tests: force a checkpoint now. */
  checkpointNow(id: string): void {
    const c = this.convs.get(id);
    if (c) this.checkpoint(c);
  }

  existsOnDisk(id: string): boolean {
    return existsSync(join(this.dir, `${fileStem(id)}.jsonl`));
  }
}

// ---------------------------------------------------------------- one log per vault, one feed for the box

const logs = new Map<string, ConvLog>();
let legacyFor: ((vault: string) => LegacySource | null) | null = null;
let shared: SeqClock | null = null;
let sharedFloorFile: string | null = null;

/** The importer for older conversation files (set once at boot; tests may leave it unset). */
export function setLegacySource(fn: (vault: string) => LegacySource | null): void {
  legacyFor = fn;
}

/**
 * Every log opened after this takes its seqs from one clock (its floor persisted in `floorFile`), so the global feed
 * over all of them is one sequence. Set at boot, before any log is opened. null: each log its own clock (tests).
 */
export function setSharedClock(floorFile: string | null): void {
  sharedFloorFile = floorFile;
  shared = null;
  if (!floorFile) return;
  let floor = 0;
  try {
    floor = Number(readFileSync(floorFile, "utf8").trim()) || 0;
  } catch {
    floor = 0;
  }
  shared = { next: floor + 1, floorFile, floor };
}

/** A vault's own log: its conversations and its signals. The engines write here; the clients read the global feed. */
export function convLog(vault: string): ConvLog {
  let l = logs.get(vault);
  if (!l) {
    l = new ConvLog(vault, legacyFor?.(vault) ?? null, undefined, shared ?? undefined);
    logs.set(vault, l);
  }
  return l;
}

/** Tests: forget the open logs (a restart). */
export function _resetConvLogs(): void {
  logs.clear();
  feed = null;
  if (sharedFloorFile) setSharedClock(sharedFloorFile);
}

/** Main's id (src/threads.ts MAIN_ID): one conversation for the whole box, the main vault's. */
const MAIN = "main";

/** Signals about conversations: every surface hears them whatever vault it has open. Every other signal (a file or
 *  the vault changed, the inbox, a Show) is about one vault's files and reaches only the surfaces on that vault. */
const CONVERSATION_SIGNALS = new Set(["follow", "project", "notif"]);

/**
 * The box's conversations, whatever vault is open (Carl, 2026-10-29: "conversations never change when the workspace
 * changes"): one feed over every vault's log. Main is the main vault's (another vault's old Main is never shown);
 * every other conversation is the one log that holds it. One sequence (the logs share a clock), so /poll?after=N is
 * exact across all of them. Writing stays each engine's, into its own log. `here`: the open vault, whose own
 * signals this view carries too.
 */
export class GlobalFeed {
  constructor(
    private main: () => ConvLog,
    private all: () => ConvLog[],
    private here: () => ConvLog = main,
  ) {}
  private logs(): ConvLog[] {
    const m = this.main();
    const h = this.here();
    return [...new Set([m, h, ...this.all()])];
  }
  /** A row of `log` this feed shows: everything but another vault's old Main. */
  private shows(log: ConvLog, conv: string | null): boolean {
    return conv !== MAIN || log === this.main();
  }
  /** A record of `log` this feed shows: its conversations' (as above); its signals when it is the open vault's, or
   *  when they are about conversations. */
  private carries(log: ConvLog, r: LogRecord): boolean {
    if (r.conv !== null) return this.shows(log, r.conv);
    if (log === this.here()) return true;
    const t = (r as { signal?: { type?: unknown } }).signal?.type;
    return typeof t === "string" && CONVERSATION_SIGNALS.has(t);
  }
  /** The log holding conversation `id` (Main: the main vault's), or null. */
  owner(id: string): ConvLog | null {
    if (id === MAIN) return this.main();
    for (const l of this.logs()) if (l.has(id)) return l;
    return null;
  }
  get vault(): string {
    return this.main().vault;
  }
  /** Every log's identity: a cursor from one vault's log alone (before the feed was one) starts over. */
  get epoch(): string {
    const ls = this.logs();
    return ls.length === 1 ? ls[0]!.epoch : `g.${ls.map((l) => l.epoch).join(".")}`;
  }
  latest(): number {
    return Math.max(0, ...this.logs().map((l) => l.latest()));
  }
  has(id: string): boolean {
    return !!this.owner(id);
  }
  picture(id: string): Picture | null {
    return this.owner(id)?.picture(id) ?? null;
  }
  rows(): RowState[] {
    const out: RowState[] = [];
    const seen = new Set<string>();
    for (const l of this.logs())
      for (const r of l.rows()) {
        if (!this.shows(l, r.id) || seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
    return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }
  eventsOf(id: string, after = 0): LogRecord[] {
    return this.owner(id)?.eventsOf(id, after) ?? [];
  }
  /** Exactly the records after `after` across every log, in seq order (see ConvLog.after). */
  after(after: number, limit = POLL_LIMIT): PollAnswer {
    const latest = this.latest();
    if (after > latest) return { next: latest, events: [], reset: true };
    if (after === latest) return { next: latest, events: [] };
    let cut = Infinity;
    let all: LogRecord[] = [];
    for (const l of this.logs()) {
      if (after >= l.latest()) continue;
      const a = l.after(after, limit);
      // A log cut short (`more`) is complete only up to its last record: nothing past that goes out yet.
      if (a.more) cut = Math.min(cut, a.events[a.events.length - 1]?.seq ?? after);
      all = all.concat(a.events.filter((r) => this.carries(l, r)));
    }
    let events = all.filter((r) => r.seq <= cut).sort((a, b) => a.seq - b.seq);
    let more = cut !== Infinity;
    if (events.length > limit) {
      events = events.slice(0, limit);
      more = true;
    }
    if (!more) return { next: latest, events };
    const next = events.length ? events[events.length - 1]!.seq : Math.min(cut, latest);
    return { next, events, more: true };
  }
  wait(ms: number): Promise<void> {
    return Promise.race(this.logs().map((l) => l.wait(ms)));
  }
}

let feed: { main: string; vaults: () => string[]; views: Map<string, GlobalFeed> } | null = null;

/** The box's vaults (the main one first), set at boot: the global feed reads all of their logs. */
export function setFeedVaults(main: string, vaults: () => string[]): void {
  feed = { main, vaults, views: new Map() };
}

/** The feed the clients read on `vault`: every vault's conversations (setFeedVaults) and `vault`'s own signals;
 *  without setFeedVaults, `vault`'s own log. */
export function globalFeed(vault: string): GlobalFeed | ConvLog {
  if (!feed) return convLog(vault);
  const f = feed;
  let v = f.views.get(vault);
  if (!v) {
    v = new GlobalFeed(
      () => convLog(f.main),
      () => [...new Set([f.main, ...f.vaults()])].map((x) => convLog(x)),
      () => convLog(vault),
    );
    f.views.set(vault, v);
  }
  return v;
}

/** The vault whose log holds conversation `id` (Main: the main vault), or null when none does. Without
 *  setFeedVaults: `fallback` when its log has it. */
export function ownerVault(id: string, fallback: string): string | null {
  if (!feed) return convLog(fallback).has(id) ? fallback : null;
  if (id === MAIN) return feed.main;
  for (const v of [...new Set([feed.main, ...feed.vaults()])]) if (convLog(v).has(id)) return v;
  return null;
}

/** A vault-level signal on /poll (the vault changed, a file changed, the inbox, notifications, a project). */
export function signal(vault: string, ev: Record<string, unknown>): void {
  try {
    convLog(vault).emit(null, { type: "signal", signal: ev });
  } catch (e) {
    console.warn("[convlog] signal failed:", (e as Error).message);
  }
}
