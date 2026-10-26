// A file Carl uses that is built from another (a PDF or a page from its .md / .tex source, same name, same folder):
// when the agent changes the source, the built file must follow. In the voice roleplay "make the second section
// shorter" changed study-sheet.md and left study-sheet.pdf — the file he reads — untouched until he said "rebuild it,
// obviously". This finds such pairs, so the agent is told to rebuild before it says the change is done.
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";

const SOURCE = /\.(md|markdown|tex)$/i;
const BUILT = [".pdf", ".html"];
const SKIP = new Set([".git", ".vault-chat", "node_modules", ".venv", "venv", "__pycache__"]);

/** Built files older than their source, for these sources (vault-relative pairs, "a.md → a.pdf"). */
export function staleBuilt(vault: string, sources: string[]): { source: string; built: string }[] {
  const out: { source: string; built: string }[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    if (!SOURCE.test(src) || seen.has(src)) continue;
    seen.add(src);
    let srcTime: number;
    try {
      srcTime = statSync(src).mtimeMs;
    } catch {
      continue;
    }
    const stem = join(dirname(src), basename(src, extname(src)));
    for (const ext of BUILT) {
      const built = stem + ext;
      if (!existsSync(built)) continue;
      try {
        // A second of slack: a build that wrote the output just before the source's last save is not stale.
        if (statSync(built).mtimeMs + 1000 < srcTime) out.push({ source: rel(vault, src), built: rel(vault, built) });
      } catch {
        /* gone */
      }
    }
  }
  return out;
}

/** Sources in the vault changed since `since` (a worker's edits: its tools run in its own session, not the turn's). */
export function sourcesChangedSince(vault: string, since: number, max = 20_000): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (++seen > max) return;
      if (SKIP.has(n)) continue;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (SOURCE.test(n) && st.mtimeMs >= since) out.push(p);
    }
  };
  walk(vault);
  return out;
}

const rel = (vault: string, p: string) => relative(vault, p).split(sep).join("/");

/** How the rebuild turn's input starts (its own end is not checked again). */
export const REBUILD_MARK = "[Built file out of date";

/** What the agent is told: rebuild, check, then say it is done. */
export function rebuildNote(pairs: { source: string; built: string }[]): string {
  const list = pairs.map((x) => `${x.built} (from ${x.source})`).join(", ");
  return `${REBUILD_MARK}. ${pairs.length === 1 ? "A file he uses is" : "Files he uses are"} now older than the source that changed: ${list}. Rebuild ${pairs.length === 1 ? "it" : "them"} the way ${pairs.length === 1 ? "it was" : "they were"} made, check the result, and only then tell him the change is done — he reads the built file, not the source.]`;
}
