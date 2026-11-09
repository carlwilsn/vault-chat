// The chats panel has no Select / bulk-delete mode (Carl: "I don't need the selecting
// feature"): a click on a row opens it, and Delete is per row from its menu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault("vc-noselect-"));
const { ThreadRow } = await import("../../src/ChatsPanel.tsx");

test("a chat row is a plain button: no checkbox, no pressed state, per-row delete wired", () => {
  const html = renderToStaticMarkup(
    createElement(ThreadRow, {
      entry: {
        type: "main", id: "main", title: "Main", slug: "", active: true, running: false, unread: false,
        chats: [{ id: "c1", title: "A chat", active: false, running: false, unread: false, at: 1 }],
      } as any,
      name: "Main",
      onOpenChat: () => {},
      deleteOne: async () => null,
    }),
  );
  assert.ok(html.includes('data-el="place-chat"'));
  assert.ok(!html.includes("chat-pick") && !html.includes("aria-pressed"));
});

test("the source keeps no Select toggle, selection bar or bulk confirm", () => {
  const src = readFileSync(new URL("../../src/ChatsPanel.tsx", import.meta.url), "utf8");
  for (const gone of ["chats-select", "chats-bulk", "chat-pick", "ChatSelect", "ListChecks"]) assert.ok(!src.includes(gone), gone);
  for (const kept of ["chat-menu-delete", "chat-delete-confirm", "The agent can bring it back if you ask"]) assert.ok(src.includes(kept), kept);
});
