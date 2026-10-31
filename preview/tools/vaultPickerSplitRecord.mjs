// Real frontend + existing realbox fixture. Muted Playwright input; no rename submission or delete confirmation.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./browser.mjs";
const [base, out, mode = "candidate"] = process.argv.slice(2);
assert.ok(base && out && ["candidate", "baseline"].includes(mode));
mkdirSync(out, { recursive: true });
const preflight = process.argv[5] === "--preflight";
const size = { width: 1400, height: 900 };
const { browser, context, page, log } = await launch({ ...size, recordVideo: { dir: out, size } });
const result = { mode, scope: "Source native frontend + throwaway real server fixture; not user registration, production Tauri or shipment proof", checks: {}, errors: [] };
const el = (name) => page.locator(`[data-el="${name}"]`);
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
const chats = () => page.locator('[data-el="thread-main"],[data-el="thread-project"]').allTextContents();
// Read-only observations of the actual app store, never a navigation/control hook.
const snapshot = () => page.evaluate(async () => {
  const { useStore } = await import(`${location.pathname.replace(/\/$/, "")}/src/store.ts`);
  const s = useStore.getState();
  const { messagesOf } = await import(`${location.pathname.replace(/\/$/, "")}/src/convlog/view.ts`);
  const proxy = `${location.pathname.replace(/\/$/, "")}/__realbox`;
  const { boxLinkFor } = await import(`${location.pathname.replace(/\/$/, "")}/src/boxChat.ts`);
  const link = await boxLinkFor(s.vaultPath);
  const api = `${proxy}/api/v2/conversations`;
  const scoped = (url, vault = link?.vault) => vault ? `${url}?vault=${encodeURIComponent(vault)}` : url;
  const read = async (url) => { const r = await fetch(url); if (!r.ok) throw Error(`History read failed: ${r.status}`); return r.json(); };
  const { rows } = await read(scoped(api));
  const history = await Promise.all(rows.map(async ({ id }) => ({ id,
    messages: messagesOf((await read(scoped(`${api}/${encodeURIComponent(id)}/checkpoint`))).picture),
  })));
  history.sort((a, b) => a.id.localeCompare(b.id));
  // Current public contract: projects are globally listed, not owned by the viewer vault.
  // Verify the same shared project from two registered scopes, without creating/assigning one.
  const scopes = await Promise.all(['school2', 'vault-chat'].map(async (vault) => ({ vault,
    projects: (await read(scoped(`${proxy}/projects`, vault))).projects,
    main: messagesOf((await read(scoped(`${api}/main/checkpoint`, vault))).picture),
  })));
  const unknownScopeStatus = (await fetch(scoped(api, 'picker-unregistered-negative'))).status;
  return { viewerScope: link?.vault ?? null, scopes, unknownScopeStatus,
    files: s.files.map(({path, is_dir}) => ({path, is_dir})),
    currentFile: s.currentFile, currentContent: s.currentContent, panes: s.panes,
    vault: s.vaultPath, activeId: s.activeConversationId, messages: s.messages, history,
    conversations: s.conversations.map(({ id, title, project, messages }) => ({ id, title, project, messages })),
    loaded: s.conversationsLoaded, box: s.boxChat, drawerOpen: s.showChatsPanel,
    toggleCount: document.querySelectorAll('[data-el="chats-toggle"]').length };
});
let failure;
try {
  await page.goto(`${base}/?scenario=folders-final&side=after&overlay=0&narrate=0`);
  await page.waitForFunction(() => window.__preview?.ready, null, { timeout: 60000 });
  if (await page.locator('[title^="Show chat panel"]').count()) await page.locator('[title^="Show chat panel"]').click();
  if (!(await el("thread-main").count())) await el("chats-toggle").first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-el="thread-project"]').length >= 2);
  result.checks.chatsBefore = await chats();
  assert.ok(result.checks.chatsBefore.some((s) => s.includes("Main")));
  assert.ok(result.checks.chatsBefore.some((s) => s.includes("vault-chat")));
  assert.ok(result.checks.chatsBefore.some((s) => s.includes("IEMS")));
  await page.waitForFunction(async () => {
    const { useStore } = await import(`${location.pathname.replace(/\/$/, "")}/src/store.ts`);
    const s = useStore.getState();
    return s.conversationsLoaded && s.activeConversationId === "main" && s.messages.some((m) => m.mid === "picker-main-assistant");
  });
  // Genuine file input before switching: a stale open pane must not survive into another vault.
  // The synthetic laptop vault genuinely starts with collapsed top-level directories.
  // Choose this known seeded file, not whichever Markdown row happens to appear first.
  const initialFile = "/home/carl/vaults/summer-demo/reading/README.md";
  const reading = page.locator('[data-tree-path="/home/carl/vaults/summer-demo/reading"][data-tree-dir]');
  const initialRow = page.locator(`[data-tree-path="${initialFile}"]:not([data-tree-dir])`);
  result.checks.treeBeforeExpand = await page.locator("[data-tree-path]").evaluateAll((xs) =>
    xs.map((x) => ({ path: x.dataset.treePath, directory: x.hasAttribute("data-tree-dir") })));
  if (!(await initialRow.isVisible())) await reading.click();
  await initialRow.click();
  await page.waitForFunction(async () => {
    const {useStore} = await import(`${location.pathname.replace(/\/$/, "")}/src/store.ts`);
    const s = useStore.getState();
    return s.currentFile === "/home/carl/vaults/summer-demo/reading/README.md"
      && s.currentContent.startsWith("# Reading list\n");
  });
  await page.getByRole("heading", { name: "Reading list", exact: true }).waitFor({ state: "visible" });
  result.checks.stateBefore = await snapshot();
  assert.ok(result.checks.stateBefore.currentFile.startsWith(result.checks.stateBefore.vault + '/'));
  assert.equal(result.checks.stateBefore.unknownScopeStatus, 404);
  assert.deepEqual(result.checks.stateBefore.scopes[0].projects, result.checks.stateBefore.scopes[1].projects);
  assert.ok(result.checks.stateBefore.scopes[0].projects.some((p) => p.slug === 'vault-chat'));
  for (const scope of result.checks.stateBefore.scopes)
    assert.deepEqual(scope.main.map((m) => m.mid), ['picker-main-user', 'picker-main-assistant']);
  assert.deepEqual(result.checks.stateBefore.messages.map((m) => m.mid), ["picker-main-user", "picker-main-assistant"]);
  for (const [id, mids] of [["main", ["picker-main-user", "picker-main-assistant"]], ["picker-older-history", ["picker-older-user", "picker-older-assistant"]]]) {
    assert.deepEqual(result.checks.stateBefore.history.find((h) => h.id === id)?.messages.map((m) => m.mid), mids);
  }
  await page.getByText("Main history stays in this conversation.", { exact: true }).waitFor({ state: "visible" });
  await shot("01-main-and-projects");
  if (!preflight) {
  await el("vault-picker").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-el="vault-picker-item"]').length >= 3);
  result.checks.rows = await el("vault-picker-item").evaluateAll((xs) => xs.map((x) => ({ rel: x.dataset.rel, text: x.textContent.trim() })));
  await shot("02-picker");
  if (mode === "candidate") {
    assert.equal(await el("picker-tabs").count(), 0);
    assert.equal(await el("picker-is-project").count(), 0);
    assert.deepEqual(result.checks.rows.map((r) => r.rel), ["vaults/physics", "vaults/school2", "vaults/vault-chat"]);
    assert.ok(result.checks.rows.every((r) => !r.text.includes("in school2")));
    assert.equal(result.checks.rows.filter((r) => r.text === "vault-chat").length, 1);
  } else {
    assert.equal(await el("picker-tab-projects").count(), 1);
    assert.ok(result.checks.rows.some((r) => r.rel === "projects/vault-chat"));
    assert.ok(result.checks.rows.some((r) => r.rel === "vaults/school2/IEMS 469"));
  }
  const actions = page.locator('[data-el="vault-picker-item"][data-rel="vaults/school2"] [data-el="picker-row-menu"]');
  await actions.click();
  await el("picker-row-menu-list").waitFor({ state: "visible" });
  result.checks.geometry = await el("picker-row-menu-list").evaluate((menu) => {
    const picker = document.querySelector('[data-el="vault-picker-menu"]');
    const bounds = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    return { portal: menu.parentElement === document.body, nested: picker.contains(menu), menu: bounds(menu), picker: bounds(picker), items: [...menu.querySelectorAll('button')].map((b) => ({ label: b.textContent.trim(), bounds: bounds(b), hit: b.contains(document.elementFromPoint(b.getBoundingClientRect().x + 30, b.getBoundingClientRect().y + b.getBoundingClientRect().height / 2)) })) };
  });
  await shot("03-separate-actions");
  if (mode === "candidate") {
    const g = result.checks.geometry;
    assert.equal(g.portal, true);
    assert.equal(g.nested, false);
    assert.ok(g.menu.x >= g.picker.right + 7 || g.menu.right <= g.picker.x - 7 || g.menu.y >= g.picker.bottom + 7);
    assert.ok(g.menu.x >= 0 && g.menu.right <= size.width && g.menu.y >= 0 && g.menu.bottom <= size.height);
    assert.ok(g.items.every((i) => i.hit && i.bounds.width >= 160 && i.bounds.height >= 24));
    assert.ok(g.items.some((i) => i.label === "Rename") && g.items.some((i) => i.label === "Delete"));
    assert.equal(await el("picker-rename").evaluate((e) => e === document.activeElement), true);
    await page.keyboard.press("End");
    assert.equal(await el("picker-delete").evaluate((e) => e === document.activeElement), true);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Escape");
    assert.equal(await el("picker-row-menu-list").count(), 0);
    assert.equal(await actions.evaluate((e) => e === document.activeElement), true);
    await page.keyboard.press("Enter");
    await el("picker-rename").click();
    await el("picker-rename-input").waitFor();
    await shot("04-rename-no-submit");
    await page.keyboard.press("Escape");
    await actions.click();
    await el("picker-delete").click();
    await el("picker-delete-confirm").waitFor();
    await shot("05-delete-no-confirm");
    await el("picker-delete-cancel").click();
    await actions.click();
    await page.mouse.click(1100, 750);
    assert.equal(await el("picker-row-menu-list").count(), 0);
    assert.equal(await el("vault-picker-menu").count(), 0);
  } else {
    assert.equal(result.checks.geometry.nested, true);
    // Baseline must perform the SAME final navigation, not stop at menu geometry.
    await page.keyboard.press("Escape");
    await page.mouse.click(1100, 750);
  }
  await el("vault-picker").click();
  const target = page.locator('[data-el="vault-picker-item"][data-rel="vaults/vault-chat"]');
  if (mode === "baseline") await target.click({ position: { x: 60, y: 14 } });
  else await target.locator(":scope > button").first().click();
  await page.waitForFunction(() => document.querySelector('[data-el="vault-picker"]')?.textContent.includes("vault-chat"));
  await page.waitForTimeout(1200); // Original observation preserved; never lengthened to hide reset.
  result.checks.stateAfter = await snapshot();
  result.checks.chatsAfterClosed = await chats();
  await shot("06-after-switch-before-reopen");
  // A real click can distinguish a closed drawer from missing conversations.
  if (!(await el("thread-main").count()) && await el("chats-toggle").count()) {
    await el("chats-toggle").first().click();
  }
  result.checks.chatsImmediatelyAfterReopen = await chats();
  // ThreadsList mounts only when the drawer opens. Its useProjects effect starts
  // with [] then awaits listProjects; wait for the original full list, not a sleep
  // or a reduced count. Failure still preserves before/after store and screenshots.
  await page.waitForFunction((expected) => {
    const actual = [...document.querySelectorAll('[data-el="thread-main"],[data-el="thread-project"]')].map((e) => e.textContent);
    return JSON.stringify(actual) === JSON.stringify(expected);
  }, result.checks.chatsBefore, { timeout: 5000 });
  result.checks.chatsAfter = await chats();
  await page.waitForFunction(async () => {
    const { useStore } = await import(`${location.pathname.replace(/\/$/, "")}/src/store.ts`);
    const s = useStore.getState();
    return s.conversationsLoaded && s.activeConversationId === "main" && s.messages.some((m) => m.mid === "picker-main-assistant");
  }, null, { timeout: 5000 });
  result.checks.stateAfterReopen = await snapshot();
  await shot("07-after-real-reopen");
  // Keep the original complete-list assertion AND prove identity/history, not just counts.
  assert.deepEqual(result.checks.chatsAfter, result.checks.chatsBefore);
  assert.equal(result.checks.stateAfterReopen.activeId, result.checks.stateBefore.activeId);
  assert.deepEqual(result.checks.stateAfterReopen.messages, result.checks.stateBefore.messages);
  assert.deepEqual(result.checks.stateAfterReopen.conversations, result.checks.stateBefore.conversations);
  assert.deepEqual(result.checks.stateAfterReopen.history, result.checks.stateBefore.history);
  assert.deepEqual(result.checks.stateAfterReopen.messages.map((m) => m.mid), ["picker-main-user", "picker-main-assistant"]);
  await page.getByText("Main history stays in this conversation.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(result.checks.stateAfterReopen.viewerScope, 'vault-chat');
  assert.equal(result.checks.stateAfterReopen.currentFile, null);
  assert.deepEqual(result.checks.stateAfterReopen.panes, []);
  assert.ok(result.checks.stateAfterReopen.files.length > 0);
  assert.ok(result.checks.stateAfterReopen.files.every((f) => f.path.startsWith(result.checks.stateAfterReopen.vault + '/')));
  assert.deepEqual(result.checks.stateAfterReopen.scopes, result.checks.stateBefore.scopes);
  assert.equal(result.checks.stateAfterReopen.unknownScopeStatus, 404);
  await shot("08-projects-and-history-retained");
  const queue = page.locator('[data-tree-path$="/reports/QUEUE.md"]');
  if (!(await queue.isVisible())) await page.locator('[data-tree-path$="/reports"][data-tree-dir]').click();
  await queue.click();
  await page.waitForFunction(async () => {
    const {useStore} = await import(`${location.pathname.replace(/\/$/, "")}/src/store.ts`);
    const s=useStore.getState();
    return s.currentFile?.endsWith('/vaults/vault-chat/reports/QUEUE.md') && s.currentContent.includes('# Queue');
  });
  result.checks.newViewerFile = await snapshot();
  assert.deepEqual(result.checks.newViewerFile.messages, result.checks.stateBefore.messages);
  assert.deepEqual(result.checks.newViewerFile.history, result.checks.stateBefore.history);
  await shot('09-correct-viewer-file-main-bound');
  } else result.checks.preflight = "Known seeded Markdown opened through genuine directory and file clicks; Main/history/scopes checked";
} catch (e) {
  failure = e;
  result.errors.push(String(e.stack ?? e));
  await shot("error").catch(() => {});
  // Failure evidence is observational only; never let capture replace the primary error.
  await page.content().then((html) => writeFileSync(join(out, "failure-dom.html"), html)).catch(() => {});
  await page.evaluate(() => ({ calls: window.__preview?.calls(), unknown: window.__preview?.unknown() }))
    .then((data) => writeFileSync(join(out, "failure-ipc.json"), JSON.stringify(data, null, 2))).catch(() => {});
  await snapshot().then((data) => { result.failureState = data; }).catch((err) => {
    result.failureCaptureError = String(err);
  });
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  renameSync(await video.path(), join(out, "laptop.webm"));
  result.pageErrors = log.pageErrors;
  result.outbound = log.outbound;
  result.console = log.console;
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
}
if (failure) throw failure;
assert.deepEqual(log.pageErrors, []);
assert.deepEqual(log.outbound, []);
console.log(`Verified ${mode}: ${out}`);
