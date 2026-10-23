// One main conversation, before and after, in the real app (the preview's real frontend on its fake box):
// the left panel, Main, a project's thread, the thread right after Clear, the menu, and the phone's panel.
// Each pair is written side by side (before | after) to <out>/<name>.png, the singles beside it.
//   node preview/tools/main-shots.mjs <out> [--url http://127.0.0.1:1610]   (needs: node preview/serve.mjs --before <old tree> --after .)
import { launch } from "./browser.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const out = resolve(argv[0] ?? "preview-proof/main-thread");
const origin = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 ? argv[i + 1] : "http://127.0.0.1:1610";
})();
mkdirSync(out, { recursive: true });

/** The box's contents both sides get: after, Main and two projects' threads (the box makes them); before, the same talk as chats in projects. */
const SEED = async (after) => {
  const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/preview\/runtime\/backend\/host\.ts/.test(n));
  const { fakeBoxLog } = await import(url);
  const box = fakeBoxLog();
  const talk = {
    main: [
      { role: "user", content: "What's due this week?" },
      { role: "assistant", content: "The Psych 221 essay on Friday, and problem set 4 on Monday. Want me to block time for the essay tomorrow morning?" },
      { role: "user", content: "Yes, 9 to 11." },
      { role: "assistant", content: "Done: Thursday 9–11 is on your calendar as *Essay draft*." },
    ],
    coconut: [
      { role: "user", content: "What overlap did we settle on for the tiles?" },
      { role: "assistant", content: "128 px on 1024 tiles — it keeps a 40 px coconut whole in at least one tile." },
    ],
    psych: [{ role: "user", content: "Outline the essay in APA style." }, { role: "assistant", content: "Here is a five-part outline: introduction, the two studies, the comparison, and the limits." }],
  };
  if (after) {
    box.create("main", { title: "Main", source: "main", kind: "main" });
    box.append("main", talk.main);
    box.create("project-coconut", { title: "Coconut", source: "project", kind: "project", project: "coconut" });
    box.append("project-coconut", talk.coconut);
    box.create("project-psych-221", { title: "Psych 221", source: "project", kind: "project", project: "psych-221" });
    box.append("project-psych-221", talk.psych);
  } else {
    box.create("c-week", { title: "What's due this week?", source: "manual" });
    box.append("c-week", talk.main);
    box.create("c-coconut", { title: "Tile overlap", source: "manual", project: "coconut" });
    box.append("c-coconut", talk.coconut);
    box.create("c-psych", { title: "Essay outline", source: "manual", project: "psych-221" });
    box.append("c-psych", talk.psych);
  }
};

const shots = {};
async function desktop(side) {
  // Both trees have one main conversation (--before <the previous push>); --old-before: a tree from before it.
  const after = side === "after" || !argv.includes("--old-before");
  const { browser, page, log } = await launch({ width: 1400, height: 900 });
  const shot = async (name) => {
    const p = join(out, `${name}-${side}.png`);
    await page.screenshot({ path: p });
    (shots[name] ??= {})[side] = p;
  };
  try {
    await page.goto(`${origin}/${side}/?scenario=conv-a&side=before&narrate=0&steps=0`, { timeout: 180000 });
    await page.waitForFunction(() => window.__preview?.ready, null, { timeout: 120000 });
    await page.waitForTimeout(1200);
    await page.evaluate(SEED, after);
    await page.waitForTimeout(1500);
    // The docked layout's panel (the "Chats" button under the composer).
    await page.evaluate(async () => {
      const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/src\/store\.ts/.test(n));
      (await import(url)).useStore.getState().setShowChatsPanel(true);
    });
    await page.waitForTimeout(700);
    await shot("panel");
    if (after) {
      await page.click("[data-el='threads-menu']");
      await page.waitForTimeout(400);
      await shot("menu");
      await page.keyboard.press("Escape");
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    // Fullscreen chat: the panel as its sidebar, Main (before: the week's chat).
    await page.keyboard.press("Control+Shift+F");
    await page.waitForSelector("[data-el='chats-sidebar']");
    if (after) await page.click("[data-thread='main']");
    else await page.click("[data-el='chats-sidebar'] button:has-text(\"What's due this week?\")");
    await page.waitForTimeout(900);
    await shot("main");
    // The composer and the row under it: the model, the context, Clear, Chats.
    await page.screenshot({ path: join(out, `composer-${side}.png`), clip: { x: 272, y: 780, width: 1128, height: 120 } });
    (shots.composer ??= {})[side] = join(out, `composer-${side}.png`);
    // A project's thread (before: a chat in the project).
    if (after) await page.click("[data-thread='project-coconut']");
    else await page.click("[data-el='chats-sidebar'] button:has-text('Tile overlap')");
    await page.waitForTimeout(900);
    await shot("project");
    // Clear on Main: blank at once, no divider (before: there was no Clear; the same chat is shown).
    if (after) {
      await page.click("[data-thread='main']");
      await page.waitForTimeout(700);
      await page.click("[data-el='clear-thread']");
      await page.waitForTimeout(120);
    } else {
      await page.click("[data-el='chats-sidebar'] button:has-text(\"What's due this week?\")");
      await page.waitForTimeout(700);
    }
    await shot("clear");
    // Settings → Models.
    await page.evaluate(async () => {
      const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/src\/store\.ts/.test(n));
      const s = (await import(url)).useStore;
      if (s.getState().chatFullscreen) s.getState().toggleChatFullscreen();
      s.getState().setShowSettings(true);
    });
    await page.waitForTimeout(1200);
    await shot("settings");
    const errs = [...log.pageErrors.map((e) => e.text.split("\n")[0]), ...log.console.filter((m) => m.type === "error").map((m) => m.text.slice(0, 200))];
    console.log(`desktop ${side}: ${errs.length ? errs.slice(0, 4).join(" | ") : "no page errors"}`);
  } finally {
    await browser.close();
  }
}

async function phone(side) {
  const { browser, page, log } = await launch({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  try {
    await page.goto(`${origin}/${side}/phone?scenario=p3-phone-chats`, { timeout: 180000 });
    await page.waitForFunction(() => window.__previewPhone?.ready, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1800);
    const p = join(out, `phone-${side}.png`);
    await page.screenshot({ path: p });
    (shots.phone ??= {})[side] = p;
    const errs = [...log.pageErrors.map((e) => e.text.split("\n")[0]), ...log.console.filter((m) => m.type === "error").map((m) => m.text.slice(0, 200))];
    console.log(`phone ${side}: ${errs.length ? errs.slice(0, 4).join(" | ") : "no page errors"}`);
  } finally {
    await browser.close();
  }
}

for (const side of ["before", "after"]) {
  await desktop(side);
  await phone(side);
}

// Side by side: before | after, each labelled.
const { browser, page } = await launch({ width: 2860, height: 1000 });
try {
  for (const [name, s] of Object.entries(shots)) {
    const img = (p) => (p ? `data:image/png;base64,${readFileSync(p).toString("base64")}` : "");
    const cell = (label, p) =>
      `<figure style="margin:0"><figcaption style="font:600 18px system-ui;color:#ddd;margin:0 0 8px">${label}</figcaption>${p ? `<img src="${img(p)}" style="display:block;${name === "phone" ? "height:844px" : "width:1400px"};border:1px solid #444">` : `<div style="width:1400px;height:900px;border:1px dashed #555;color:#888;font:16px system-ui;display:flex;align-items:center;justify-content:center">(no counterpart before)</div>`}</figure>`;
    await page.setContent(`<body style="margin:0;background:#1a1a1a;padding:20px;display:flex;gap:20px;width:max-content">${cell("Before", s.before)}${cell("After", s.after)}</body>`);
    await page.waitForTimeout(200);
    const el = await page.$("body");
    await el.screenshot({ path: join(out, `${name}.png`) });
    console.log(`${name}: ${join(out, `${name}.png`)}`);
  }
} finally {
  await browser.close();
}
