// One agent across surfaces — the laptop's half (server/test/crossSurface.test.ts has the box's).
// The editor watch posts focus to the shared activity stream, read by typed and New voice turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-cross-");
const fake = installFakeTauri(vault);
// This vault runs on a box: the stream's posts are captured here.
const posts: { url: string; body: any }[] = [];
fake.setHandler("vault_box_config", ({ vault: v }) => (v === vault ? { box: "http://127.0.0.1:9", vault: "v" } : null));
fake.setHandler("box_post_json", async ({ url, body }) => {
  posts.push({ url: String(url), body: JSON.parse(String(body)) });
  return { status: 200, body: JSON.stringify({ ok: true }) };
});

const { useStore } = await import("../../src/store.ts");
const activity = await import("../../src/activity.ts");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const A = `${vault}/notes/banach.md`;
const B = `${vault}/notes/measure-theory.md`;
fs.mkdirSync(`${vault}/notes`, { recursive: true });
fs.writeFileSync(A, "# Banach\n\nContractions have unique fixed points.\n");
fs.writeFileSync(B, "# Measure theory\n\nA sigma-algebra is closed under complements.\n");

test("g. the editor's watch posts the new focus to the box's stream, with the open chat's project", async () => {
  const id = useStore.getState().newConversation();
  useStore.getState().selectConversation(id);
  useStore.setState((s: any) => ({ conversations: s.conversations.map((c: any) => (c.id === id ? { ...c, project: "analysis" } : c)) }) as any);
  useStore.setState({ vaultPath: vault, currentFile: A } as any);
  const stop = activity.startActivityWatch();
  posts.length = 0;
  useStore.setState({ currentFile: B } as any);
  await wait(4500); // FOCUS_MIN_MS coalescing
  await activity.flushActivity();
  stop();
  const focus = posts.filter((p) => p.url.includes("/api/v1/activity") && p.body?.entry?.kind === "focus");
  assert.ok(focus.length >= 1, "a focus entry reached the box");
  assert.equal(focus.at(-1)!.body.entry.path, "notes/measure-theory.md");
  assert.equal(focus.at(-1)!.body.entry.project, "analysis");
});
