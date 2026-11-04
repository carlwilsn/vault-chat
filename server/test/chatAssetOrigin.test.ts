// Real HTTP, real conversation ownership; synthetic bytes only, no engine/model.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { freePort } from "./helpers";
import { convLog, setFeedVaults, _resetConvLogs } from "../convlog/log";
import { startHttpServer, type VaultScope } from "../http";

// Unused bundled shell assets only: no route, ownership, filesystem or auth mocks.
vi.mock("../../src-tauri/assets/phone.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/voice.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/icon-apple-touch.png", () => ({ default: "" }));
vi.mock("vc:phone-app", () => ({ default: {} }));
vi.mock("vc:board-app", () => ({ default: {} }));

describe("chat media follows its existing log owner, not the viewer or project name", () => {
  const home = mkdtempSync(join(tmpdir(), "vc-origin-"));
  // Deliberately non-semantic registration names; project-physics belongs to A.
  const A: VaultScope = { name: "backend-a", path: join(home, "a"), bare: "", main: true };
  const B: VaultScope = { name: "backend-b", path: join(home, "b"), bare: "", main: false };
  const rel = ".vault-chat/visuals/same.mp4";
  let srv: Server | undefined;
  let voice: Server | undefined;
  let base: string;
  beforeAll(async () => {
    for (const v of [A, B]) {
      mkdirSync(join(v.path, ".vault-chat/visuals"), { recursive: true });
      writeFileSync(join(v.path, rel), v === A ? "OWNER-A" : "VIEWER-B");
    }
    writeFileSync(join(home, "outside"), "OUTSIDE");
    symlinkSync(join(home, "outside"), join(A.path, ".vault-chat/visuals/escape.mp4"));
    _resetConvLogs();
    setFeedVaults(A.path, () => [A.path, B.path]);
    convLog(A.path).emit("project-physics", { type: "meta", patch: { title: "Physics", createdAt: 1 } });
    convLog(B.path).emit("other-chat", { type: "meta", patch: { title: "Other", createdAt: 1 } });
    voice = createServer((_req, res) => { res.writeHead(503); res.end(); });
    await new Promise<void>(resolve => voice!.listen(0, "127.0.0.1", resolve));
    const voicePort = String((voice.address() as { port: number }).port);
    vi.stubEnv("VC_HOST", "127.0.0.1");
    vi.stubEnv("VC_PORT", String(await freePort()));
    vi.stubEnv("VC_VOICE_PORT", voicePort);
    vi.stubEnv("VC_VOICE_PIPELINE_PORT", voicePort);
    vi.stubEnv("VC_VOICE_PIPELINE", "off");
    vi.stubEnv("VC_VAULT", A.path);
    vi.stubEnv("VC_TOKEN_FILE", join(home, "absent-fixture-token"));
    srv = await startHttpServer({
      health: async () => ({}), syncStatus: () => ({}), alert: async () => 0, onGitPushed: () => {},
      vault: name => !name ? A : [A, B].find(v => v.name === name) ?? null,
      vaultList: () => [A, B],
    });
    base = `http://127.0.0.1:${(srv.address() as {port:number}).port}`;
  });
  afterAll(async () => {
    if (srv) await new Promise<void>(resolve => srv!.close(() => resolve()));
    if (voice) await new Promise<void>(resolve => voice!.close(() => resolve()));
    setFeedVaults(A.path, () => [A.path]);
    _resetConvLogs();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  const get = (p = rel, conv: string | null = "project-physics", vault = B.name, headers = {}) => {
    const q = new URLSearchParams({ path: p, vault, ...(conv === null ? {} : { convId: conv }) });
    return fetch(`${base}/api/v1/vault/file?${q}`, { headers });
  };
  const bytes = async (r: Response) => Buffer.from((await r.json()).base64, "base64").toString();
  it("same basename in both vaults: owner A bytes while viewing B, including replay", async () => {
    for (const viewer of [B.name, A.name, B.name]) expect(await bytes(await get(rel, "project-physics", viewer))).toBe("OWNER-A");
  });
  it("unrelated chats and ordinary viewer file reads keep their own scope", async () => {
    expect(await bytes(await get(rel, "other-chat"))).toBe("VIEWER-B");
    expect(await bytes(await get(rel, null))).toBe("VIEWER-B");
  });
  it("phone raw images use the same owner and retain range/MIME behavior", async () => {
    const q = new URLSearchParams({ path: rel, vault: B.name, convId: "project-physics" });
    const r = await fetch(`${base}/file?${q}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(await r.text()).toBe("OWNER-A");
    const part = await fetch(`${base}/file?${q}`, { headers: { range: "bytes=1-3" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 1-3/7");
    expect(await part.text()).toBe("WNE");
    expect((await fetch(`${base}/file?${q}`, { headers: { range: "bytes=20-" } })).status).toBe(416);
    expect((await fetch(`${base}/file?${q}`, { headers: { "x-forwarded-for": "100.64.0.1" } })).status).toBe(401);
    q.set("convId", "missing");
    expect((await fetch(`${base}/file?${q}`)).status).toBe(404);
  });
  it("does not fallback to a viewer's copy when the owner's file is absent", async () => {
    writeFileSync(join(B.path, ".vault-chat/visuals/viewer-only.mp4"), "WRONG");
    expect((await get(".vault-chat/visuals/viewer-only.mp4")).status).toBe(404);
  });
  it("auth, registered vaults, unknown owner, traversal, symlink and git boundaries remain closed", async () => {
    expect((await get(rel, "project-physics", B.name, { "x-forwarded-for": "100.64.0.1" })).status).toBe(401);
    expect((await get(rel, "project-physics", "unregistered")).status).toBe(404);
    expect((await get(rel, "not-a-chat")).status).toBe(404);
    for (const p of ["../outside", join(B.path, rel), ".git/config", ".vault-chat/visuals/escape.mp4"])
      expect((await get(p)).status).toBe(403);
  });

});
