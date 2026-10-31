// The status belongs to the row's trailing gutter, not before invisible Notes/More controls.
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
      test(`${type}: ${state}, ${actions} — fixed status gutter, accessible controls`, () => {
        const html = renderToStaticMarkup(createElement(ThreadRow, {
          entry: {
            type, id: type, title: type, slug: "fixture", active: true,
            running: state === "running", unread: state === "unread",
          },
          name: "A long project name that must still ellipsize",
          onSelect: () => {},
          ...(actions === "notes" || actions === "both" ? { onNotes: () => {} } : {}),
          ...(actions === "menu" || actions === "both" ? { onRename: async () => {}, onDelete: async () => {} } : {}),
        }));
        assert.match(html, /relative flex items-center gap-1 pr-7 group/);
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
        assert.equal((html.match(/group-focus-within:opacity-100/g) ?? []).length, Number(hasNotes) + Number(hasMenu));
      });
    }
  }
}
