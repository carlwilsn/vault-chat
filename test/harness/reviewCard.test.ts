// Historical test identities retained; assertions now prove no Keep/proof UI and preserved answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const review = await import("../../src/review.ts");
const { fold } = await import("../../src/convlog/reduce.ts");
const { makeChatView } = await import("../../src/convlog/view.ts");

const args = { title: "Bigger heading", branch: "agent/bigger-heading", what: "The h1 is 2em.", why: "Carl asked.", tests: "npm test: 12 passed", images: ["proof/after.png", "/tmp/run.mp4"] };

test("the card: title and branch, what, why, the tests, the screenshots in the vault, Keep and Send back", () => {
  assert.equal("reviewCard" in review, false, "no proof/Keep renderer remains");
  assert.equal(review.ASK_TOOLS.has("ReadyForReview"), false);
});

test("Carl's answer is his line alone: what the server did after the separator is not his", () => {
  assert.equal(review.answerOf("ReadyForReview", `Carl answered: Keep${review.OUTCOME_SEP}Kept: agent/x is in main`), "Keep");
  assert.equal(review.answerOf("AskUser", "Carl answered: Tuesday"), "Tuesday");
  assert.equal(review.answerOf("Bash", "Carl answered: no"), null);
});

test("the thread's view: the call folds into the card with its options; the answer is Carl's line after it", () => {
  const at = 1_700_000_000_000;
  const rec = (seq: number, entry: any) => ({ type: "entry", conv: "project-site", seq, at: at + seq, file: "f", entry: { id: `e${seq}`, parentId: null, timestamp: new Date(at + seq).toISOString(), ...entry } });
  const records = [
    { type: "meta", conv: "project-site", seq: 1, at, patch: { kind: "project", title: "Site" } },
    rec(2, { type: "message", message: { role: "user", content: "Make the heading bigger." } }),
    rec(3, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call_7", name: "ReadyForReview", arguments: args }], timestamp: at + 3 } }),
    rec(4, { type: "message", message: { role: "toolResult", toolCallId: "call_7", toolName: "ReadyForReview", content: [{ type: "text", text: `Carl answered: Make it 3em${review.OUTCOME_SEP}Sent back: Make it 3em.` }] } }),
  ];
  const p = fold(records as any, "project-site");
  const msgs = makeChatView()(p).messages;
  assert.ok(!msgs.some((m: any) => m.askOptions?.length));
  assert.ok(msgs.some((m: any) => m.toolCalls?.some((t: any) => t.name === "ReadyForReview")), "original tool history remains a normal folded tool call");
  assert.ok(msgs.some((m: any) => m.role === "user" && m.content === "Make the heading bigger."));
  assert.ok(msgs.some((m: any) => m.role === "user" && m.content === "Make it 3em"));
  assert.ok(!msgs.some((m: any) => /Ready to keep|Sent back/.test(m.content)));
  assert.equal(records[2].entry.message.content[0].name, "ReadyForReview", "stored original untouched");
});

test("the laptop's card: Keep and Send back as its options", async () => {
  const { AskOptions } = await import("../../src/chatExtras.tsx");
  const options = makeChatView()(fold([{ type: "entry", conv: "old", seq: 1, at: 1,
    entry: { id: "review", type: "custom", customType: "vc-note", data: { kind: "tool", name: "ReadyForReview", args, result: "Carl answered: Keep" } } }] as any, "old")).messages.flatMap(m => m.askOptions ?? []);
  const html = renderToStaticMarkup(createElement(AskOptions, { options, live: true, chosen: "", onPick: () => {} }));
  assert.doesNotMatch(html, /Keep/);
  assert.doesNotMatch(html, /Send back/);
  assert.doesNotMatch(html, /<button/);
});
