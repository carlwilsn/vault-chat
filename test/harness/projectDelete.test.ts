// Delete and Rename on a project, on the laptop (Carl, 2026-10-25: "where is the delete button for
// projects"): a project's row has a ⋯ menu (Main's has none), Delete is asked once under the row in so many
// words, and the screen on a deleted project lands on Main — when this laptop deleted it, and when another
// surface did (the box's signal, or only the row going away).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-projdel-");
const fake = installFakeTauri(vault);
const box = new FakeBox();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function fetchVia(url: string, init: RequestInit, timeoutMs: number) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    throw String((e as Error)?.message ?? e);
  }
}
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000));

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const projects = await import("../../src/projects.ts");
const panel = await import("../../src/ChatsPanel.tsx");
const S = () => useStore.getState();
const project = (slug: string, title: string, at: number) => {
  box.create(`project-${slug}`, title, at);
  box.emit(`project-${slug}`, { type: "meta", patch: { kind: "project", source: "project", project: slug } });
};

before(async () => {
  await box.start();
  box.create("main", "Main", Date.now() - 50_000);
  box.emit("main", { type: "meta", patch: { kind: "main", source: "main" } });
  project("coconut", "Coconut", Date.now() - 40_000);
  project("psych-221", "Psych 221", Date.now() - 30_000);
  project("thesis", "Thesis", Date.now() - 20_000);
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
});

after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("a project's row has the ⋯ menu; Main's has none (it can't be renamed or deleted)", () => {
  const row = (type: "main" | "project", id: string, more: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(panel.ThreadRow, {
        entry: { type, id, title: id, active: false, running: false, unread: false, ...(type === "project" ? { slug: id.replace(/^project-/, "") } : {}) } as any,
        name: id,
        onSelect: () => {},
        ...more,
      }),
    );
  const main = row("main", "main");
  assert.ok(main.includes('data-el="thread-main"'));
  assert.ok(!main.includes('data-el="project-menu"'));
  const proj = row("project", "project-coconut", { onRename: async () => {}, onDelete: async () => {} });
  assert.ok(proj.includes('data-el="project-menu"'));
  assert.ok(proj.includes('title="More"'));
});

test("Delete asks once, in so many words: its chat and notes go, the folder stays", () => {
  const html = renderToStaticMarkup(createElement(panel.DeleteProjectConfirm, { name: "Coconut", busy: false, onCancel: () => {}, onYes: () => {} }));
  const text = html.replace(/<[^>]+>/g, "");
  assert.ok(text.includes("Delete project Coconut? Its chat and notes go; your folder stays."), text);
  assert.ok(html.includes('data-el="project-delete-yes"') && html.includes('data-el="project-delete-cancel"'));
  const busy = renderToStaticMarkup(createElement(panel.DeleteProjectConfirm, { name: "Coconut", busy: true, onCancel: () => {}, onYes: () => {} }));
  assert.ok(busy.includes("Deleting…"));
});

test("deleting the project he is in: one intent to the box, the thread leaves the list, this screen is on Main", async () => {
  projects.openThread("project-coconut");
  assert.equal(S().activeConversationId, "project-coconut");
  const n = box.intents.length;
  const r = await projects.deleteProject("coconut");
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(box.intents.slice(n), [{ type: "deleteProject", slug: "coconut", client: "laptop" }]);
  assert.equal(S().activeConversationId, "main");
  await waitFor("row gone", () => !S().conversations.some((c) => c.id === "project-coconut"));
});

test("another surface deletes the project open here: this screen lands on Main", async () => {
  projects.openThread("project-psych-221");
  await waitFor("in psych", () => S().activeConversationId === "project-psych-221");
  // The phone's Delete: the box acts; this laptop only hears of it.
  await fetch(`${box.url}/api/v2/intent`, { method: "POST", body: JSON.stringify({ type: "deleteProject", slug: "psych-221", client: "phone" }) });
  await waitFor("on Main", () => S().activeConversationId === "main");
  await waitFor("row gone", () => !S().conversations.some((c) => c.id === "project-psych-221"));
});

test("Main can't be deleted; a refused delete leaves this screen where it is", async () => {
  projects.openThread("project-thesis");
  const r = await projects.deleteProject("main");
  assert.equal(r.ok, false);
  assert.equal(S().activeConversationId, "project-thesis");
  assert.ok(S().conversations.some((c) => c.id === "main"));
});

test("Rename: the name changes here at once; the thread, its id and this screen stay", async () => {
  const n = box.intents.length;
  const r = await projects.renameProject("thesis", "  Thesis draft ");
  assert.deepEqual(r, { ok: true, name: "Thesis draft" });
  assert.deepEqual(box.intents.slice(n), [{ type: "renameProject", slug: "thesis", name: "Thesis draft", client: "laptop" }]);
  assert.equal(S().conversations.find((c) => c.id === "project-thesis")?.title, "Thesis draft");
  assert.equal(S().activeConversationId, "project-thesis");
});

// Real use (2026-10-26): Carl deleted four projects by mistake, asked the agent to bring one back, and going
// back and forth between his threads afterwards was "buggy". Restore is the box's (Engine.restoreProject);
// here: what the laptop shows through delete → restore → switching, the project's talk always its own.
const said = (conv: string, user: string, reply: string) => {
  box.startTurn(conv);
  box.user(conv, `u-${conv}-${user.length}`, user);
  box.stream(conv, "assistant", reply);
  box.endTurn(conv);
};
const shown = () => S().messages.map((m) => m.content).join(" | ");

test("delete → restore → switching back and forth: each thread shows its own talk, nothing lost or mixed", async () => {
  project("physics", "Physics", Date.now() - 10_000);
  said("project-physics", "Derive the pendulum period.", "T = 2π√(L/g) for small angles. PHYSICS-REPLY");
  project("iems-469", "IEMS 469", Date.now() - 9_000);
  said("project-iems-469", "Summarise lecture 7 on MDPs.", "Bellman equations and value iteration. IEMS-REPLY");
  await waitFor("both listed", () => ["project-physics", "project-iems-469"].every((id) => S().conversations.some((c) => c.id === id)));

  // In Physics; 469 is deleted (from here), then brought back (the agent's RestoreProject: the box acts).
  projects.openThread("project-physics");
  await waitFor("physics shown", () => shown().includes("PHYSICS-REPLY"));
  assert.equal((await projects.deleteProject("iems-469")).ok, true);
  await waitFor("469 gone", () => !S().conversations.some((c) => c.id === "project-iems-469"));
  assert.equal(S().activeConversationId, "project-physics");
  assert.ok(shown().includes("PHYSICS-REPLY"));
  await fetch(`${box.url}/api/v2/intent`, { method: "POST", body: JSON.stringify({ type: "restoreProject", slug: "iems-469" }) });
  // Back on the list without a refresh.
  await waitFor("469 back", () => S().conversations.some((c) => c.id === "project-iems-469"));

  for (let i = 0; i < 3; i++) {
    projects.openThread("project-iems-469");
    await waitFor(`469 shown (${i})`, () => S().activeConversationId === "project-iems-469" && shown().includes("IEMS-REPLY"));
    assert.ok(!shown().includes("PHYSICS-REPLY"), shown());
    projects.openThread("project-physics");
    await waitFor(`physics shown (${i})`, () => S().activeConversationId === "project-physics" && shown().includes("PHYSICS-REPLY"));
    assert.ok(!shown().includes("IEMS-REPLY"), shown());
  }

  // The project he is in, deleted and restored: he is on Main meanwhile; going back shows its whole talk.
  assert.equal((await projects.deleteProject("physics")).ok, true);
  assert.equal(S().activeConversationId, "main");
  await fetch(`${box.url}/api/v2/intent`, { method: "POST", body: JSON.stringify({ type: "restoreProject", slug: "physics" }) });
  await waitFor("physics back", () => S().conversations.some((c) => c.id === "project-physics"));
  projects.openThread("project-physics");
  await waitFor("physics talk back", () => S().activeConversationId === "project-physics" && shown().includes("PHYSICS-REPLY"));
  projects.openThread("project-iems-469");
  await waitFor("469 again", () => shown().includes("IEMS-REPLY") && !shown().includes("PHYSICS-REPLY"));
  projects.openThread("main");
  await waitFor("main", () => S().activeConversationId === "main" && !shown().includes("IEMS-REPLY") && !shown().includes("PHYSICS-REPLY"));
});
