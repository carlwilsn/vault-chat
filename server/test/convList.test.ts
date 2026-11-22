// The agent's ListConversations is one list over every vault's log: each chat says what it is (Main, a project's
// thread, a chat in a project, a loose chat) and who named it, and ReadConversation reads a chat in another vault.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";
import { convLog, setFeedVaults } from "../convlog/log";

let rig: Rig;
let other: string;

async function turn(text: string, convId: string): Promise<string> {
  const before = rig.backend.turns.length;
  const r = await rig.engine.message({ text, convId });
  if (!r?.ok) throw new Error(JSON.stringify(r));
  await until(() => rig.backend.turns.length > before);
  const t = rig.backend.turns[before];
  rig.backend.ev(t.threadId, { kind: "text", text: `About: ${text}` });
  rig.backend.end(t.threadId);
  await until(async () => (await rig.readConv(convId))?.state !== "running");
  return t.threadId;
}
const lines = (r: unknown) => String((r as any)?.text ?? (r as any)?.contentItems?.[0]?.text ?? "").split("\n");

beforeAll(async () => {
  rig = await makeRig({ deps: { titleWith: async () => "Summary name" } });
  rig.engine.stop();
  await rig.engine.ensureThreads();
  other = join(rig.root, "vault-two");
  mkdirSync(join(other, ".vault-chat"), { recursive: true });
  const at = Date.now() - 60_000;
  convLog(other).emit("far-1", { type: "meta", patch: { title: "A chat in the other vault", kind: "separate", createdAt: at, lastActivityAt: at } });
  convLog(other).emit("far-1", { type: "user", id: "u1", text: "hello from far away", at } as any);
  setFeedVaults(rig.vault, () => [rig.vault, other]);
});
afterAll(() => {
  setFeedVaults(rig.vault, () => [rig.vault]);
  rig?.engine?.stop();
  cleanup(rig?.root);
});

describe("box:chats list", () => {
  it("every vault's chats, each with what it is, who named it and its vault", async () => {
    await turn("first chat about pendulums", "loose-a");
    await until(async () => String((await rig.readConv("loose-a"))?.title) === "Summary name");
    await turn("second chat", "loose-b");
    expect((await rig.engine.intent({ type: "renameConversation", convId: "loose-b", title: "My name" })).ok).toBe(true);
    const tid = await turn("what chats do I have?", "asker-chat");
    const out = lines(await rig.backend.call(tid, "PluginAct", { plugin: "box:chats", action: "list", args: { limit: 100 } }));
    const row = (id: string) => out.find((l) => l.replace(/^box:chats list: done: /, "").startsWith(`${id} — `)) ?? "";
    expect(row("main")).toContain("· Main · named by its place");
    expect(row("loose-a")).toContain('"Summary name" · loose chat · summary title');
    expect(row("loose-b")).toContain('"My name" · loose chat · named by Carl');
    expect(row("far-1")).toContain("· loose chat · his first message, vault vault-two");
    expect(row("asker-chat")).toBe("");
    // Read across vaults too.
    expect(JSON.stringify(await rig.backend.call(tid, "PluginAct", { plugin: "box:chats", action: "read", args: { id: "far-1" } }))).toContain("A chat in the other vault");
  });
});
