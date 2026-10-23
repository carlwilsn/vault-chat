// Show never fails on sync, and the screen follows Carl to a thread — in the real app (the preview's real
// frontend on its fake box, box mode), driven by the box's own feed signals:
//   1. Show a file the agent just made on the box (not on the laptop yet): it opens from the box's copy, acked ok.
//   2. Show a file the laptop has an older copy of (the signal's sha differs): the box's copy is what shows.
//   3. {type:"follow"} (the agent's OpenProject): the laptop opens that project's thread.
// Shots and result.json → <out>. Muted (preview/tools/browser.mjs launches with --mute-audio).
//   node preview/tools/show-follow-check.mjs [<out>] [--url http://127.0.0.1:1757/after]   (needs the preview server)
import { launch, sideBase } from "./browser.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const out = resolve(argv[0] && !argv[0].startsWith("--") ? argv[0] : "preview-proof/show-follow");
const base = opt("url", null) ?? (await sideBase(1757));
mkdirSync(out, { recursive: true });

const NEW = "projects/hw4/practice.md";
const NEW_TEXT = "# HW4 practice\n\nMade on the box a moment ago; the laptop's sync has not brought it yet.\n\n## Problem 1\n\nShow that every convergent sequence is bounded.\n";
const NOTE = "projects/bitnet-160m/writeup.md";
const NOTE_TEXT = "# BitNet 160M writeup\n\nThe box's newer copy: the laptop still has the older one.\n";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

const { browser, page, log } = await launch({ width: 1400, height: 900 });
try {
  await page.goto(`${base}/?scenario=live-edit&narrate=0&steps=0`, { timeout: 180000 });
  await page.waitForFunction(() => window.__preview?.ready, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  // The app's own modules, as the page loaded them.
  await page.evaluate(async () => {
    const find = (re) => performance.getEntriesByType("resource").map((e) => e.name).find((n) => re.test(n));
    window.__h = await import(find(/\/preview\/runtime\/backend\/host\.ts/));
    window.__s = (await import(find(/\/src\/store\.ts/))).useStore;
    window.__sha = async (t) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))), (b) => b.toString(16).padStart(2, "0")).join("");
    window.__show = async (id, path, text) => {
      window.__h.fakeBoxLog().emit(null, { type: "signal", signal: { type: "show", to: "laptop", id, path, sha: await window.__sha(text) } });
      const t0 = Date.now();
      for (;;) {
        const ack = window.__h.boxPostLog().find((p) => p.path.includes(`/api/v1/show/${id}/ack`));
        if (ack) return { ack: ack.body, ms: Date.now() - t0 };
        if (Date.now() - t0 > 15000) return { ack: null, ms: Date.now() - t0 };
        await new Promise((r) => setTimeout(r, 50));
      }
    };
  });
  check("box chat online", await page.evaluate(() => window.__s.getState().boxChat?.on === true));

  // 1. A file only the box has.
  const missing = await page.evaluate(async ([rel]) => {
    const vault = window.__s.getState().vaultPath;
    let onLaptop = true;
    try {
      await window.__TAURI_INTERNALS__.invoke("read_text_file", { path: `${vault}/${rel}` });
    } catch {
      onLaptop = false;
    }
    return { onLaptop };
  }, [NEW]);
  check("practice.md is not on the laptop", !missing.onLaptop);
  await page.evaluate(([rel, text]) => window.__h.boxPlay({ merge: { [rel]: text } }), [NEW, NEW_TEXT]);
  const a = await page.evaluate(([rel, text]) => window.__show("show-pf-1", rel, text), [NEW, NEW_TEXT]);
  await page.waitForTimeout(800);
  check("Show of a file not synced yet is acked ok", a.ack?.ok === true, a.ack);
  check("…with no word about sync", a.ack && !/sync/i.test(JSON.stringify(a.ack)));
  const shown1 = await page.evaluate(() => ({ file: window.__s.getState().currentFile, text: [...document.querySelectorAll(".prose-md")].map((e) => e.textContent).join("\n") }));
  check("the viewer shows the box's copy", String(shown1.file).endsWith(NEW) && shown1.text.includes("Made on the box a moment ago"), shown1.file);
  await page.screenshot({ path: join(out, "1-show-not-synced.png") });

  // 2. An older copy on the laptop.
  await page.evaluate(([rel, text]) => window.__h.boxPlay({ merge: { [rel]: text } }), [NOTE, NOTE_TEXT]);
  const b = await page.evaluate(([rel, text]) => window.__show("show-pf-2", rel, text), [NOTE, NOTE_TEXT]);
  await page.waitForTimeout(800);
  check("Show of a stale file is acked ok", b.ack?.ok === true, b.ack);
  const shown2 = await page.evaluate(() => ({ file: window.__s.getState().currentFile, text: [...document.querySelectorAll(".prose-md")].map((e) => e.textContent).join("\n") }));
  check("the viewer shows the box's newer copy, not the laptop's", String(shown2.file).endsWith(NOTE) && shown2.text.includes("The box's newer copy"), shown2.file);
  await page.screenshot({ path: join(out, "2-show-stale.png") });

  // 3. The agent's OpenProject: the screen follows to the project's thread.
  await page.keyboard.press("Control+Shift+F");
  await page.waitForSelector("[data-el='chats-sidebar']", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
  const before = await page.evaluate(() => window.__s.getState().activeConversationId);
  await page.screenshot({ path: join(out, "3-follow-before.png") });
  await page.evaluate(() => {
    const box = window.__h.fakeBoxLog();
    box.create("project-hw4", { title: "HW4", source: "project", kind: "project", project: "hw4" });
    box.append("project-hw4", [{ role: "user", content: "Make me practice problems for HW4." }]);
    box.emit(null, { type: "signal", signal: { type: "follow", convId: "project-hw4", title: "HW4", project: "hw4", created: true } });
  });
  await page.waitForFunction(() => window.__s.getState().activeConversationId === "project-hw4", null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({ active: window.__s.getState().activeConversationId, sidebar: document.querySelector("[data-el='chats-sidebar']")?.textContent ?? "" }));
  check("the chat follows to the project's thread", after.active === "project-hw4", { before, after: after.active });
  check("the panel lists the new project", after.sidebar.includes("HW4"));
  await page.screenshot({ path: join(out, "3-follow-after.png") });

  check("no page errors", log.pageErrors.length === 0, log.pageErrors.slice(0, 3));
  check("nothing left the machine", log.outbound.length === 0, log.outbound.slice(0, 3));
} finally {
  await browser.close();
}
writeFileSync(join(out, "result.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed → ${out}`);
process.exit(failed.length ? 1 : 0);
