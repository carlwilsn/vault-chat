/** OFFLINE COPY ONLY. Never opens a vault or installs/replaces an event file.
 * Low-level transformer receives a freshly verified external backup identity (hash and size).
 * Ordinary dynamic backup-first entry point: scripts/offline-event-log.ts.
 * Streams bounded lines; preserves every logical record (incl. seq/gaps, pointers and live
 * reasoning/tool history). Only repeated worker snapshots become explicit disk deltas.
 * Reading native session pointers is optional via eventsDir; no event source is ever replaced.
 * Live use requires installed compatible readers/fallback + maintainer-owned writer exclusion.
 */
import { constants as bufferConstants } from "node:buffer";
import { open, mkdir, realpath, stat, access } from "node:fs/promises";
import { resolve, join, dirname, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compactSubagents, emptyPicture, expandSubagents, reduce, type Picture } from "../src/convlog/reduce.ts";
import { homedir } from "node:os";
import { OfflineFold, type Reference } from "./event-log-offline-fold.ts";
import { MAX_RECORD_BYTES } from "../server/convlog/reader.ts";
import { digest, identity as stamp, same, lines, parseRecord, writeAll } from "./event-log-stream.ts";
import type { StoredRecord } from "../src/convlog/protocol.ts";

async function external(path: string): Promise<boolean> {
  if (path.split(sep).includes(".vault-chat")) return false;
  // Also refuse output at a vault's ROOT (not just its hidden event directory).
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    try {
      const marker = join(parent, ".vault-chat");
      // Global app state does not make the entire HOME directory a vault.
      if (marker !== join(homedir(), ".vault-chat")) { await access(marker); return false; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(parent) === parent) return true;
  }
}

// Metadata projection only, using the EXISTING reducer, not a message/history mirror.
function unfold(previous: Picture | undefined, stored: StoredRecord) {
  if (!stored || typeof stored !== "object" || typeof stored.conv !== "string" || !stored.conv ||
      !Number.isSafeInteger(stored.seq) || stored.seq < 1 || !Number.isFinite(stored.at) ||
      !["meta", "subagents", "entry", "live"].includes(stored.type)) throw new Error("Invalid conversation record");
  const p = previous ?? emptyPicture(stored.conv);
  if (stored.conv !== p.id || stored.seq <= p.seq) throw new Error("Conversation/sequence mismatch");
  if (stored.type === "meta" && (!stored.patch || typeof stored.patch !== "object" || Array.isArray(stored.patch))) throw new Error("Invalid metadata patch");
  const logical = stored.type === "subagents" ? expandSubagents(p, stored) : stored;
  const next = logical.type === "meta" ? reduce(p, logical) : { ...p, seq: logical.seq };
  return { before: p, logical, next };
}
export async function compactOffline(options: { input: string; outDir: string; sha256: string; bytes: number; eventsDir?: string; strictNative?: boolean; reference?: Reference }) {
  if (!/^[0-9a-f]{64}$/.test(options.sha256) || !Number.isSafeInteger(options.bytes) || options.bytes < 1) throw new Error("Exact backup hash and positive byte count required");
  const input = await realpath(options.input);
  const parent = await realpath(dirname(resolve(options.outDir)));
  const outDir = join(parent, resolve(options.outDir).split(sep).at(-1)!);
  if (!await external(input) || !await external(outDir)) throw new Error("Offline only: .vault-chat paths forbidden");
  const full = new OfflineFold(options.eventsDir ?? dirname(input), options.strictNative ?? false, options.reference);
  const verify = new OfflineFold(options.eventsDir ?? dirname(input), options.strictNative ?? false);
  const source = await open(input, "r");
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const initial = await source.stat();
    if (!initial.isFile() || initial.size !== options.bytes || initial.nlink !== 1) throw new Error("Backup must be a regular single-link file of pinned size");
    await mkdir(outDir, { mode: 0o700 }); // exclusive new directory, never reuse an output
    const outputPath = join(outDir, "compacted.jsonl");
    output = await open(outputPath, "wx", 0o600);
    const raw = digest(), logicalHash = digest();
    let picture: Picture | undefined, fullPicture: Picture | undefined, records = 0, changed = 0, bytes = 0, firstSeq: number | undefined;
    for await (const line of lines(source, initial.size, raw, bufferConstants.MAX_STRING_LENGTH)) {
      let stored: StoredRecord;
      try { stored = parseRecord(line); } catch { throw new Error("Invalid/blank JSON record; refusing to discard history"); }
      const { before, logical, next } = unfold(picture, stored);
      picture = next;
      full.add(stored);
      fullPicture = full.picture;
      logicalHash.update(JSON.stringify(logical) + "\n");
      const compact = compactSubagents(before, logical);
      // Non-worker records and existing deltas are kept BYTE FOR BYTE where unchanged.
      const encoded = compact === logical && stored.type !== "subagents" ? line : Buffer.from(JSON.stringify(compact) + "\n");
      if (encoded.length - 1 > MAX_RECORD_BYTES) throw new Error("candidate-record-exceeds-runtime-8MiB-limit");
      if (!encoded.equals(line)) changed++;
      await writeAll(output, encoded);
      bytes += encoded.length;
      records++;
      firstSeq ??= logical.seq;
    }
    if (raw.digest("hex") !== options.sha256) throw new Error("Verified backup SHA-256 mismatch");
    if (!same(stamp(initial), stamp(await source.stat())) || !same(stamp(initial), stamp(await stat(input)))) throw new Error("Backup changed during transformation");
    await output.sync();
    await output.close(); output = undefined;
    const logicalSha256 = logicalHash.digest("hex");
    full.verify();
    const check = await open(outputPath, "r");
    const outHash = digest(), replayHash = digest();
    let replay: Picture | undefined, fullReplay: Picture | undefined, count = 0;
    const outputIdentity = stamp(await check.stat());
    try {
      if (outputIdentity.size !== bytes) throw new Error("Output size mismatch");
      for await (const line of lines(check, bytes, outHash)) {
        const expanded = unfold(replay, parseRecord(line));
        replay = expanded.next;
        verify.add(parseRecord(line));
        fullReplay = verify.picture;
        replayHash.update(JSON.stringify(expanded.logical) + "\n");
        count++;
      }
      if (!same(outputIdentity, stamp(await check.stat())) || !same(outputIdentity, stamp(await stat(outputPath)))) throw new Error("Output changed during verification");
    } finally { await check.close(); }
    if (count !== records || replayHash.digest("hex") !== logicalSha256 || !same(replay, picture) || !same(fullReplay, fullPicture)) throw new Error("Logical record replay/readback mismatch");
    full.verify(); verify.verify();
    if (!same(stamp(initial), stamp(await source.stat())) || !same(stamp(initial), stamp(await stat(input)))) throw new Error("Backup changed during verification");
    const manifest = { format: "offline-worker-delta-copy-v1", verified: true,
      input: { path: input, bytes: initial.size, sha256: options.sha256 },
      output: { path: outputPath, bytes, sha256: outHash.digest("hex") },
      nativeFiles: full.nativeFiles, canonicalEventsDir: options.eventsDir ?? dirname(input),
      pointed: full.pointed,
      foldSha256: digest().update(JSON.stringify(fullPicture)).digest("hex"), foldVerified: true,
      records, changedRecords: changed, firstSeq, lastSeq: picture?.seq, logicalSha256,
      source: process.env.VC_OFFLINE_SOURCE_PIN ?? "unrecorded", requiresInstalledDeltaReaderAndFallback: true,
      installed: false, liveWriterQuiesced: false };
    const mf = await open(join(outDir, "manifest.json"), "wx", 0o600);
    try { await mf.writeFile(JSON.stringify(manifest, null, 2) + "\n"); await mf.sync(); } finally { await mf.close(); }
    const dir = await open(outDir, "r");
    try { await dir.sync(); } finally { await dir.close(); }
    return { ...manifest, picture: fullPicture! };
  } finally { full.close(); verify.close(); await output?.close(); await source.close(); }
}

async function main() {
  const [input, outDir, sha256, byteArg, pin] = process.argv.slice(2);
  if (!input || !outDir || !sha256 || !byteArg || !pin || process.argv.length !== 7 || !/^[0-9a-f]{40}$/.test(pin))
    throw new Error("Usage: node --import tsx scripts/compact-event-log-offline.ts EXTERNAL_BACKUP NEW_EXTERNAL_OUTDIR SHA256 BYTES EXACT_SOURCE_HEAD");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== pin || git("status", "--porcelain", "--untracked-files=no")) throw new Error("Exact committed clean source pin required");
  process.env.VC_OFFLINE_SOURCE_PIN = pin;
  const manifest = await compactOffline({ input, outDir, sha256, bytes: Number(byteArg) });
  // Only structural evidence, never user prompts/record contents.
  const { picture: _picture, ...structural } = manifest;
  console.log(JSON.stringify(structural, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error("Offline compaction FAILED. Input/live files untouched; this run did not complete and its output is NOT authorized for installation.");
  process.exitCode = 1;
});
