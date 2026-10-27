// "You keep it": a git project's hand-over (ReadyForReview) as the laptop and the phone show it — the same view
// (src/convlog/view.ts) folds the call into a proof card with two actions, Keep and Send back; Carl's answer is
// his own line after it (only the answer, never what the server did after); the laptop's card renders its
// options as buttons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const review = await import("../../src/review.ts");
const { fold } = await import("../../src/convlog/reduce.ts");
const { makeChatView } = await import("../../src/convlog/view.ts");

const args = { title: "Bigger heading", branch: "agent/bigger-heading", what: "The h1 is 2em.", why: "Carl asked.", tests: "npm test: 12 passed", images: ["proof/after.png", "/tmp/run.mp4"] };

test("the card: title and branch, what, why, the tests, the screenshots in the vault, Keep and Send back", () => {
  const c = review.reviewCard("call_7", args);
  assert.match(c.content, /^\*\*Ready to keep: Bigger heading\*\* · `agent\/bigger-heading`/);
  assert.match(c.content, /\*\*What changed\.\*\* The h1 is 2em\./);
  assert.match(c.content, /\*\*Tests\.\*\*\n\n```\nnpm test: 12 passed\n```/);
  assert.match(c.content, /!\[proof 1\]\(\.vault-chat\/proof\/call_7\/1-after\.png\)/);
  assert.match(c.content, /\[▶ 2-run\.mp4\]\(\.vault-chat\/proof\/call_7\/2-run\.mp4\)/);
  assert.deepEqual(c.options.map((o) => o.answer), ["Keep", "Send back"]);
  assert.equal(review.proofImagePath("call 7/x", 0, "C:\\shots\\a b.png"), ".vault-chat/proof/call_7_x/1-a_b.png");
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
  const card = msgs.find((m: any) => m.askOptions?.length) as any;
  assert.ok(card, "a card");
  assert.match(card.content, /Ready to keep: Bigger heading/);
  assert.deepEqual(card.askOptions.map((o: any) => o.answer), ["Keep", "Send back"]);
  const after = msgs.slice(msgs.indexOf(card) + 1);
  assert.ok(after.some((m: any) => m.role === "user" && m.content === "Make it 3em"), JSON.stringify(after.map((m: any) => [m.role, m.content])));
  assert.ok(!msgs.some((m: any) => m.role === "user" && /Sent back/.test(m.content)));
});

test("the laptop's card: Keep and Send back as its options", async () => {
  const { AskOptions } = await import("../../src/chatExtras.tsx");
  const c = review.reviewCard("call_7", args);
  const html = renderToStaticMarkup(createElement(AskOptions, { options: c.options, live: true, chosen: "", onPick: () => {} }));
  assert.match(html, /Keep/);
  assert.match(html, /Send back/);
  assert.match(html, /data-live="1"/);
});
