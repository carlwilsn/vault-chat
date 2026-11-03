// Run against the production-compiled app with a prepared, owned real-data copy.
// This does not supply a backend or pretend to be physical Tauri evidence.
import assert from 'node:assert/strict';

export async function verifyViewerChatIdentity(page, { viewerRoot, fileName, settleMs = 3000 }) {
  const composer = page.locator('[data-perf-target="composer"]');
  const draft = await composer.inputValue();
  assert(draft.length > 0, 'identity proof requires a genuine unsent draft');
  const original = await composer.elementHandle();
  assert(original, 'composer must be mounted');
  const readerHandle = await original.evaluateHandle(el => el.closest('.border-l')?.querySelector('.overflow-auto'));
  const reader = readerHandle.asElement();
  assert(reader, 'actual ChatPane reader must be mounted (not a nonexistent test selector)');
  const bounds = await reader.boundingBox();
  assert(bounds, 'reader must be visible');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(300);
  const scrollTop = await reader.evaluate(el => el.scrollTop);
  await composer.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  const selection = await original.evaluate(el => [el.selectionStart, el.selectionEnd]);
  const owner = await page.evaluate(() => localStorage.getItem('vault_chat_active_conv'));
  const check = async label => {
    assert(await original.evaluate(el => el.isConnected), `${label} remounted the composer`);
    assert(await reader.evaluate(el => el.isConnected), `${label} remounted the reader`);
    assert.equal(await composer.inputValue(), draft, `${label} discarded the draft`);
    assert.deepEqual(await original.evaluate(el => [el.selectionStart, el.selectionEnd]), selection,
      `${label} discarded the composer selection`);
    assert(Math.abs(await reader.evaluate(el => el.scrollTop) - scrollTop) < 2,
      `${label} moved the reader`);
    assert.equal(await page.evaluate(() => localStorage.getItem('vault_chat_active_conv')), owner,
      `${label} changed conversation ownership`);
  };
  await page.locator('[data-el="vault-picker"]').click();
  const target = page.locator(`[data-el="vault-picker-item"][data-path="${viewerRoot}"]`);
  await target.waitFor();
  assert.equal(await target.count(), 1, 'exact prepared viewer root must exist');
  await target.locator('button').first().click();
  await page.waitForTimeout(settleMs);
  await check('viewer navigation');
  await page.getByText(fileName, { exact: true }).first().click();
  await page.waitForTimeout(settleMs);
  await check('file opening');
  await original.dispose();
  await readerHandle.dispose();
  return { composerRetained: true, draftRetained: true, selectionRetained: true,
    readerRetained: true, readerScrollRetained: true, ownerRetained: true };
}

// The prepared adapter must expose a short-name tree and a longer-name tree.
// All widths and drags here use the production library's actual DOM geometry.
export async function verifyViewerPaneLayout(page, { shortRoot, longRoot, fileName }) {
  const panes = page.locator('.split-view-container').first().locator(':scope > .split-view-view');
  const width = async () => Math.round((await panes.nth(0).boundingBox()).width);
  const shortWidth = await width();
  const toLongTree = await verifyViewerChatIdentity(page, { viewerRoot: longRoot, fileName });
  const longWidth = await width();
  assert(longWidth > shortWidth + 60, `viewer tree did not refit: ${shortWidth} → ${longWidth}`);
  const toShortTree = await verifyViewerChatIdentity(page, { viewerRoot: shortRoot, fileName });
  const refitShortWidth = await width();
  assert(Math.abs(refitShortWidth - shortWidth) < 3, 'short tree did not refit');
  const sash = await page.locator('.sash').first().boundingBox();
  assert(sash, 'native file-tree sash must be visible');
  const x = sash.x + sash.width / 2, y = sash.y + sash.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 70, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const draggedWidth = await width();
  assert(draggedWidth > shortWidth + 40, 'real pointer drag did not resize the file tree');
  const viewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForTimeout(500);
    assert(await page.locator('[data-perf-target="composer"]').isVisible());
    assert((await panes.nth(1).boundingBox()).width >= 340, 'viewer minimum width lost');
  } finally {
    if (viewport) await page.setViewportSize(viewport);
  }
  return { shortWidth, longWidth, refitShortWidth, draggedWidth, toLongTree, toShortTree };
}
