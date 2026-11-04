// The feed deliberately sends pointer-only captures. The bubble must pass the
// persisted capture path to the existing vault/box image loader, not <img src="">.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { emptyPicture } from "../../src/convlog/reduce.ts";
import { messagesOf } from "../../src/convlog/view.ts";

const vault = makeTempVault("vc-capture-render-");
installFakeTauri(vault);
after(() => rmSync(vault, { recursive: true, force: true }));
const { MessageBubble } = await import("../../src/ChatPane.tsx");
const { useStore } = await import("../../src/store.ts");
useStore.setState({ vaultPath: vault });

const capture = ".vault-chat/captures/pasted.png";
function message(role: "user" | "assistant") {
  // Same shape as a path-only vc.note after noteViaPi; no inline pixels.
  const p = emptyPicture("capture-test");
  p.items.push({ id: "capture", kind: "user", status: "done", text: "issue i dont like", images: [{ path: capture }], at: 1 });
  return { ...messagesOf(p)[0]!, role };
}
for (const role of ["user", "assistant"] as const) {
  test(`${role} pointer-only capture uses the vault image loader`, () => {
    const m = message(role);
    assert.equal(m.attachments?.[0]?.imageDataUrl, "");
    assert.equal(m.attachments?.[0]?.capturedFilePath, capture);
    const html = renderToStaticMarkup(createElement(MessageBubble, { message: m }));
    // Effects don't run in SSR: ChatImage's pending placeholder names the
    // actual input path. A bare img instead loses it (and warns about empty src).
    assert.ok(html.includes(capture), html);
    assert.ok(!/<img\b/.test(html), html);
  });
}

test("inline pixels take precedence; the source document is not a capture fallback", () => {
  const m = message("user");
  const data = "data:image/png;base64,fixture";
  const inline = renderToStaticMarkup(createElement(MessageBubble, {
    message: { ...m, attachments: [{ imageDataUrl: data, capturedFilePath: capture }] },
  }));
  assert.ok(inline.includes(data));
  assert.ok(!inline.includes(capture));
  const source = "private/source-document.pdf";
  const missing = renderToStaticMarkup(createElement(MessageBubble, {
    message: { ...m, attachments: [{ imageDataUrl: "", sourcePath: source }] },
  }));
  assert.ok(!missing.includes(source));
  assert.ok(!/<img\b/.test(missing));
});
