import test from "node:test";
import assert from "node:assert/strict";
import { parsePinned, setPinned } from "../../src/pinnedApps.ts";
import { catalogPlugin, catalogText, catalogServices } from "../../src/pluginCatalog.ts";
import { Supervisor, PLUGIN_DESIRED } from "../../src/pluginSupervisor.ts";

test("a page is pinned by its vc-pinned meta; false-ish content is not", () => {
  assert.ok(parsePinned('<meta name="vc-pinned">'));
  assert.ok(parsePinned("<META NAME=vc-pinned content=yes>"));
  assert.ok(!parsePinned('<meta name="vc-pinned" content="false">'));
  assert.ok(!parsePinned('<meta name="viewport" content="vc-pinned">'));
});

test("the toggle adds the declaration once, and removes it again", () => {
  for (const html of ["<html><head><title>T</title></head><body>x</body></html>", "<!doctype html><p>x</p>", "<p>x</p>"]) {
    const on = setPinned(html, true);
    assert.ok(parsePinned(on));
    assert.equal(setPinned(on, true), on);
    assert.equal(setPinned(on, false).replace(/\s+/g, ""), html.replace(/\s+/g, ""));
    assert.ok(!parsePinned(setPinned(on, false)));
  }
});

test("the catalog lists a pinned page as a pinned app, even with no other manifest", () => {
  const p = catalogPlugin("apps/clock.html", '<title>Clock</title><meta name="vc-pinned">');
  assert.deepEqual(p, { id: "apps/clock.html", name: "Clock", mount: "iframe", needs: [], refused: [], pinned: true });
  assert.equal(catalogPlugin("a.html", "<p>plain</p>"), null);
  assert.match(catalogText({ services: catalogServices(), plugins: [p!] }), /- apps\/clock\.html \[pinned app\] "Clock"/);
});

test("the supervisor turns a pinned app off and on like any page", () => {
  const sup = new Supervisor();
  const id = "apps/clock.html";
  assert.equal(sup.desired(id, 10).state, "running");
  sup.fold({ seq: 1, type: "signal", signal: { type: PLUGIN_DESIRED, plugin: id, state: "stopped", at: 5 } });
  assert.equal(sup.desired(id, 10).state, "stopped");
  sup.fold({ seq: 2, type: "signal", signal: { type: PLUGIN_DESIRED, plugin: id, state: "running", at: 6 } });
  assert.equal(sup.desired(id, 10).state, "running");
});
