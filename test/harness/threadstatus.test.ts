// A place's bar (Carl's option B): chevron, icon, name and "+" only, no hover icons. While it works a spinner
// takes the icon's spot; finished unseen, the dot follows the name inside the toggle. The row's padding is the
// same in every state, so the "+" never moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault("vc-threadstatus-"));
const { ThreadRow } = await import("../../src/plugins/chats/ChatsList.tsx");

// The chats without a project have no bar (Carl's design E2): only projects have one.
for (const type of ["project"] as const) {
  for (const state of ["running", "unread", "idle"] as const) {
    for (const actions of ["none", "notes", "menu", "both"] as const) {
      test(`${type}: ${state}, ${actions} — spinner in the icon's spot, dot only when unseen, no hover icons`, () => {
        const html = renderToStaticMarkup(createElement(ThreadRow, {
          entry: {
            type, id: type, title: type, slug: "fixture", active: true,
            running: state === "running", unread: state === "unread",
            chats: [{ id: type, title: type, active: true, running: state === "running", unread: state === "unread", at: 1 }],
          },
          name: "A long project name that must still ellipsize",
          onSelect: () => {},
          ...(actions === "notes" || actions === "both" ? { onNotes: () => {} } : {}),
          ...(actions === "menu" || actions === "both" ? { onRename: async () => {}, onDelete: async () => {} } : {}),
        }));
        assert.match(html, /relative flex items-center gap-1 group pr-0\.5/);
        assert.doesNotMatch(html, /group pr-7/);
        assert.match(html, /truncate flex-1/);
        assert.equal(html.includes('data-el="working"'), state === "running");
        assert.equal(html.includes('title="Done — unseen" role="img"'), state === "unread");
        assert.equal(html.includes("animate-ping"), false);
        assert.ok(!html.includes('data-el="project-notes"'));
        assert.ok(!html.includes('data-el="project-menu"'));
        assert.equal((html.match(/group-focus-within:opacity-100/g) ?? []).length, 0);
      });
    }
  }
}
