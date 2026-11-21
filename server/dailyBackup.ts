// A daily backup of what has no other copy: every vault's event log (.vault-chat/events: conversations, signals,
// offer events, session transcripts written there) and the engine's own transcripts (Claude Code's projects folder).
// The sync never carries the event log (it is the box's alone) and GitHub never sees it; before this, the last copy
// was a hand-made one (2026-10-30). Once a day, into <stateDir>/backups/daily/<YYYY-MM-DD>/<label>/: a file unchanged
// since yesterday's copy (same size and mtime) is a hard link to that copy, a changed or new one is copied, so a day
// costs only what changed. The newest KEEP_DAYS days are kept.
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

export const KEEP_DAYS = 14;
export type BackupSource = { label: string; dir: string };
export type BackupReport = { day: string; files: number; copied: number; linked: number; bytesCopied: number; skipped: boolean; error?: string };

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function copyTree(src: string, dst: string, prev: string | null, r: BackupReport): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    let st;
    try {
      st = statSync(s);
    } catch {
      continue;
    }
    const d = join(dst, name);
    const p = prev ? join(prev, name) : null;
    if (st.isDirectory()) {
      copyTree(s, d, p && existsSync(p) ? p : null, r);
      continue;
    }
    if (!st.isFile()) continue;
    r.files++;
    try {
      const ps = p && existsSync(p) ? statSync(p) : null;
      if (ps && ps.size === st.size && Math.trunc(ps.mtimeMs) === Math.trunc(st.mtimeMs)) {
        linkSync(p!, d);
        r.linked++;
      } else {
        copyFileSync(s, d);
        utimesSync(d, st.atime, st.mtime);
        r.copied++;
        r.bytesCopied += st.size;
      }
    } catch {
      /* a file that went away mid-copy: the next day has it */
    }
  }
}

/** Make today's backup unless it exists; drop days past KEEP_DAYS. Never throws. */
export function runDailyBackup(root: string, sources: BackupSource[], now = Date.now()): BackupReport {
  const today = day(now);
  const r: BackupReport = { day: today, files: 0, copied: 0, linked: 0, bytesCopied: 0, skipped: false };
  try {
    mkdirSync(root, { recursive: true });
    const days = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (days.includes(today)) return { ...r, skipped: true };
    const prev = days.length ? join(root, days[days.length - 1]!) : null;
    const tmp = join(root, `.${today}.partial`);
    rmSync(tmp, { recursive: true, force: true });
    for (const s of sources) if (existsSync(s.dir)) copyTree(s.dir, join(tmp, s.label), prev && existsSync(join(prev, s.label)) ? join(prev, s.label) : null, r);
    renameSync(tmp, join(root, today));
    for (const old of [...days, today].sort().slice(0, -KEEP_DAYS)) rmSync(join(root, old), { recursive: true, force: true });
  } catch (e) {
    r.error = (e as Error)?.message ?? String(e);
  }
  return r;
}

/** Check every hour; back up once a day. Returns the stop. */
export function startDailyBackup(stateDir: string, sources: () => BackupSource[], log: (s: string) => void = console.log): () => void {
  const root = join(stateDir, "backups", "daily");
  const tick = () => {
    const r = runDailyBackup(root, sources());
    if (!r.skipped) log(`[backup] ${r.day}: ${r.files} files, ${r.copied} copied (${Math.round(r.bytesCopied / 1e6)} MB), ${r.linked} linked${r.error ? `; error: ${r.error}` : ""}`);
  };
  const first = setTimeout(tick, 5 * 60_000);
  const every = setInterval(tick, 3600_000);
  (first as { unref?: () => void }).unref?.();
  (every as { unref?: () => void }).unref?.();
  return () => (clearTimeout(first), clearInterval(every));
}
