// Fixture-only interaction checks for the REAL shared React component.
// This is NOT real-server UI proof, a release, or physical installed-Tauri health.
// PREVIEW_BROWSER=$(command -v chromium) node preview/tools/shipment-component-check.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { launch } from "./browser.mjs";

const temp = mkdtempSync(join(tmpdir(), "vc-shipment-component-"));
let browser;
let server;
try {
  const result = await build({
    stdin: { resolveDir: resolve("."), loader: "tsx", contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {ShipmentCards} from './src/ShipmentCards';
      const root=createRoot(document.getElementById('root'));
      window.requests=0; window.proofRequests=0;
      window.draw=(fail=false)=>root.render(<ShipmentCards cards={[{
        id:fail?'failure':'accepted',project:'vault-chat',convId:'project-vault-chat',
        title:'A fixture change',acceptedAt:'2026-10-24T01:00:00Z',sourceRevision:'a'.repeat(40),status:'health-pending',
        health:{status:'pending',reason:'Waiting for the actual laptop',box:'healthy',laptop:'pending'},
        proof:{summaryUrl:'/file?path=summary.md',mediaUrls:[]}
      }]} artifactBase={location.origin} onOpenProof={async()=>{window.proofRequests++}}
      onRollback={async()=>{window.requests++;if(fail)throw new Error('Source revert was refused');await new Promise(r=>window.finish=r)}}/>);
      window.draw();
    ` },
    bundle: true, write: false, outfile: join(temp, "fixture.js"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  });
  const js = result.outputFiles.find((f) => f.path.endsWith(".js")).text;
  const css = result.outputFiles.find((f) => f.path.endsWith(".css")).text;
  server = createServer((req, res) => {
    if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(js); }
    else if (req.url === "/fixture.css") { res.setHeader("content-type", "text/css"); res.end(css); }
    else { res.setHeader("content-type", "text/html"); res.end('<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><style>body{background:#222;color:#ddd;font-family:system-ui;padding:16px}</style><div id="root"></div><script src="/fixture.js"></script>'); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const launched = await launch({ width: 1100, height: 800 });
  browser = launched.browser;
  const { page, log } = launched;
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const card = page.locator("[data-shipment-id=accepted]");
  await card.waitFor();
  assert.match(await card.innerText(), /waiting for health checks/);
  assert.doesNotMatch(await card.innerText(), /Shipped:/);
  assert.match(await card.innerText(), /Waiting for the actual laptop/);
  await page.getByRole("button", { name: "Proof", exact: true }).click();
  assert.equal(await page.evaluate(() => window.proofRequests), 1);
  const rollback = page.getByRole("button", { name: "Roll back", exact: true });
  const rect = await rollback.boundingBox();
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, { clickCount: 2 });
  await page.waitForFunction(() => window.requests === 1);
  assert.equal(await page.getByRole("button", { name: "Roll back requested", exact: true }).isDisabled(), true);
  await page.evaluate(() => window.finish());
  assert.equal(await page.evaluate(() => window.requests), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.draw(true));
  await page.locator("[data-shipment-id=failure]").waitFor();
  await page.getByRole("button", { name: "Roll back", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /Source revert was refused/);
  assert.equal(await page.getByRole("button", { name: "Roll back", exact: true }).isEnabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(log.pageErrors, []);
  assert.deepEqual(log.outbound, []);
  console.log("PASS: shared shipment component fixture — desktop/phone sizing, proof action, one double-click request, disabled pending, honest server rejection. NOT release/device proof.");
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  rmSync(temp, { recursive: true, force: true });
}
