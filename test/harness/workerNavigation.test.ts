// The pure task renderer must not initialize the browser store merely to render
// historical cards or jobs. Child availability comes from the owning pane.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Subagents } from "../../src/chatExtras.tsx";

const worker = { threadId: "native-child", title: "Native delegate", state: "done", status: "done", startedAt: 1, endedAt: 2 };
const job = { ...worker, threadId: "owned-job", kind: "job", title: "Dev server" };
const render = (openableThreadIds?: readonly string[]) => renderToStaticMarkup(createElement(Subagents, {
  list: [worker, job] as any, variant: "inline", defaultOpen: true,
  onOpen: () => {}, openableThreadIds,
}));

test("only an existing native child has a navigation button; jobs never do", () => {
  const rows = render([worker.threadId, job.threadId]).split('data-el="task"').slice(1);
  assert.equal(rows.length, 2);
  assert.match(rows[0]!, /data-el="task-open"/);
  assert.match(rows[0]!, /Native delegate/);
  assert.doesNotMatch(rows[1]!, /data-el="task-open"/);
});

test("a missing child or absent navigation context stays readable, not clickable", () => {
  for (const html of [render([]), render()]) {
    assert.match(html, /Native delegate/);
    assert.match(html, /Dev server/);
    assert.doesNotMatch(html, /data-el="task-open"/);
  }
});
