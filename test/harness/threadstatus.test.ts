// The status belongs to the row's trailing gutter, not before invisible Notes/More controls; the gutter is
// there only while a status dot is (an idle row has no empty strip at its right end).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault("vc-threadstatus-"));
const { ThreadRow } = await import("../../src/ChatsPanel.tsx");

for (const type of ["main", "project"] as const) {
  for (const state of ["running", "unread", "idle"] as const) {
    for (const actions of ["none", "notes", "menu", "both"] as const) {
      test(`${type}: ${state}, ${actions} — status gutter while a dot shows, accessible controls`, () => {
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
        assert.match(html, state === "idle" ? /relative flex items-center gap-1 group pr-1\.5/ : /relative flex items-center gap-1 group pr-7/);
        assert.match(html, /truncate flex-1/);
        if (state === "idle") {
          assert.doesNotMatch(html, /role="img"/);
        } else {
          const label = state === "running" ? "Working…" : "Done — unseen";
          assert.ok(html.includes(`title="${label}" role="img" aria-label="${label}"`));
          assert.match(html, /absolute right-4 top-1\/2 -translate-y-1\/2/);
          assert.equal(html.includes("animate-ping"), state === "running");
        }
        const hasNotes = actions === "notes" || actions === "both";
        const hasMenu = type === "project" && (actions === "menu" || actions === "both");
        assert.equal(html.includes('data-el="project-notes"'), hasNotes);
        assert.equal(html.includes('data-el="project-menu"'), hasMenu);
        assert.equal((html.match(/min-h-\[28px\] min-w-\[28px\]/g) ?? []).length, Number(hasNotes) + Number(hasMenu));
        assert.equal((html.match(/group-focus-within:opacity-100/g) ?? []).length, Number(hasNotes) + Number(hasMenu));
      });
    }
  }
}
