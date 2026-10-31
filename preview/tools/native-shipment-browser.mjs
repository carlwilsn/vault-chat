import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

export async function appProof({ base, out, id, title, advance, rollback, smoke }) {
  const evidence = { scope: 'Production React App + production HTTP + native Git PRIVATE FIXTURE; preview IPC, NOT installed Tauri/CI/device health.', errors: { console: [], page: [], http: [], network: [], outbound: [] }, calls: [], states: [], failure: null };
  const browser = await chromium.launch({ executablePath: process.env.VC_PROOF_CHROMIUM, headless: true, args: ['--mute-audio'] });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('console', m => { if (m.type() === 'error') evidence.errors.console.push(m.text()); });
    page.on('pageerror', e => evidence.errors.page.push(String(e.stack ?? e)));
    page.on('requestfailed', r => evidence.errors.network.push({ url: r.url(), error: r.failure() }));
    page.on('response', r => { if (r.status() >= 400) evidence.errors.http.push({ url: r.url(), status: r.status() }); });
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin === new URL(base).origin || ['data:', 'blob:', 'about:'].includes(u.protocol)) return route.continue();
      evidence.errors.outbound.push(u.href); return route.abort();
    });
    await page.goto(`${base}/?scenario=native-shipment-app&base=synthetic&narrate=0&overlay=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__preview?.ready && window.__preview.stepsDone);
    // Real controls only: expose the actual chats list and choose the server-created project.
    const project = page.locator('[data-el="thread-project"][data-thread="project-app"] > button').getByText('app', { exact: true });
    const pickProject = async () => {
      if (!await page.locator('[data-el="chats-sidebar"]').count()) await page.keyboard.press('Control+Shift+f');
      await page.locator('[data-el="chats-sidebar"]').waitFor({ state: 'visible' });
      await project.click();
    };
    await pickProject();
    const card = page.locator(`[data-shipment-id="${id}"]`);
    await card.waitFor({ state: 'visible' });
    assert.equal(await card.getAttribute('data-shipment-status'), 'accepted');
    assert.match(await card.innerText(), new RegExp(title));
    evidence.states.push({ phase: 'accepted-not-shipped', text: await card.innerText() });
    await page.locator('[data-el="tasks-chip"]').click();
    await page.getByText('Inspect synthetic native range', { exact: true }).waitFor();
    await page.screenshot({ path: `${out}/01-app-accepted.png` });
    await card.getByRole('button', { name: 'Proof', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Shipment proof' });
    await dialog.getByText(`Accepted source: ${id}`, { exact: false }).waitFor();
    assert.doesNotMatch(await dialog.innerText(), /PRIVATE_SENTINEL|private-proof|VC_FAKE_SECRET/);
    await page.screenshot({ path: `${out}/02-app-proof-native-source.png` });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    evidence.identity = await page.evaluate(async () => {
      const m = await import(`${location.pathname}node_modules/@tauri-apps/api/core.js`);
      return { sdkIsTauri: m.isTauri(), ipc: typeof window.__TAURI_INTERNALS__?.invoke, preview: !!window.__preview, root: document.getElementById('root')?.childElementCount, installedTauri: false };
    });
    assert.equal(evidence.identity.sdkIsTauri, true); assert.equal(evidence.identity.ipc, 'function'); assert.ok(evidence.identity.root > 0);
    if (!smoke) {
      // Observations enter the real release-health HTTP transport, never UI status setters.
      await advance('pending');
      await page.reload(); await pickProject();
      await page.waitForFunction(id => document.querySelector(`[data-shipment-id="${id}"]`)?.dataset.shipmentStatus === 'health-pending', id);
      evidence.states.push({ phase: 'published-offline-pending', text: await card.innerText() });
      await page.screenshot({ path: `${out}/03-app-health-pending.png` });
      await advance('healthy');
      await page.reload(); await pickProject();
      await page.waitForFunction(id => document.querySelector(`[data-shipment-id="${id}"]`)?.dataset.shipmentStatus === 'shipped', id);
      evidence.states.push({ phase: 'synthetic-native-transport-healthy', text: await card.innerText() });
      await page.screenshot({ path: `${out}/04-app-fixture-shipped.png` });
      await card.getByRole('button', { name: 'Roll back', exact: true }).click();
      await rollback();
      await page.reload(); await pickProject();
      await page.waitForFunction(id => document.querySelector(`[data-shipment-id="${id}"]`)?.dataset.shipmentStatus === 'rolling-back', id);
      evidence.states.push({ phase: 'native-source-revert-accepted-not-shipped', text: await card.innerText() });
      await page.screenshot({ path: `${out}/05-app-source-reverted.png` });
      await advance('revert-healthy');
      await page.reload(); await pickProject();
      await page.waitForFunction(id => document.querySelector(`[data-shipment-id="${id}"]`)?.dataset.shipmentStatus === 'rolled-back', id);
      await page.screenshot({ path: `${out}/06-app-fixture-rolled-back.png` });
      evidence.states.push({ phase: 'synthetic-revert-release-healthy', text: await card.innerText() });
      // Proof bytes are now a private dangling redirect: real file reader must fail visibly.
      await advance('redirect');
      await card.getByRole('button', { name: 'Proof', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      assert.doesNotMatch(await dialog.innerText(), /PRIVATE_SENTINEL|VC_FAKE_SECRET/);
      assert.doesNotMatch(await dialog.innerText(), /Loading proof/);
      await page.screenshot({ path: `${out}/07-app-proof-redirect-attention.png` });
      evidence.states.push({ phase: 'private-redirect-rejected-visible', text: await dialog.innerText() });
    }
    await page.evaluate(() => document.fonts.load('500 12px "Inter"'));
    evidence.runtime = await page.evaluate(() => ({ calls: window.__preview.calls(), unknown: window.__preview.unknown(), refused: window.__preview.refused(), llm: window.__preview.llm(), reports: window.__preview.reports() }));
    assert.deepEqual(evidence.runtime.unknown, []); assert.deepEqual(evidence.runtime.refused, []); assert.deepEqual(evidence.runtime.llm, []);
    for (const key of ['console', 'page', 'network', 'outbound']) assert.deepEqual(evidence.errors[key], [], key);
    // Deliberately rejected private file is the ONLY allowed non-2xx in full mode.
    const unexpected = evidence.errors.http.filter(e => !( !smoke && e.status === 403 && e.url.includes('/api/v1/vault/file?')));
    assert.deepEqual(unexpected, []);
  } catch (e) {
    evidence.failure = String(e.stack ?? e);
    if (page) await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
    throw e;
  } finally {
    if (page) {
      evidence.dom = await page.locator('body').innerText().catch(() => 'unavailable');
      evidence.calls = await page.evaluate(() => window.__preview?.calls()).catch(() => []);
      evidence.unknown = await page.evaluate(() => window.__preview?.unknown()).catch(() => []);
    }
    await browser.close(); writeFileSync(`${out}/app.json`, JSON.stringify(evidence, null, 2));
  }
}
