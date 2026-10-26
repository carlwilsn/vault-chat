// Delete and Rename on a project, before and after, in the real app (the preview's real frontend on its fake
// box): the laptop's left panel (a project's row on hover, its ⋯ menu, the confirm under the row, the panel
// after the delete with the screen on Main, Rename in place) and the phone's (the ⋯ on a project's row, its
// sheet, the confirm, the list after). Pairs side by side (before | after) in <out>/<name>.png.
//   node preview/tools/project-delete-shots.mjs <out> [--url http://127.0.0.1:1610]   (needs: node preview/serve.mjs --before <old tree> --after .)
import { launch } from "./browser.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const out = resolve(argv[0] ?? "preview-proof/project-delete");
const origin = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 ? argv[i + 1] : "http://127.0.0.1:1610";
})();
mkdirSync(out, { recursive: true });

/** The box: Main and three projects' threads, a little talk in each. */
const SEED = async () => {
  const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/preview\/runtime\/backend\/host\.ts/.test(n));
  const { fakeBoxLog } = await import(url);
  const box = fakeBoxLog();
  box.create("main", { title: "Main", source: "main", kind: "main" });
  box.append("main", [
    { role: "user", content: "What's due this week?" },
    { role: "assistant", content: "The Psych 221 essay on Friday, and problem set 4 on Monday." },
  ]);
  const proj = (slug, title, talk) => {
    box.create(`project-${slug}`, { title, source: "project", kind: "project", project: slug });
    box.append(`project-${slug}`, talk);
  };
  proj("coconut", "Coconut", [
    { role: "user", content: "What overlap did we settle on for the tiles?" },
    { role: "assistant", content: "128 px on 1024 tiles — it keeps a 40 px coconut whole in at least one tile." },
  ]);
  proj("psych-221", "Psych 221", [{ role: "user", content: "Outline the essay in APA style." }, { role: "assistant", content: "Introduction, the two studies, the comparison, and the limits." }]);
  proj("thesis", "Thesis", [{ role: "user", content: "Where did chapter 2 stop?" }, { role: "assistant", content: "At the related-work table; the section on sparse attention is next." }]);
};

const shots = {};
async function desktop(side) {
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
    await page.evaluate(SEED);
    await page.waitForTimeout(1500);
    // Fullscreen chat: the panel as its sidebar; in Coconut's thread.
    await page.keyboard.press("Control+Shift+F");
    await page.waitForSelector("[data-el='chats-sidebar']");
    await page.click("[data-thread='project-coconut']");
    await page.waitForTimeout(900);
    // The row on hover: before, only the notes button; after, the ⋯ too.
    await page.hover("[data-thread='project-coconut']");
    await page.waitForTimeout(300);
    await shot("hover");
    if (side === "after") {
      await page.click("[data-thread='project-coconut'] [data-el='project-menu']");
      await page.waitForTimeout(300);
      await shot("menu");
      await page.click("[data-el='project-delete-item']");
      await page.waitForTimeout(300);
      await shot("confirm");
      await page.click("[data-el='project-delete-yes']");
      await page.waitForTimeout(1200);
      await page.mouse.move(900, 400);
      await page.waitForTimeout(200);
      await shot("deleted");
      const now = await page.evaluate(async (u) => {
        const s = (await import(u)).useStore.getState();
        return { active: s.activeConversationId, ids: s.conversations.map((c) => c.id) };
      }, await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/src\/store\.ts/.test(n))));
      console.log(`desktop after delete: active=${now.active}; coconut listed=${now.ids.includes("project-coconut")}`);
      // Rename: right-click the row, Rename, the name in place.
      await page.click("[data-thread='project-thesis']", { button: "right" });
      await page.waitForTimeout(250);
      await shot("rightclick");
      await page.click("[data-el='project-rename-item']");
      await page.waitForTimeout(150);
      await page.keyboard.type("Thesis — chapter 2");
      await page.waitForTimeout(150);
      await shot("rename");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(900);
      await shot("renamed");
      // Carl asks the agent for Coconut back: its RestoreProject (the box acts; this screen is not refreshed).
      await page.evaluate(async () => {
        const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/preview\/runtime\/backend\/host\.ts/.test(n));
        (await import(url)).fakeBoxLog().intent({ type: "restoreProject", slug: "coconut" });
      });
      await page.waitForTimeout(2500);
      await shot("restored");
      await page.click("[data-thread='project-coconut']");
      await page.waitForTimeout(900);
      await shot("restored-thread");
      // Back and forth: each thread its own talk.
      for (const id of ["project-psych-221", "project-coconut", "main", "project-coconut"]) {
        await page.click(`[data-thread='${id}']`);
        await page.waitForTimeout(500);
      }
      await shot("switched");
      const txt = await page.evaluate(() => document.body.innerText);
      console.log(`desktop after restore + switching: coconut talk shown=${txt.includes("128 px on 1024 tiles")}; psych talk shown=${txt.includes("Introduction, the two studies")}`);
    }
    const errs = [...log.pageErrors.map((e) => e.text.split("\n")[0]), ...log.console.filter((m) => m.type === "error").map((m) => m.text.slice(0, 200))];
    console.log(`desktop ${side}: ${errs.length ? errs.slice(0, 4).join(" | ") : "no page errors"}`);
  } finally {
    await browser.close();
  }
}

async function phone(side) {
  const { browser, page, log } = await launch({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  const shot = async (name) => {
    const p = join(out, `${name}-${side}.png`);
    await page.screenshot({ path: p });
    (shots[name] ??= {})[side] = p;
  };
  try {
    await page.goto(`${origin}/${side}/phone?scenario=p3-phone-chats`, { timeout: 180000 });
    await page.waitForFunction(() => window.__previewPhone?.ready, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1800);
    await shot("phone-list");
    if (side === "after") {
      const more = await page.$("[data-el='thread-project'] [data-el='project-menu']");
      if (!more) throw new Error("no ⋯ on a project row");
      const name = await page.evaluate((el) => el.closest(".crow2").querySelector(".nm").textContent, more);
      await more.click();
      await page.waitForTimeout(700);
      await shot("phone-menu");
      await page.click(".arch-row[data-k='delete']");
      await page.waitForTimeout(700);
      await shot("phone-confirm");
      await page.click(".arch-row[data-k='yes']");
      await page.waitForTimeout(900);
      await page.click("#convBtn").catch(() => {});
      await page.waitForTimeout(1200);
      await shot("phone-deleted");
      // The agent's RestoreProject brings it back: the open list shows it without a reload.
      await page.evaluate(() => fetch("/api/v2/intent", { method: "POST", body: JSON.stringify({ type: "restoreProject", slug: "bitnet-160m" }) }));
      await page.waitForTimeout(2500);
      await shot("phone-restored");
      const still = await page.$$eval("[data-el='thread-project'] .nm", (els) => els.map((e) => e.textContent));
      console.log(`phone after delete of ${name}: rows=${JSON.stringify(still)}`);
    }
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

const { browser, page } = await launch({ width: 2860, height: 1000 });
try {
  for (const [name, s] of Object.entries(shots)) {
    const img = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
    const isPhone = name.startsWith("phone");
    const cell = (label, p) =>
      `<figure style="margin:0"><figcaption style="font:600 18px system-ui;color:#ddd;margin:0 0 8px">${label}</figcaption>${p ? `<img src="${img(p)}" style="display:block;${isPhone ? "height:844px" : "width:1400px"};border:1px solid #444">` : `<div style="width:${isPhone ? 390 : 1400}px;height:${isPhone ? 844 : 900}px;border:1px dashed #555;color:#888;font:16px system-ui;display:flex;align-items:center;justify-content:center;text-align:center">(none before:<br>no way to delete a project)</div>`}</figure>`;
    await page.setContent(`<body style="margin:0;background:#1a1a1a;padding:20px;display:flex;gap:20px;width:max-content">${cell("Before", s.before)}${cell("After", s.after)}</body>`);
    await page.waitForTimeout(200);
    const el = await page.$("body");
    await el.screenshot({ path: join(out, `${name}.png`) });
    console.log(`${name}: ${join(out, `${name}.png`)}`);
  }
} finally {
  await browser.close();
}
