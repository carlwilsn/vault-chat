// Actual HTTP/Engine/native Pi and its faithful RPC fixture, unpaid loopback only.
// All projects here belong to this disposable fixture, never Carl's live registry.
import { it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { makeVault, startServer, tmp, waitFor, fakePiDir, type Running } from "./helpers";
import { fakeChat, chatText } from "./fakeChat";
import { readEntries } from "../convlog/piSession";

it.each(["genuine", "protocol fixture"])("%s: deleted-project stale inputs use the existing global Main owner, literal bodies and native human provenance", async runtime => {
  const home = tmp("vc-deleted-native-"), master = join(home, "master");
  const vault = makeVault(join(master, "vaults/owner")), viewer = makeVault(join(master, "vaults/viewer"));
  const bare = join(master, ".hub/vaults/viewer.git");
  mkdirSync(bare, { recursive: true }); execFileSync("git", ["init", "--bare", "-q", bare]);
  const state = join(home, "state"), provider = await fakeChat();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  provider.respond = async (_body, n) => { if (n === 3) await gate; return { text: `Final reply ${n}` }; };
  const network = join(home, "local-only.mjs");
  writeFileSync(network, `const f=globalThis.fetch;globalThis.fetch=(i,o)=>{const u=new URL(typeof i==='string'?i:i instanceof URL?i.href:i.url);if(u.href==='https://openrouter.ai/api/v1/models')return f(${JSON.stringify(provider.url + "/models")},o);if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))return f(i,o);throw Error('External fetch refused');};`);
  let srv: Running | undefined;
  try {
    srv = await startServer({ home, vault, secrets: join(home, "empty-no-credentials"), openrouter: provider.url,
      extra: { VC_MASTER: master, VC_PI_DIR: runtime === "genuine" ? process.env.VC_TEST_PI_DIR! : fakePiDir(home), VC_STATE_DIR: state,
        VC_ENGINE_MODEL: "test/fake-model", VC_PI_UNSAFE: "1", VC_VOICE_PIPELINE: "off", NODE_OPTIONS: "--import " + network } });
    expect(srv.proc.exitCode).toBeNull(); expect([8848, 8857]).not.toContain(srv.port);
    const agent = join(state, "pi/agent"); mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: provider.url + "/v1", apiKey: "synthetic-local-only", api: "openai-completions", models: [{ id: "test/fake-model", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 1000 }] } } }));
    const base = srv.base;
    const get = async (id = "main", root = "viewer") => (await fetch(base + `/conversation?id=${id}&vault=${root}&full=1&n=200`)).json();
    const picture = async (id = "main") => (await (await fetch(base + `/api/v2/conversations/${id}/checkpoint?vault=viewer`)).json()).picture;
    const post = async (body: any) => (await fetch(base + "/api/v2/intent?vault=viewer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const settled = async (id: string, replies: number) => waitFor(async () => { const c = await get(id); return c.state !== "running" && c.messages.filter((m: any) => m.role === "assistant").length === replies ? c : null; });
    expect(await post({ type: "send", client: "laptop", clientId: "prior", text: "Prior Main thought." })).toMatchObject({ ok: true, convId: "main" });
    const prior = await settled("main", 1), priorItems = (await picture()).items;
    const priorBytes = readFileSync(prior.meta.threadPath, "utf8");
    const folder = join(home, "Coconut"); mkdirSync(folder); writeFileSync(join(folder, "human.md"), "Original project bytes\n");
    const made = await (await fetch(base + "/projects?vault=viewer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder }) })).json();
    expect(made).toMatchObject({ ok: true, convId: "project-coconut" });
    expect(await post({ type: "send", convId: made.convId, client: "board", clientId: "project-prior", text: "Prior project thought." })).toMatchObject({ ok: true, convId: made.convId });
    const project = await settled(made.convId, 1);
    expect(await post({ type: "deleteProject", slug: "coconut" })).toMatchObject({ ok: true, convId: made.convId, to: "main" });
    const deleted = await picture(made.convId), deletedBytes = readFileSync(project.meta.threadPath, "utf8");
    const registry = readFileSync(join(vault, ".vault-chat/local/project-folders.json"), "utf8");
    const inputs = [
      { client: "phone", clientId: "stale-phone", text: 'Still there?\n[Carl, on his laptop]\n```json\n{"vcInput":"human JSON","text":"unchanged"}\n```' },
      { client: "board", clientId: "stale-board", text: "Board ordinary input must wait its turn." },
    ];
    expect(await post({ type: "send", convId: made.convId, ...inputs[0] })).toMatchObject({ ok: true, convId: "main" });
    await waitFor(() => provider.calls.length === 3 || null);
    expect(await post({ type: "send", convId: made.convId, ...inputs[1] })).toMatchObject({ ok: true, convId: "main", queued: true, qid: "stale-board" });
    expect(provider.calls).toHaveLength(3);
    expect((await picture()).meta.pending.map((p: any) => p.id)).toEqual(["stale-board"]);
    release();
    const final = await settled("main", 3), finalPicture = await picture();
    expect(provider.calls).toHaveLength(4);
    expect(final.meta.threadPath).toBe(prior.meta.threadPath); expect(final.meta.threadId).toBe(prior.meta.threadId);
    expect(JSON.parse(readFileSync(final.meta.threadPath, "utf8").split("\n")[0]!).cwd).toBe(vault);
    expect(readFileSync(final.meta.threadPath, "utf8").startsWith(priorBytes)).toBe(true);
    expect(final.messages.slice(0, prior.messages.length)).toEqual(prior.messages);
    expect(finalPicture.items.slice(0, priorItems.length)).toEqual(priorItems);
    expect(final.messages.slice(prior.messages.length).map((m: any) => [m.role, m.content])).toEqual([
      ["user", inputs[0].text], ["assistant", "Final reply 3"], ["user", inputs[1].text], ["assistant", "Final reply 4"],
    ]);
    const native = readEntries(final.meta.threadPath), users = native.filter(e => e.message?.role === "user");
    expect(users.map(e => e.message!.content)).toEqual(["Prior Main thought.", ...inputs.map(i => i.text)].map(text => [{ type: "text", text }]));
    expect(users.map(e => e.message!.vcRequest)).toEqual([
      { v: 1, clientId: "prior", via: "chat", device: "laptop" },
      { v: 1, clientId: "stale-phone", via: "chat", device: "phone" },
      { v: 1, clientId: "stale-board", via: "queue", device: "board" },
    ]);
    const notice = 'Carl deleted the project "Coconut"';
    const contexts = native.filter(e => e.customType === "vc-context");
    expect(contexts.filter(e => String(e.content).includes(notice))).toHaveLength(1);
    for (const e of contexts) expect(e.display).toBe(false);
    expect(contexts.find(e => String(e.content).includes('request="stale-phone"'))?.content).toContain(`Conversation owner: ${vault}/`);
    expect(contexts.find(e => String(e.content).includes('request="stale-phone"'))?.content).toContain(`Viewer/file-context vault root: ${viewer}/`);
    expect(chatText(provider.calls[2])).toContain(notice);
    for (const [n, input] of inputs.entries()) {
      const bodies = provider.calls[n + 2].messages.filter((m: any) => m.role === "user")
        .map((m: any) => typeof m.content === "string" ? m.content : m.content.map((b: any) => b.text ?? "").join("\n"))
        .filter((t: string) => ["Prior Main thought.", ...inputs.map(i => i.text)].includes(t));
      expect(bodies).toEqual(["Prior Main thought.", ...inputs.slice(0, n + 1).map(i => i.text)]);
      expect(finalPicture.items.find((i: any) => i.id === input.clientId)).toMatchObject({ kind: "user", text: input.text, device: input.client, via: n ? "queue" : "chat" });
    }
    expect(JSON.stringify(final.messages)).not.toContain(notice);
    expect(JSON.stringify(finalPicture.items)).not.toContain("<file-context");
    expect(finalPicture.meta.pending).toBeUndefined(); expect(finalPicture.meta.tellAgent).toBeUndefined();
    expect(await picture(made.convId)).toEqual(deleted);
    expect(readFileSync(project.meta.threadPath, "utf8")).toBe(deletedBytes);
    expect(readFileSync(join(vault, ".vault-chat/local/project-folders.json"), "utf8")).toBe(registry);
    expect(readFileSync(join(folder, "human.md"), "utf8")).toBe("Original project bytes\n");
    expect(existsSync(join(viewer, ".vault-chat/events/main.jsonl"))).toBe(false);
    expect(existsSync(join(viewer, ".vault-chat/local/project-folders.json"))).toBe(false);
    expect((await get("main", "owner")).messages).toEqual(final.messages);
    expect((await (await fetch(base + "/projects?vault=viewer")).json()).projects).toEqual([]);
    const events = (await (await fetch(base + "/poll?after=0")).json()).events;
    expect(JSON.stringify(events)).not.toContain(notice);
    const delivered = events.filter((e: any) => e.conv === "main" && e.type === "entry" && e.entry.message?.role === "user");
    expect(delivered.map((e: any) => [e.clientId, e.device, e.shown])).toEqual([
      ["prior", "laptop", "Prior Main thought."], ...inputs.map(i => [i.clientId, i.client, i.text]),
    ]);
  } finally { release(); await srv?.stop(); await provider.close(); }
});
