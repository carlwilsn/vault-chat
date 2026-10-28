// A dev server the agent started (StartJob) and the video it recorded, on the laptop and the phone: a job is a row of
// the background-tasks chip with Stop and no Steer (there is no one to steer); it is not work the voice waits on; a
// `.webm` / `.mp4` in a reply plays inline (muted, with controls) where an image would show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createPhoneMarkdown } from "../../phone/src/markdown.ts";
import { subagentsHtml } from "../../phone/src/extras.ts";
import { waitInputs } from "../../src/voiceWaitLine.ts";
import { tasksSummary, taskActivity } from "../../src/backgroundTasks.ts";

const { Subagents } = await import("../../src/chatExtras.tsx");

const now = Date.now();
const job = { threadId: "vite-mh2k1", kind: "job", title: "vite", task: "npm run dev", state: "running", status: "running", startedAt: now - 65_000, background: true, activity: "serving localhost:5173" };
const worker = { threadId: "w1", title: "study guide", state: "running", status: "running", startedAt: now - 5_000, background: true, activity: "writing guide.md" };

test("laptop chip: a job row has Stop and no Steer; a worker keeps both", () => {
  const html = renderToStaticMarkup(createElement(Subagents, { list: [job, worker] as any, variant: "strip", onControl: async () => null, defaultOpen: true }));
  const rows = html.split('data-el="task"').slice(1);
  assert.equal(rows.length, 2);
  assert.match(rows[0]!, /data-sid="vite-mh2k1"/);
  assert.match(rows[0]!, /serving localhost:5173/);
  assert.match(rows[0]!, /data-el="task-stop"/);
  assert.doesNotMatch(rows[0]!, /data-el="task-steer"/);
  assert.match(rows[1]!, /data-el="task-steer"/);
  assert.equal(tasksSummary([job, worker] as any), "2 background tasks running");
  assert.equal(taskActivity(job as any), "serving localhost:5173");
});

test("phone chip: the same", () => {
  const html = subagentsHtml([job, worker] as any, "strip", true);
  const [, a, b] = html.split('data-el="subagent"');
  assert.match(a!, /data-op="stop"/);
  assert.doesNotMatch(a!, /data-op="steer"/);
  assert.match(b!, /data-op="steer"/);
});

test("a stopped job is a finished row (no buttons)", () => {
  const html = renderToStaticMarkup(createElement(Subagents, { list: [{ ...job, state: "stopped", status: "stopped", endedAt: now }] as any, variant: "inline", onControl: async () => null, defaultOpen: true }));
  assert.match(html, /1 background task stopped/);
  assert.doesNotMatch(html, /task-stop/);
});

test("the voice's waiting line never waits on a dev server", () => {
  const r = waitInputs({ running: false, tools: [], subagents: [job, worker] as any, now });
  assert.deepEqual(r.works.map((w) => w.key), ["w1"]);
  const ended = waitInputs({ running: false, tools: [], subagents: [{ ...job, state: "stopped", endedAt: now }] as any, now });
  assert.deepEqual(ended.samples.Delegate, []);
});

test("phone: a video in a reply plays inline from the box's file route; an image stays an image", () => {
  const md = createPhoneMarkdown({ toHtml: renderToStaticMarkup, fileUrl: (p) => "/file?path=" + encodeURIComponent(p) });
  const html = md("Here it is working:\n\n![the counter going up](.vault-chat/visuals/counter.webm)\n\n![chart](.vault-chat/visuals/c.png)");
  assert.match(html, /<video [^>]*src="\/file\?path=\.vault-chat%2Fvisuals%2Fcounter\.webm"/);
  assert.match(html, /<video [^>]*controls=""/);
  // Muted as an attribute in the HTML the page sets (React keeps `muted` as a property only), exactly once.
  assert.match(html, /<video [^>]*muted=""/);
  assert.equal((html.match(/muted=/g) ?? []).length, 1);
  assert.match(html, /<video [^>]*playsInline=""|<video [^>]*playsinline=""/i);
  assert.match(html, /<img [^>]*src="\/file\?path=\.vault-chat%2Fvisuals%2Fc\.png"/);
  assert.match(md("![demo](https://example.com/clip.mp4)"), /<video [^>]*src="https:\/\/example\.com\/clip\.mp4"/);
});
