// Component/projection tests only — these do NOT attest an installed physical Tauri app or a real release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShipmentCard } from "../../src/shippingProtocol.ts";
import { ShipmentCards } from "../../src/ShipmentCards.tsx";
import { rollbackPending, shipmentArtifactUrl, shipmentLabel, shipmentsForThread } from "../../src/shipmentView.ts";

const card: ShipmentCard = {
  id: "accepted-1", project: "vault-chat", convId: "project-vault-chat", title: "A real change <not HTML>",
  acceptedAt: "2026-10-24T01:00:00Z", sourceRevision: "a".repeat(40), status: "accepted",
  proof: { summaryUrl: "/file?vault=school2&path=.vault-chat%2Fshipments%2Fproof%2Faccepted-1%2Fsummary.md", mediaUrls: ["/file?vault=school2&path=recording.webm"] },
};

test("shipment journal projections are scoped to BOTH conversation and project, ordered and deduped by accepted id", () => {
  const later = { ...card, id: "accepted-2", acceptedAt: "2026-10-24T02:00:00Z" };
  const unrelated = { ...card, id: "other", project: "other-project" };
  const otherThread = { ...card, id: "main", convId: "main" };
  const updated = { ...card, status: "shipped" as const };
  assert.deepEqual(shipmentsForThread([later, card, unrelated, otherThread, updated], card.convId, card.project), [updated, later]);
  assert.deepEqual(shipmentsForThread([card], "main", card.project), []);
  assert.deepEqual(shipmentsForThread([card], card.convId, null), []);
});

test("Shipped is used only for the server's shipped status; published and pending never imply completion", () => {
  for (const status of ["accepted", "published", "health-pending", "rolling-back", "rolled-back", "needs-attention"] as const) {
    assert.doesNotMatch(shipmentLabel({ ...card, status }), /^Shipped/);
  }
  assert.equal(shipmentLabel({ ...card, status: "shipped" }), "Shipped");
  assert.equal(rollbackPending({ ...card, rollback: { status: "running" } }), true);
  assert.equal(rollbackPending({ ...card, rollback: { status: "accepted" } }), true);
  assert.equal(rollbackPending({ ...card, rollback: { status: "failed" } }), false);
});

test("proof URLs reject cross-origin, credentials, scripts, local files and malformed input", () => {
  const base = "https://box.example/";
  assert.equal(shipmentArtifactUrl("/file?path=proof.md", base), "https://box.example/file?path=proof.md");
  for (const raw of ["javascript:alert(1)", "file:///private/proof", "data:text/html,hello", "https://other.example/proof", "//other.example/proof", "https://user:pass@box.example/file", "/file\n?path=x", "\\\\other.example\\proof", ""]) {
    assert.equal(shipmentArtifactUrl(raw, base), null, raw);
  }
});

test("shared laptop/phone card escapes titles, shows actual artifact links and source-revert action, not Keep", () => {
  const html = renderToStaticMarkup(createElement(ShipmentCards, { cards: [card], artifactBase: "https://box.example", onRollback: async () => {} }));
  assert.match(html, /Accepted · waiting for release/);
  assert.match(html, /A real change &lt;not HTML&gt;/);
  assert.match(html, /href="https:\/\/box.example\/file\?/);
  assert.match(html, /Roll back/);
  assert.match(html, /Revert this source change/);
  assert.doesNotMatch(html, /Keep|Send back|Shipped:/);
});

test("durable running rollback disables action and a negative health reason stays visible", () => {
  const c: ShipmentCard = { ...card, status: "rolling-back", rollback: { status: "running" }, health: { status: "failed", reason: "Updater API unavailable", box: "healthy", laptop: "failed" } };
  const html = renderToStaticMarkup(createElement(ShipmentCards, { cards: [c], artifactBase: "https://box.example", onRollback: async () => {} }));
  assert.match(html, /disabled=""/);
  assert.match(html, /Roll back requested/);
  assert.match(html, /Updater API unavailable/);
  assert.doesNotMatch(html, /Shipped:/);
});

test("native proof callback uses an actual button so the global capture-phase link handler cannot bypass authenticated transport", () => {
  const html = renderToStaticMarkup(createElement(ShipmentCards, { cards: [card], artifactBase: "https://box.example", onRollback: async () => {}, onOpenProof: async () => {} }));
  assert.doesNotMatch(html, /<a /);
  assert.match(html, />Proof<\/button>/);
  assert.match(html, />Recording 1<\/button>/);
});
