/** Read-only compatibility data, NEVER acceptance/rollback authority. Old receipt signatures,
 * permits and request validators are deliberately not interpreted. Only public counts/media leave here. */
import { lstatSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { CHANGE_GATES, type ChangeGate } from "./shipGates";
import type { AcceptedChange } from "./changeShipping";

type PublicGate = { gate: ChangeGate; exitCode: number; complete: boolean; passed: number; failed: number };
export type HistoricalProof = { gates: { baseline: PublicGate[]; candidate: PublicGate[] }; ui?: { assertions: number; frames: number }; media: { name: string; bytes: Buffer }[] };
const record = (x: unknown): Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
const count = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
/** Reject every link component, including dangling redirects, before reading a historical file. */
function plain(path: string, directory = false): boolean {
  if (!isAbsolute(path) || resolve(path) !== path) return false;
  let current = parse(path).root;
  const components = resolve(path).slice(current.length).split(sep);
  for (const [i, component] of components.entries()) {
    current = join(current, component);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || (i < components.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) return false;
  }
  return true;
}
export function readHistoricalProof(c: AcceptedChange): HistoricalProof {
  const out: HistoricalProof = { gates: { baseline: [], candidate: [] }, media: [] };
  if (!plain(c.proofDir, true)) return out;
  const media = (path: unknown, hash: unknown, name: string) => {
    if (typeof path !== "string" || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return;
    const rel = relative(resolve(c.proofDir), resolve(path));
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !plain(path)) return;
    const bytes = readFileSync(path);
    if (createHash("sha256").update(bytes).digest("hex") === hash) out.media.push({ name, bytes });
  };
  try {
    const file = join(c.proofDir, "receipt.json");
    if (plain(file)) {
      const r = record(JSON.parse(readFileSync(file, "utf8"))), source = record(r.source), ui = record(r.ui);
      // Match historical DATA to this card, not a permit or source acceptance decision.
      if (r.id === c.id && source.head === c.source.head && source.tree === c.source.tree) {
        for (const side of ["baseline", "candidate"] as const) {
          if (!Array.isArray(r[side])) continue;
          for (const raw of r[side]) {
            const g = record(raw);
            if (!CHANGE_GATES.includes(g.gate as ChangeGate) || !Number.isInteger(g.exitCode) || typeof g.complete !== "boolean") continue;
            const tests = Array.isArray(g.tests) ? g.tests.map(record) : [];
            out.gates[side].push({ gate: g.gate as ChangeGate, exitCode: g.exitCode as number, complete: g.complete,
              passed: tests.filter(t => t.status === "passed").length, failed: tests.filter(t => t.status === "failed").length });
          }
        }
        if (count(ui.assertions) && count(ui.frames)) out.ui = { assertions: ui.assertions, frames: ui.frames };
        const ext = typeof ui.artifact === "string" ? extname(ui.artifact).toLowerCase() : "";
        if ([".png", ".mp4", ".webm"].includes(ext)) media(ui.artifact, ui.artifactHash, `recording${ext}`);
      }
    }
    // Original public legacy-media schema. No bootstrap import, signature or pinned-ID authority.
    const bootstrap = record((c as unknown as Record<string, unknown>).bootstrap);
    if (Array.isArray(bootstrap.media)) for (const [i, raw] of bootstrap.media.entries()) {
      const m = record(raw);
      if (typeof m.name !== "string" || !/^[^/\\]+\.(?:png|jpe?g|webp|mp4|webm)$/i.test(m.name)) continue;
      media(join(c.proofDir, m.name), m.hash, `legacy-${i + 1}${extname(m.name).toLowerCase()}`);
    }
  } catch { /* Malformed/unavailable old evidence must not make a readable history card disappear. */ }
  return out;
}
