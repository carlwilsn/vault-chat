// An attachment uploaded while the laptop has one vault open, sent to a conversation another vault owns (11-24: Carl
// pasted an .mp4 with the vault-chat vault open, chatting in a school2 conversation, and the box said the file was not
// on it). The upload keeps it in the request's vault; the send finds it there too and the agent gets its box path.
import { it, expect } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { makeVault, startServer, tmp, waitFor, cleanup, type Running } from "./helpers";
import { fakeAnthropic } from "./claudeFakeApi";

it("a file uploaded from another open vault still reaches the conversation", async () => {
  const home = tmp("vc-attach-cross-"), master = join(home, "master");
  const vault = makeVault(join(master, "vaults/owner")), viewer = makeVault(join(master, "vaults/viewer"));
  const bare = join(master, ".hub/vaults/viewer.git");
  mkdirSync(bare, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", bare]);
  const provider = await fakeAnthropic("Got it.");
  let srv: Running | undefined;
  try {
    srv = await startServer({ home, vault, secrets: join(home, "empty-no-credentials"), anthropic: provider.url, extra: { VC_MASTER: master, VC_STATE_DIR: join(home, "state"), VC_VOICE_PIPELINE: "off" } });
    const post = async (p: string, body: any) => (await fetch(srv!.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
    const up = await post("/api/v2/attachment?vault=viewer", { name: "clip.mp4", dataBase64: Buffer.from("not really a video").toString("base64") });
    expect(up.ok).toBe(true);
    // Kept in the vault the laptop has open (the request's), not the conversation's.
    expect(up.abs.startsWith(viewer)).toBe(true);
    expect(existsSync(join(vault, ...up.path.split("/")))).toBe(false);
    const n = provider.calls.length;
    // Main belongs to the owner vault; the laptop has the viewer vault open.
    const r = await post("/api/v2/intent?vault=viewer", { type: "send", client: "laptop", clientId: "c-cross-1", text: "what is in this clip?", files: [up.path] });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, convId: "main" });
    await waitFor(async () => provider.calls.length > n || null, 30_000);
    expect(JSON.stringify(provider.calls[n]!.messages)).toContain(JSON.stringify(up.abs).slice(1, -1));
    // A path that is in neither vault is still refused.
    const bad = await post("/api/v2/intent?vault=viewer", { type: "send", client: "laptop", clientId: "c-cross-2", text: "and this?", files: [".vault-chat/attachments/2026-01-01/none.mp4"] });
    expect(bad.error).toMatch(/not on the box/);
  } finally {
    await srv?.stop();
    await provider.close();
    cleanup(home);
  }
}, 120_000);
