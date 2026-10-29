// The phone's thread bar and its "+" (phone/src/shell, phone/src/attach.ts). Clear is one tap: a
// button of the bar itself (not in a menu or a panel), with the laptop's icon (Lucide's Eraser) and
// a 44 px target; the drawer's "⋯" whose only job was Clear is gone. "+" is one picker for any file
// (no accept, no capture: iOS offers Take Photo, Photo Library and Choose File), and a PDF from the
// Files picker goes to the box's attachments route and comes back as the path the message carries.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Eraser as LucideEraser } from "lucide-react";
import { Header } from "../../phone/src/shell/Header.tsx";
import { ConvDrawer } from "../../phone/src/shell/ConvDrawer.tsx";
import { Pages } from "../../phone/src/shell/Pages.tsx";
import { isPhoto, pendingFile, uploadAttachment } from "../../phone/src/attach.ts";
import { filesLine, splitFilesLine } from "../../src/filesLine.ts";
import { FakeBox } from "./fakeBox.ts";

// The shell is compiled here with the classic JSX transform (React.createElement).
(globalThis as any).React = React;
const root = path.resolve(import.meta.dirname, "../..");
const html = (c: () => unknown) => renderToStaticMarkup(createElement(c as any));
const paths = (s: string) => [...s.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);

test("Clear is one tap from the thread bar: a button of the bar, the laptop's eraser, no menu in between", () => {
  const bar = html(Header);
  // In the bar's own markup (the .hdr), next to the burger — not behind a menu or the drawer.
  assert.match(bar, /^<div class="hdr">/);
  const btn = /<button[^>]*id="clearBtn"[^>]*>([\s\S]*?)<\/button>/.exec(bar);
  assert.ok(btn, "a Clear button in the bar");
  assert.match(btn[0], /data-el="clear-thread"/);
  assert.match(btn[0], /aria-label="Clear this thread"/);
  assert.match(btn[1], /Clear/);
  // The laptop's Clear icon, path for path.
  assert.deepEqual(paths(btn[1]), paths(renderToStaticMarkup(createElement(LucideEraser))));
  // Its tap clears the view (boot.ts), once, with no confirm step: the laptop has none.
  const boot = fs.readFileSync(path.join(root, "phone/src/boot.ts"), "utf8");
  assert.match(boot, /wireTap\(\$\("clearBtn"\), \(\) => clearThread\(\)\);/);
  assert.doesNotMatch(boot, /openThreadsMenu|"newBtn"/);
  // A 44 px target.
  const css = fs.readFileSync(path.join(root, "phone/src/styles/phone.css"), "utf8");
  assert.match(css, /\.clrbtn\{min-width:44px;min-height:44px/);
  // The drawer's "⋯" (its one item was Clear) is gone.
  const drawer = html(ConvDrawer);
  assert.doesNotMatch(drawer, /newBtn|⋯|aria-label="More"/);
});

test('"+" is one picker for any file: no accept, no capture, several at once', () => {
  const page = html(Pages);
  const input = /<input[^>]*id="imgInput"[^>]*>/.exec(page)![0];
  assert.match(input, /type="file"/);
  assert.match(input, /multiple/);
  assert.doesNotMatch(input, /accept=|capture/);
  const btn = /<button[^>]*id="imgBtn"[^>]*>([\s\S]*?)<\/button>/.exec(page)!;
  assert.deepEqual(paths(btn[1]), ["M12 5v14M5 12h14"]);
  // What goes inline as a photo, and what goes to the box as a file.
  assert.equal(isPhoto({ type: "image/jpeg" }), true);
  assert.equal(isPhoto({ type: "image/heic" }), true);
  assert.equal(isPhoto({ type: "application/pdf" }), false);
  assert.equal(isPhoto({ type: "" }), false);
  // The names ride on the message's files line (the laptop's): chips on its bubble.
  const line = "what is this?" + filesLine(["Discussion 5 notes.pdf", "a|b].docx"]);
  assert.deepEqual(splitFilesLine(line), { text: "what is this?", files: ["Discussion 5 notes.pdf", "a b .docx"] });
});

const box = new FakeBox();
before(() => box.start());
after(() => box.close());

test("a PDF from the iOS Files picker uploads to the box's attachment route; the message names it by its box path", async () => {
  const post = (p: string, init: RequestInit) => fetch(box.url + p, init);
  const bytes = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  // What Safari hands the input for a file from Files: a File with its type.
  const file = new File([bytes], "Discussion 5 notes.pdf", { type: "application/pdf" });
  let changed = 0;
  const p = pendingFile(post, file, () => changed++);
  assert.equal(p.state, "uploading");
  await p.done;
  assert.equal(p.state, "ready", p.error);
  assert.equal(changed, 1);
  assert.match(p.path!, /^\.vault-chat\/attachments\/\d{4}-\d{2}-\d{2}\/Discussion 5 notes\.pdf$/);
  assert.ok(fs.readFileSync(path.join(box.attachVault, ...p.path!.split("/"))).equals(bytes));
  // Over the cap: refused here, before any bytes go.
  const big = await uploadAttachment(post, { name: "huge.pdf", size: 26 * 1024 * 1024 } as any);
  assert.equal(big.ok, false);
  assert.match((big as any).error, /huge\.pdf is 26\.0 MB; an attachment can be at most 25 MB/);
});
