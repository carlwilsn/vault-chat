// Settings → Box on the laptop, against the real server: health names the
// box, POST /api/v1/vaults creates a vault's own repos (strict names,
// idempotent) and serves them over /git, POST /api/v1/keys stores the box's
// own OpenRouter key in its key store. Every mutation is auth-gated.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Decrypter } from "age-encryption";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, sh, git, waitFor, type Running } from "./helpers";

describe("box setup routes", () => {
  let home: string;
  let secrets: string;
  let srv: Running;

  beforeAll(async () => {
    home = tmp("vcbox-");
    const vault = makeVault(join(home, "school2"));
    const bare = join(home, "school2.git");
    sh(home, "git", ["init", "--bare", "-q", "-b", "master", bare]);
    secrets = await makeKeyStore(join(home, "secrets"), { "api.anthropic": "sk-ant-canary" });
    srv = await startServer({ home, vault, bare, secrets, extra: { VC_SYNC_INTERVAL_MS: "600000" } });
  });

  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
    await srv?.stop();
    cleanup(home);
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(srv.base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const stranger = { "x-forwarded-for": "100.64.0.9", "tailscale-user-login": "mallory@example.com" };

  it("health says it is a vault-chat server, its name, and that it has no key yet", async () => {
    const h = await (await fetch(`${srv.base}/api/v1/health`)).json();
    expect(h.app).toBe("vault-chat-server");
    expect(typeof h.name).toBe("string");
    expect(h.name.length).toBeGreaterThan(0);
    expect(h.hasKey).toBe(false);
  });

  it("the phone needs no token through tailscale serve: its Tailscale login is enough", async () => {
    const carl = { "x-forwarded-for": "100.64.0.9", "tailscale-user-login": "carwilson0929@gmail.com" };
    for (const path of ["/phone", "/status", "/conversations", "/notifications", "/poll?after=latest"]) {
      expect((await fetch(srv.base + path, { headers: carl })).status, path).toBe(200);
    }
    expect((await fetch(srv.base + "/conversations", { headers: stranger })).status).toBe(401);
  });

  it("refuses bad vault names", async () => {
    for (const name of ["", "..", ".git", "../x", "a/b", "a\\b", "x.git", "has space", "x".repeat(65), 7]) {
      const r = await post("/api/v1/vaults", { name });
      expect(r.status, JSON.stringify(name)).toBe(400);
    }
  });

  it("mutations need auth", async () => {
    expect((await post("/api/v1/vaults", { name: "physics" }, stranger)).status).toBe(401);
    expect((await post("/api/v1/keys", { keys: { "api.openrouter": "sk-or-x" } }, stranger)).status).toBe(401);
    expect(existsSync(join(home, "physics.git"))).toBe(false);
  });

  it("creates a vault's bare repo and its working copy on box, idempotently, and lists it", async () => {
    const r = await (await post("/api/v1/vaults", { name: "physics" })).json();
    expect(r).toMatchObject({ ok: true, name: "physics", created: true });
    expect(existsSync(join(home, "physics.git", "HEAD"))).toBe(true);
    expect(existsSync(join(home, "physics.git", "hooks", "pre-receive"))).toBe(true);
    expect(sh(join(home, "physics"), "git", ["symbolic-ref", "--short", "HEAD"]).trim()).toBe("box");
    const again = await (await post("/api/v1/vaults", { name: "physics" })).json();
    expect(again).toMatchObject({ ok: true, created: false });
    const list = await (await fetch(`${srv.base}/api/v1/vaults`)).json();
    expect(list.vaults.map((v: { name: string }) => v.name)).toEqual(["school2", "physics"]);
    expect(list.vaults[0].main).toBe(true);
  });

  it("the new vault takes the laptop's first push of master, and box starts from it", async () => {
    const laptop = join(home, "laptop-physics");
    sh(home, "git", ["init", "-q", "-b", "master", laptop]);
    git(laptop, "commit", "-q", "--allow-empty", "-m", "first");
    git(laptop, "push", "-q", `${srv.base}/git/physics.git`, "master:master");
    const master = git(laptop, "rev-parse", "HEAD").trim();
    await waitFor(() => {
      try {
        return sh(join(home, "physics.git"), "git", ["rev-parse", "refs/heads/box"]).trim() === master;
      } catch {
        return false;
      }
    }, 30_000);
    // box stays the box's: it cannot be pushed over /git.
    git(laptop, "commit", "-q", "--allow-empty", "-m", "second");
    expect(() => git(laptop, "push", "-q", `${srv.base}/git/physics.git`, "master:box")).toThrow(/written only by the box/);
  });

  it("an unknown vault is 404 over /git", async () => {
    expect((await fetch(`${srv.base}/git/nope.git/info/refs?service=git-upload-pack`)).status).toBe(404);
  });

  const storeOnDisk = async () => {
    const d = new Decrypter();
    d.addPassphrase(readFileSync(join(secrets, "fallback.key"), "utf8").trim());
    return JSON.parse(await d.decrypt(Buffer.from(readFileSync(join(secrets, "secrets.age"), "utf8").trim(), "base64"), "text"));
  };

  it("takes the laptop's whole keychain as the box's keys, never echoing a value", async () => {
    for (const bad of [{}, { keys: [] }, { keys: { "../x": "v" } }, { keys: { "api.openrouter": "" } }, { keys: { nope: "v" } }]) {
      expect((await post("/api/v1/keys", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const keys = { "api.openrouter": "sk-or-canary-from-laptop", "service.elevenlabs": "el-canary", "service.tavily": "tvly-canary", "user.lambda_api_key": "lambda-canary" };
    const r = await post("/api/v1/keys", { keys });
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ ok: true, changed: true });
    for (const v of Object.values(keys)) {
      expect(body).not.toContain(v);
      expect(srv.logs()).not.toContain(v);
    }
    const h = await (await fetch(`${srv.base}/api/v1/health`)).json();
    expect(h.hasKey).toBe(true);
    expect(h.keyNames).toEqual(Object.keys(keys).sort());
    expect(JSON.stringify(h)).not.toContain("canary");
    // The laptop is the source: the box's own earlier key is gone.
    expect(await storeOnDisk()).toEqual(keys);
    // The same set again changes nothing.
    expect(await (await post("/api/v1/keys", { keys })).json()).toMatchObject({ changed: false });
  });

  it("a key removed on the laptop is removed on the box", async () => {
    const keys = { "api.openrouter": "sk-or-canary-from-laptop", "service.elevenlabs": "el-canary" };
    expect(await (await post("/api/v1/keys", { keys })).json()).toMatchObject({ changed: true });
    expect(await storeOnDisk()).toEqual(keys);
    expect((await (await fetch(`${srv.base}/api/v1/health`)).json()).keyNames).toEqual(["api.openrouter", "service.elevenlabs"]);
  });
});

describe("box setup with no key store", () => {
  it("creates the store on the first key", async () => {
    const home = tmp("vcbox2-");
    const vault = makeVault(join(home, "vault"));
    const secrets = join(home, "secrets");
    const srv = await startServer({ home, vault, secrets });
    try {
      const r = await fetch(`${srv.base}/api/v1/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: { "api.openrouter": "sk-or-canary-2" } }),
      });
      expect(r.status).toBe(200);
      expect(existsSync(join(secrets, "secrets.age"))).toBe(true);
      expect((await (await fetch(`${srv.base}/api/v1/health`)).json()).hasKey).toBe(true);
    } finally {
      await srv.stop();
      cleanup(home);
    }
  });
});
