// Real keyboard regression check against an already-running app/realbox preview.
// Usage: node preview/tools/typing-check.mjs http://127.0.0.1:PORT/?scenario=...
// Leaves an UNSENT draft. Use an isolated copy, never Carl's active window.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export function installHistoricalCounter() {
  let previous = new WeakSet();
  window.__typingCheck = { active: false, renders: 0 };
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ||= { supportsFiber: true, inject: () => 1 };
  const priorCommit = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (...args) {
    priorCommit?.apply(this, args);
    const next = new WeakSet();
    function visit(fiber) {
      if (!fiber) return;
      next.add(fiber);
      // Bailouts reuse old child fibers AND their stale flags. Don't count
      // those as fresh renders; only newly committed memoized message fibers.
      if (window.__typingCheck.active && !previous.has(fiber)
        && (fiber.tag === 14 || fiber.tag === 15)
        && fiber.memoizedProps?.message?.role && (fiber.flags & 1)) {
        window.__typingCheck.renders++;
      }
      visit(fiber.child); visit(fiber.sibling);
    }
    visit(args[1].current); previous = next;
  };
}

export async function checkTyping(page) {
  const input = page.locator('[data-el="composer"] textarea');
  await input.waitFor();
  const exposed = await input.evaluate(el => {
    for (let p = el; p; p = p.parentElement) {
      if (p.getBoundingClientRect().width < 1) return false;
    }
    return true;
  });
  if (!exposed) await page.keyboard.press('Control+Shift+b');
  await input.click();
  assert(await page.locator('.prose-chat').count() > 10, 'Use a populated real conversation');
  // Force commits while inactive, priming the previous-fiber identity set.
  await input.fill('Warm'); await input.fill('');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const reader = await page.evaluateHandle(() => [...document.querySelectorAll('.overflow-auto')]
    .find(el => el.querySelector('.prose-chat') && el.scrollHeight > el.clientHeight + 300));
  const rect = await reader.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(rect.x, rect.y); await page.mouse.wheel(0, -600);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const before = await reader.evaluate(el => el.scrollTop);
  await input.click();
  await page.evaluate(() => { window.__typingCheck.active = true; window.__typingCheck.renders = 0; });
  await input.pressSequentially('Unsent typing regression check kept draft', { delay: 40 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const renders = await page.evaluate(() => { window.__typingCheck.active = false; return window.__typingCheck.renders; });
  assert.equal(await input.inputValue(), 'Unsent typing regression check kept draft');
  const after = await reader.evaluate(el => ({ connected: el.isConnected, top: el.scrollTop }));
  assert(after.connected && Math.abs(after.top - before) < 1, 'Typing must preserve the scrolled-away reader position');
  assert.equal(renders, 0, 'Composer-only edits must not rerender historical message bubbles');
  return { historicalRenders: renders, draftPreserved: true, readerPositionPreserved: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = new URL(process.argv[2]);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use an owned loopback test instance');
  const { launch } = await import('./browser.mjs');
  const { browser, page, log } = await launch({ width: 1440, height: 960 });
  try {
    await page.addInitScript(installHistoricalCounter);
    await page.goto(url.href);
    console.log(await checkTyping(page));
    assert.deepEqual(log.pageErrors, [], 'No frontend errors');
  } finally { await browser.close(); }
}
