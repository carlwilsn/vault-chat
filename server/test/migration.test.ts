// Moving a real vault to one main conversation (src/threads.ts), on a COPY of its conversations:
//   VC_MIGRATION_SOURCE=<a vault, e.g. ~/github/school2> npx vitest run --config server/vitest.config.ts server/test/migration.test.ts
// Skipped without it (the data is Carl's, never in the repo). The source is only read: its files are
// hashed before and after. The copy gets the vault's older conversation files and its projects; the
// real bundle (on the fake pi) then has Main and one thread per project, every older chat still
// listed and readable as an older chat (no kind: read-only in the clients), every message Carl wrote
// in it still there, and a message with no conversation goes to Main without touching them.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";
import { fold, shown } from "../../src/convlog/reduce";

const SRC = process.env.VC_MIGRATION_SOURCE ?? "";
let home = "", vault = "";
let or: FakeOpenRouter;
let srv: Running;
const hashes = new Map<string, string>();

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const hashAll = () => new Map(walk(join(SRC, ".vault-chat", "conversations")).concat(walk(join(SRC, "agent-projects"))).map((f) => [f, createHash("sha256").update(readFileSync(f)).digest("hex")]));
const get = async (p: string) => (await fetch(srv.base + p)).json();
async function all(): Promise<any[]> {
  const out: any[] = [];
  let cur = 0;
  for (;;) {
    const r = await get(`/poll?after=${cur}`);
    out.push(...r.events);
    if (!r.events.length || !r.more) return out;
    cur = r.next;
  }
}
/** Carl's own messages in an older conversation file (what must still be there). */
function carlsLines(file: string): string[] {
  const out: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
    try {
      const m = JSON.parse(line);
      if (m?.role === "user" && !m.hidden && !m.system && typeof m.content === "string" && m.content.trim()) out.push(m.content.trim());
    } catch {
      /* a torn line */
    }
  }
  return out;
}

describe.skipIf(!SRC)("one main conversation on a copy of a real vault's conversations", () => {
  let legacyIds: string[] = [];
  let projects: string[] = [];
  beforeAll(async () => {
    for (const [f, h] of hashAll()) hashes.set(f, h);
    home = tmp("vcmig-");
    vault = makeVault(join(home, "vault"));
    cpSync(join(SRC, ".vault-chat", "conversations"), join(vault, ".vault-chat", "conversations"), { recursive: true });
    if (existsSync(join(SRC, "agent-projects"))) cpSync(join(SRC, "agent-projects"), join(vault, "agent-projects"), { recursive: true });
    legacyIds = readdirSync(join(vault, ".vault-chat", "conversations")).filter((n) => n.endsWith(".jsonl")).map((n) => n.replace(/\.jsonl$/, ""));
    projects = existsSync(join(vault, "agent-projects")) ? readdirSync(join(vault, "agent-projects")).filter((n) => existsSync(join(vault, "agent-projects", n, "project.md"))) : [];
    const secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
    or = await fakeOpenRouter("OK.");
    srv = await startServer({ home, vault, secrets, openrouter: or.url });
  }, 180_000);
  afterAll(async () => {
    await srv?.stop();
    await or?.close();
    cleanup(home);
  });

  it("Main and one thread per project; every older chat is still listed, as an older chat (no kind)", async () => {
    const rows = (await get("/api/v2/conversations")).rows as any[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("main")?.kind).toBe("main");
    for (const p of projects) expect(byId.get(`project-${p}`)?.kind, p).toBe("project");
    const deletedBefore = new Set<string>();
    for (const id of legacyIds) {
      const first = JSON.parse(readFileSync(join(vault, ".vault-chat", "conversations", `${id}.jsonl`), "utf8").split("\n")[0] || "{}");
      if (first.deleted) deletedBefore.add(id);
    }
    const listed = legacyIds.filter((id) => byId.has(id));
    expect(listed.length + deletedBefore.size).toBeGreaterThanOrEqual(legacyIds.length);
    for (const id of listed) expect(byId.get(id).kind, id).toBeUndefined();
    console.log(`[migration] ${legacyIds.length} older conversation files, ${listed.length} listed (${deletedBefore.size} deleted before), ${projects.length} projects → ${projects.map((p) => `project-${p}`).join(", ")}`);
  });

  it("every older chat opens with every message Carl wrote in it", async () => {
    let lines = 0;
    for (const id of legacyIds) {
      const want = carlsLines(join(vault, ".vault-chat", "conversations", `${id}.jsonl`));
      const r = await fetch(`${srv.base}/api/v2/conversations/${encodeURIComponent(id)}/checkpoint`);
      if (r.status === 404) {
        expect(want.length, `${id} is gone but had lines`).toBe(0);
        continue;
      }
      const pic = (await r.json()).picture;
      const have = new Set(shown(pic).filter((x: any) => x.kind === "user").map((x: any) => String(x.text ?? "").trim()));
      for (const t of want) expect(have.has(t), `${id}: "${t.slice(0, 40)}"`).toBe(true);
      lines += want.length;
    }
    console.log(`[migration] ${lines} of Carl's lines checked, all present`);
  });

  it("a message with no conversation goes to Main; the older chats are not touched", async () => {
    const before = new Map(((await get("/api/v2/conversations")).rows as any[]).filter((r) => legacyIds.includes(r.id)).map((r) => [r.id, r.seq]));
    const r = await (await fetch(srv.base + "/api/v2/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "send", clientId: "mig-1", text: "first words in Main" }) })).json();
    expect(r.convId).toBe("main");
    await waitFor(async () => !fold((await all()).filter((x) => x.conv === "main"), "main").meta.running, 30_000);
    const after = new Map(((await get("/api/v2/conversations")).rows as any[]).filter((x) => legacyIds.includes(x.id)).map((x) => [x.id, x.seq]));
    for (const [id, seq] of before) expect(after.get(id), id).toBe(seq);
  });

  it("the source vault's files are byte for byte what they were", () => {
    const now = hashAll();
    expect(now.size).toBe(hashes.size);
    for (const [f, h] of hashes) expect(now.get(f), f).toBe(h);
  });
});
