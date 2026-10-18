// GET /api/v1/voice/session mints both credentials with the box's key: a WebRTC
// conversation token (ElevenLabs' recommended transport, the laptop's and the
// board's first choice) and a signed URL (WebSocket: Linux webviews, older
// clients, the fallback). ElevenLabs faked; no request leaves the process.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, git } from "./helpers";

const root = tmp("vct-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
writeFileSync(join(vault, "a.md"), "# A\n");
git(vault, "init", "-q");
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_SECRETS_DIR = join(root, "secrets");

let voice: typeof import("../voice");
let store: any;
const deps = { vault, name: "main", main: true, shell: null } as any;

beforeAll(async () => {
  await import("../shims/globals");
  store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true, serviceKeys: { elevenlabs: "el-canary-key" } });
  voice = await import("../voice");
});
afterAll(() => cleanup(root));

function fakeElevenLabs(o: { token?: boolean; signed?: boolean }) {
  const calls: { url: string; key: string | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (!url.startsWith("https://api.elevenlabs.io/")) return real(input, init);
    calls.push({ url, key: init?.headers?.["xi-api-key"] ?? null });
    if (url.includes("/convai/agents/create")) return new Response(JSON.stringify({ agent_id: "agent_fake" }), { status: 200 });
    if (url.includes("/get_signed_url"))
      return o.signed ? new Response(JSON.stringify({ signed_url: "wss://fake.elevenlabs/x?sig=1" }), { status: 200 }) : new Response("no", { status: 500 });
    if (url.includes("/convai/conversation/token"))
      return o.token ? new Response(JSON.stringify({ token: "lk_token_fake" }), { status: 200 }) : new Response("no", { status: 500 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

describe("GET /api/v1/voice/session: the credentials", () => {
  it("mints a conversation token and a signed URL with the box's key, for the agent, never the key itself", async () => {
    const f = fakeElevenLabs({ token: true, signed: true });
    try {
      const out = await voice.voiceSession(null, deps);
      expect(out.status).toBe(200);
      expect(out.body.conversationToken).toBe("lk_token_fake");
      expect(out.body.signedUrl).toBe("wss://fake.elevenlabs/x?sig=1");
      const tok = f.calls.find((c) => c.url.includes("/convai/conversation/token"))!;
      expect(tok.url).toContain("agent_id=agent_fake");
      expect(tok.key).toBe("el-canary-key");
      expect(JSON.stringify(out.body)).not.toContain("el-canary-key");
    } finally {
      f.restore();
    }
  });

  it("either credential alone is enough; neither is a 502", async () => {
    let f = fakeElevenLabs({ token: true, signed: false });
    try {
      const out = await voice.voiceSession(null, deps);
      expect(out.status).toBe(200);
      expect(out.body.conversationToken).toBe("lk_token_fake");
      expect(out.body.signedUrl).toBeNull();
    } finally {
      f.restore();
    }
    f = fakeElevenLabs({ token: false, signed: true });
    try {
      const out = await voice.voiceSession(null, deps);
      expect(out.status).toBe(200);
      expect(out.body.conversationToken).toBeNull();
      expect(out.body.signedUrl).toBe("wss://fake.elevenlabs/x?sig=1");
    } finally {
      f.restore();
    }
    f = fakeElevenLabs({ token: false, signed: false });
    try {
      expect((await voice.voiceSession(null, deps)).status).toBe(502);
    } finally {
      f.restore();
    }
  });
});
