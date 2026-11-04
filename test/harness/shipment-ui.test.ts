// Absence/safety regressions. Real production UI on copied history is a separate release check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fold } from "../../src/convlog/reduce.ts";
import { messagesOf } from "../../src/convlog/view.ts";

const source = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const history = (data: any, seq = 1) => ({ type: "entry", conv: "old", seq, at: seq, entry: { id: `e${seq}`, type: "custom", customType: "vc-note", data } });

test("shipment presentation, polling, stores and components are deleted", () => {
  for (const p of ["src/ChatPane.tsx", "src/boxChat.ts", "src/store.ts", "src/sync.ts", "phone/src/boot.ts"]) {
    assert.doesNotMatch(source(p), /ShipmentCards|ShipmentProofViewer|refreshShipments|shipmentsForThread|\/api\/v1\/shipments|\bshipments\s*[:?]/, p);
  }
  for (const p of ["src/ShipmentCards.tsx", "src/ShipmentProofViewer.tsx", "src/shipmentView.ts", "src/shipmentCards.css"]) assert.equal(existsSync(new URL(`../../${p}`, import.meta.url)), false);
});

test("human shipping prose and arbitrary structured text remain untouched", () => {
  const human = "The shipping failed; please keep my shipping notes.";
  const arbitrary = JSON.stringify({ type: "unknown-custom-event", status: "shipped", text: human });
  const records = [history({ kind: "line", role: "user", text: human }), history({ kind: "notice", text: arbitrary }, 2)];
  const before = JSON.stringify(records);
  const messages = messagesOf(fold(records as any, "old"));
  assert.ok(messages.some(m => m.role === "user" && m.content === human));
  assert.ok(messages.some(m => m.content === arbitrary), "unknown structured JSON is not a shipping discriminator");
  assert.equal(JSON.stringify(records), before);
});

test("no dedicated shipment proof deep-link routing remains", () => {
  // No dedicated deep-link recognition, rejection banner or replacement dashboard remains.
  for (const p of ["src/ChatPane.tsx", "phone/src/boot.ts"]) assert.doesNotMatch(source(p), /Invalid shipment proof|invalid-shipment-proof|shipmentProof|shipmentArtifactUrl/);
  const link = "Historical file: [summary](.vault-chat/shipments/proof/old/summary.md)";
  assert.equal(messagesOf(fold([history({ kind: "line", role: "user", text: link })] as any, "old"))[0].content, link);
});

test("historical review tools retire without hiding original asks and answers", () => {
  for (const name of ["ReadyForReview", "mcp__vault_chat__ReadyForReview"]) {
    const records = [history({ kind: "line", role: "user", text: "Original ask about shipping" }), history({ kind: "tool", name, args: { title: "Old change", images: ["after.png"] }, result: "Carl answered: Keep\n\n---\nOld machine outcome" }, 2), history({ kind: "line", role: "user", text: "Keep" }, 3)];
    const msgs = messagesOf(fold(records as any, "old"));
    assert.ok(msgs.some(m => m.content === "Original ask about shipping"));
    assert.ok(msgs.some(m => m.role === "user" && m.content === "Keep"));
    assert.ok(!msgs.some(m => m.askOptions?.length));
    assert.ok(msgs.some(m => m.toolCalls?.some(t => t.name === "ReadyForReview")), "keep original tools as ordinary folded history");
    assert.ok(!msgs.some(m => /Ready to keep|Old machine outcome/.test(m.content)));
  }
});

test("removed shipment HTTP and projection surfaces leave native health intact", () => {
  const http = source("server/http.ts"), delivery = source("server/changeDelivery.ts");
  assert.doesNotMatch(http, /shipmentCards|shipmentRepo|rollbackShipment|\/api\/v1\/shipments/);
  assert.doesNotMatch(delivery, /proofProjection|shipmentCards|shipmentRepo|appendFileSync|writeFileSync|cards\.jsonl/);
  assert.match(http, /laptopTransportIdentity\(req\)/);
  assert.match(http, /reportLaptopHealth\(repo, identity, b\)/);
  assert.doesNotMatch(delivery, /requestDeliveryRollback|dispatchSourceRollback/);
});

test("native health and binary install controls survive without updater notifications", () => {
  const wire = source("src/shippingProtocol.ts");
  assert.doesNotMatch(wire, /ShipmentCard|ShipmentRelease|ShipmentRollback/);
  assert.match(wire, /ReleaseHealthChallenge/); assert.match(wire, /LaptopHealthReport/);
  assert.match(source("src/laptopReleaseHealth.tsx"), /release-health\/laptop/);
  assert.doesNotMatch(source("server/deploy/vault-chat-update.sh"), /alert\(\)|\balert\s+"|\/api\/v1\/alert/);
  assert.match(source("server/deploy/vault-chat-update.sh"), /^ROLLOVER_RECOVERY_PROTOCOL=1$/m);
  assert.doesNotMatch(source("src/UpdateBanner.tsx"), /notifyUpdated|import\(".\/phoneApp"\)|await notify\(/);
});

test("other tools, user-authored JSON and ordinary questions are never hidden by shipping vocabulary", () => {
  const json = JSON.stringify({ type: "shipment", text: "Human-authored JSON, not a registered machine event" });
  const records = [history({ kind: "line", role: "user", text: json }), history({ kind: "tool", name: "mcp__other__ReadyForReview", args: {}, result: "unrelated MCP tool" }, 2), history({ kind: "tool", name: "AskUser", args: { question: "Which shipping notes?", options: ["A", "B"] }, result: "Carl answered: A" }, 3), history({ kind: "line", role: "user", text: "A", via: "answer" }, 4)];
  const msgs = messagesOf(fold(records as any, "old"));
  assert.ok(msgs.some(m => m.role === "user" && m.content === json));
  assert.ok(msgs.some(m => m.toolCalls?.some(t => t.name === "mcp__other__ReadyForReview")));
  assert.ok(msgs.some(m => m.askOptions?.length === 2));
  assert.ok(msgs.some(m => m.role === "user" && m.content === "A"));
});

// Removing the specialized renderer never removes original tool records.
test("retired review presentation disappears across updates without mutating answers, unrelated tools or notices", () => {
  for (const name of ["ReadyForReview", "mcp__vault_chat__ReadyForReview"]) {
    const originalAnswer = "Send it back: shipping notes must remain exactly as I wrote them.";
    const records = [
      history({ kind: "tool", name, id: "retired", args: { title: "old <script> card" }, result: "Carl answered: " + originalAnswer + "\n\n---\nKept by the old service" }),
      history({ kind: "line", role: "user", text: originalAnswer, via: "answer" }, 2),
      history({ kind: "tool", name: "Notify", args: { title: "Done: shipping notes", body: "Ordinary task completion" }, result: "sent" }, 3),
      history({ kind: "tool", name: "AskUser", args: { question: "Keep these notes?", options: ["Keep", "Send back"] } }, 4),
      history({ kind: "notice", text: "A user-visible source recovery note, not a typed machine event" }, 5),
    ];
    const untouched = JSON.stringify(records);
    const picture = fold(records as any, "old"), canonical = JSON.stringify(picture);
    const messages = messagesOf(picture);
    assert.equal(messages.filter(m => m.role === "user" && m.content === originalAnswer).length, 1);
    assert.ok(messages.some(m => m.toolCalls?.some(t => t.name === "Notify")));
    assert.ok(messages.some(m => m.askOptions?.length === 2));
    assert.ok(messages.some(m => m.content === "A user-visible source recovery note, not a typed machine event"));
    assert.ok(messages.some(m => m.toolCalls?.some(t => t.name === "ReadyForReview")));
    assert.equal(JSON.stringify(picture), canonical, "projection never rewrites canonical items");
    assert.equal(JSON.stringify(records), untouched, "original persisted history is not scrubbed");
  }
});

test("a completed native review result preserves a multiline human answer without its machine outcome", () => {
  const answer = "Not yet.\nThe tests must finish; don't hide this shipping sentence.";
  const records = [
    { type: "entry", conv: "old", seq: 1, at: 1, entry: { id: "call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "native-review", name: "mcp__vault_chat__ReadyForReview", arguments: { title: "Old review" } }] } } },
    { type: "entry", conv: "old", seq: 2, at: 2, entry: { id: "result", type: "message", message: { role: "toolResult", toolCallId: "native-review", toolName: "mcp__vault_chat__ReadyForReview", content: [{ type: "text", text: "Carl answered: " + answer + "\n\n---\nMachine accepted the old range" }] } } },
  ];
  const before = JSON.stringify(records);
  const messages = messagesOf(fold(records as any, "old"));
  assert.deepEqual(messages.filter(m => m.role === "user").map(m => m.content), [answer]);
  assert.ok(!messages.some(m => m.askOptions?.length));
  assert.ok(messages.some(m => m.toolCalls?.length), "raw tool history remains readable");
  assert.equal(JSON.stringify(records), before);
});
