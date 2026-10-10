// dev: drive Ctrl+K inline edit with real input on the inline-edit scenario.
import { launch } from "./browser.mjs";
const { browser, page, log } = await launch();
await page.goto("http://127.0.0.1:1520/before/?scenario=inline-edit");
await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 30000 });
await page.waitForTimeout(800);
const line = page.locator(".cm-line", { hasText: "The 160M reproduction is stable" }).first();
await line.click();
await page.keyboard.press("Home");
await page.keyboard.press("Shift+End");
await page.keyboard.press("Control+k");
await page.waitForTimeout(600);
await page.screenshot({ path: "out/ctrlk-1.png" });
await page.keyboard.type("tighten this");
await page.keyboard.press("Enter");
await page.waitForTimeout(4000);
await page.screenshot({ path: "out/ctrlk-2.png" });
console.log(JSON.stringify({ errors: log.console.filter((m) => m.type === "error").map((m) => m.text.slice(0, 200)), llm: await page.evaluate(() => window.__preview.llm().map((l) => l.script)) }));
await browser.close();
