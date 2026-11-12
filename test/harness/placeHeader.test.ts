// A place's header bar only shows or hides its chats, and its "+" sits at the
// header's right end (not on a line under the chats). The same ThreadRow is the
// chat pane's list and the fullscreen chat's sidebar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault("vc-placeheader-"));
const { ThreadRow } = await import("../../src/ChatsPanel.tsx");

for (const type of ["main", "project"] as const) {
  test(`${type}: the header toggles, and its + is in the header row`, () => {
    const html = renderToStaticMarkup(
      createElement(ThreadRow, {
        entry: {
          type, id: type, title: type, slug: "fixture", active: true, running: false, unread: false,
          chats: [{ id: "c1", title: "A chat", active: true, running: false, unread: false, at: 1 }],
        } as any,
        name: "Place",
        onOpenChat: () => {},
        onNewChat: () => {},
      }),
    );
    const header = html.slice(0, html.indexOf('data-el="place-chat-list"'));
    assert.ok(header.includes('data-el="place-toggle"'), "the header is the toggle");
    assert.ok(header.includes('aria-expanded="true"'));
    assert.ok(header.includes('data-el="place-new-chat"'), "+ is in the header row");
    assert.equal((html.match(/data-el="place-new-chat"/g) ?? []).length, 1, "no second New chat line under the chats");
    assert.ok(!html.includes(">New chat<"));
  });
}

for (const [kind, opened, expectSpinner] of [["project", true, false], ["project", false, true], ["main", true, false], ["main", false, true]] as const) {
  test(`${kind} ${opened ? "expanded" : "collapsed"}: its loader ${expectSpinner ? "shows" : "is hidden"} while a chat works`, () => {
    const html = renderToStaticMarkup(
      createElement(ThreadRow, {
        entry: {
          type: kind, id: "p-loader", title: "P", slug: "fixture", active: opened, running: true, unread: false,
          chats: [{ id: "c1", title: "A chat", active: false, running: true, unread: false, at: 1 }],
        } as any,
        name: "Place",
        onOpenChat: () => {},
        onNewChat: () => {},
      }),
    );
    const header = html.slice(0, html.indexOf('data-el="place-chat-list"') >= 0 ? html.indexOf('data-el="place-chat-list"') : undefined);
    assert.equal(header.includes('data-el="working"'), expectSpinner);
    if (opened) assert.ok(html.includes('data-el="working"'), "the chat inside still shows its own loader");
  });
}
