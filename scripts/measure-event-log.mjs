// Read-only, fixed-byte-cut diagnostics; never emits messages, arguments or media bytes.
// Usage: node scripts/measure-event-log.mjs /absolute/path/to/conversation.jsonl
import { open, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const size = (v) => Buffer.byteLength(JSON.stringify(v));
const TYPES = new Set(['meta', 'entry', 'live', 'signal']);
const EVENTS = new Set(['message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end']);
const BLOCKS = new Set(['text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end']);
// Only these schema names can appear in output; user/tool-supplied keys cannot escape.
const FIELDS = new Set('patch subagents task summary prompt path sessionFile said title activity threadId toolCallId model status state agent expect kind ev assistantMessageEvent delta content text arguments result partialResult images dataUrl imageDataUrl data mimeType'.split(' '));
const stamp = (s) => ({ bytes: s.size, inode: s.ino, mtimeMs: s.mtimeMs });
const add = (map, key, bytes) => {
  const v = map[key] ??= { count: 0, bytes: 0 };
  v.count++; v.bytes += bytes;
};

export async function measureEventLog(file, { maxLineBytes = 32 * 1024 * 1024, onCut } = {}) {
  const startedUTC = new Date().toISOString();
  const fd = await open(file, 'r');
  try {
    const initial = await fd.stat();
    const result = { startedUTC, finishedUTC: '', startStat: stamp(initial), endStat: null,
      cutBytes: initial.size, completeLines: 0, invalidLines: 0, oversizedLines: 0, trailingBytes: 0,
      minSeq: null, maxSeq: null, kinds: Object.create(null), stringFields: Object.create(null),
      inlineImageStringChars: 0, subagents: { snapshots: 0, bytes: 0, rows: 0, changedRows: 0, changedRowsBytes: 0, identicalSnapshots: 0, identicalBytes: 0, latestRows: 0 } };
    // Tests can append after capture; that tail must not leak into this cut.
    await onCut?.(initial.size);
    let previous = null;
    const line = (buf) => {
      result.completeLines++;
      let r;
      try { r = JSON.parse(buf.toString('utf8')); }
      catch { result.invalidLines++; return; }
      if (!r || typeof r !== 'object') { result.invalidLines++; return; }
      let kind = TYPES.has(r.type) ? r.type : '<other>';
      if (r.type === 'live') {
        kind += '/' + (EVENTS.has(r.ev?.type) ? r.ev.type : '<other>');
        if (r.ev?.type === 'message_update') kind += '/' + (BLOCKS.has(r.ev.assistantMessageEvent?.type) ? r.ev.assistantMessageEvent.type : '<other>');
      }
      add(result.kinds, kind, buf.length + 1);
      if (Number.isSafeInteger(r.seq)) {
        result.minSeq = result.minSeq === null ? r.seq : Math.min(result.minSeq, r.seq);
        result.maxSeq = result.maxSeq === null ? r.seq : Math.max(result.maxSeq, r.seq);
      }
      const walk = (v, path) => {
        if (Array.isArray(v)) { for (const x of v) walk(x, path + '[]'); }
        else if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            if (typeof x === 'string' && (k === 'dataUrl' || k === 'imageDataUrl' || (k === 'data' && v.type === 'image'))) result.inlineImageStringChars += x.length;
            walk(x, path + '.' + (FIELDS.has(k) ? k : '<other>'));
          }
        } else if (typeof v === 'string') add(result.stringFields, path, size(v));
      };
      walk(r, '$');
      const a = r.type === 'meta' ? r.patch?.subagents : null;
      if (!Array.isArray(a) || !a.every((s) => s && typeof s.threadId === 'string')) return;
      const s = result.subagents, bytes = size(a);
      const old = new Map((previous ?? []).map((row) => [row.threadId, JSON.stringify(row)]));
      const changed = a.filter((row) => old.get(row.threadId) !== JSON.stringify(row));
      s.snapshots++; s.bytes += bytes; s.rows += a.length;
      s.changedRows += changed.length; s.changedRowsBytes += size(changed); s.latestRows = a.length;
      if (previous !== null && JSON.stringify(previous) === JSON.stringify(a)) { s.identicalSnapshots++; s.identicalBytes += bytes; }
      previous = a;
    };
    // Split on LF bytes only (not readline's extra Unicode separators). Bound memory
    // by one record, not by the file. Oversized lines are counted, never parsed.
    let carry = Buffer.alloc(0), dropping = false, pendingBytes = 0;
    if (initial.size) for await (const chunk of fd.createReadStream({ autoClose: false, start: 0, end: initial.size - 1 })) {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) {
        const part = chunk.subarray(start, i);
        pendingBytes += part.length;
        if (dropping || pendingBytes > maxLineBytes) result.oversizedLines++;
        else line(Buffer.concat([carry, part]));
        carry = Buffer.alloc(0); dropping = false; pendingBytes = 0; start = i + 1;
      }
      const tail = chunk.subarray(start);
      pendingBytes += tail.length;
      if (pendingBytes > maxLineBytes) { dropping = true; carry = Buffer.alloc(0); }
      else if (!dropping) carry = Buffer.concat([carry, tail]);
    }
    result.trailingBytes = pendingBytes;
    result.endStat = stamp(await stat(file));
    result.finishedUTC = new Date().toISOString();
    return result;
  } finally { await fd.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/measure-event-log.mjs /absolute/path/to/conversation.jsonl');
  console.log(JSON.stringify(await measureEventLog(process.argv[2]), null, 2));
}
