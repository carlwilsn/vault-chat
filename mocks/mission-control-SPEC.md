# Build spec — Desktop Mission Control

Implement a **Mission Control** modal in the desktop app (`src/`). This spec is
self-contained: the fresh cloud session has no memory of the design chat that
produced it. The **visual + interaction reference is the working mock at
`mocks/mission-control.html`** — open it, read it, and match its layout,
spacing, and behavior. It is built with the app's real tokens, so it is the
source of truth for look-and-feel. This markdown is the source of truth for
*behavior + data wiring*.

Addresses the open note "Desktop App Mission Control Integration" (id `49ef0014`).

## The idea

A single rocket-icon button in the titlebar opens a large modal with three tabs
— **Missions**, **Schedules**, **Notifications** — that mirrors the phone
cockpit's Activity + Alerts, but native to the desktop. It is a filtered index
into data the app already has; clicking a row opens that thread's detail inline.

## Titlebar changes (`src/Titlebar.tsx`)

- Add a **Mission control** icon button using the lucide `Rocket` icon (`h-3.5 w-3.5`),
  placed in the LEFT icon group, immediately after the Notes button and before the
  mic group. Use the same button classes as the other left-group icon buttons.
  Active state (`bg-accent text-foreground`) when the modal is open.
- Show a small attention dot on the rocket (top-right, `h-1.5 w-1.5 rounded-full`)
  when there is anything actionable: a failed/errored mission OR an unread
  `ask`-kind notification. Use `bg-destructive` if there's a failure, else `bg-primary`.
- **Remove the History button** (the `History` icon that sets `showHistory`) from the
  titlebar. History stays reachable via its Ctrl+H shortcut / existing modal wiring —
  only the titlebar button is removed.
- **Remove the standalone Schedules button** (the `Clock` icon that toggles
  `showSchedulesPanel`) from the titlebar. Schedules now live inside Mission Control
  as a tab (see below). Keep the underlying `SchedulesPanel` code/logic — we reuse it.
- Keep Notes, Voice, Refresh, Hidden, vault picker, panel toggles, terminal, north
  star, settings as they are.

## Modal shell (`src/MissionControlModal.tsx`, new)

- Gate on a new store flag `showMissionControl` (add to `src/store.ts` with a setter,
  mirroring `showHistory`/`showSchedulesPanel`). Render `<MissionControlModal>` from
  the same place `HistoryModal`/`NorthStarModal` are rendered in `Titlebar.tsx`.
- **Overlay + panel EXACTLY like `HistoryModal`:** overlay
  `fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm`,
  close on backdrop mousedown. Panel:
  `w-[920px] max-w-[92vw] max-h-[85vh] flex flex-col rounded-md border border-border bg-card shadow-xl overflow-hidden`.
  (User asked for a LARGE modal — match History's dimensions.)
- **Header + tabs like `HistoryModal`:** a rocket icon + underline tabs
  (`px-3 py-1.5 text-[12px] border-b-2 -mb-px`, active `border-primary text-foreground`,
  inactive `border-transparent text-muted-foreground hover:text-foreground`).
  Right side: a per-tab action slot (Schedules → "New"; Notifications → "Mark all read")
  and a close (X) button.
- **Scrolling:** header/tabs are fixed; each tab's list is the single scroll region
  (`flex-1 overflow-auto min-h-0`). In a detail view, the header is fixed, the thread
  body is the scroll region, and the composer footer is fixed at the bottom. Long
  threads pin to the bottom on open. No nested/double scrollbars.
- Esc closes the detail view if one is open, else closes the modal.

## Missions tab

Data: build from `useStore().conversations` (see `src/conversations.ts`) — the same
data the phone's `loadActivity` uses. Group by mission key:
`(c.mission || c.title).trim()`. A mission's supervisor thread is the conversation with
`source === "mission"`; its workers are conversations with `source === "worker"` sharing
the mission key. Running state comes from live run status (mirror how `ChatPane`/the
store tracks `status === "running"`).

- **Sections:** `Running` (missions with any live run) then `Recent` (idle, not
  completed). **Do NOT add a "Needs attention" section** — the phone has no such
  section and the user rejected it. A failed/errored mission stays in the active list
  as a normal mission row with an inline error state (destructive dot + destructive
  preview text); its failure ALSO shows in Notifications. Completed missions
  (`completedAt` set) live only in the collapsible **Archive** at the bottom.
- **Row = `ChatsPanel` Row style** (this is mandatory — reuse the exact classes):
  `border-b border-border/40`, leading status dot (white pulsing = running, `bg-primary` =
  done/unseen, `bg-muted-foreground/40` = idle, `bg-destructive` = failed), title
  `text-[12.5px]`, preview `text-[10.5px] text-muted-foreground`, relative time.
  Do NOT put a rocket icon on each row (user rejected per-row icons).
- Under a running mission, show its worker threads as indented rows (same Row style,
  smaller title) so the mission's at-a-glance state is visible without opening it.
- **Click a mission row → mission detail** (inline view swap):
  - **Done when:** parse the mission brief's checklist and render it as the app's
    existing **`AgentTodoList` "Plan" card** style (`rounded-md border border-border/60
    bg-muted/30`, dots: `bg-emerald-600` done / `bg-primary animate-pulse` in-progress /
    `bg-muted-foreground/40` pending, `N/M` count, line-through on done). Port the
    phone's `parseDoneWhen` (in `src-tauri/assets/phone.html`) to derive the bullets from
    the `MISSION BRIEF` user turn; fall back to the goal text.
  - **Thread:** render the supervisor conversation using the app's real
    `MessageBubble` rendering (user = `bg-primary/90` bubble; assistant = markdown prose;
    tool calls = the collapsible `<details>` "N tool calls" with `font-mono text-primary`
    names and `bg-muted` `<pre>` blocks). While the supervisor is mid-turn, show the
    live `ThinkingIndicator` (pulse + token estimate) — do NOT invent a colored
    thought-chain timeline; the desktop renders prose + collapsible tools.
  - **Workers list:** `Workers · N`, each a row that opens that worker's thread.
  - **Footer composer** identical to `ChatPane`'s composer (rounded-2xl input, trailing
    button group). When the supervisor is mid-turn the trailing button is the **filled
    `Square` Stop** (secondary `Button`, stops the current turn) — exactly as `ChatPane`
    does; otherwise the `ArrowUp` Send. Sending steers the supervisor (a normal message
    to the mission conversation).
  - **Stop mission** (kills supervisor + workers, tombstone-delete) is a subtle
    `text-destructive` link in the detail header with a confirm-on-second-click
    ("Stop mission" → "Confirm?"), matching the app's destructive-as-text-link
    convention (like SchedulesPanel's Delete). Shown only for running/failed missions.
  - A completed (read-only) mission still shows the composer (you can ask the
    supervisor about finished work) but no Stop.
- **Worker detail = READ-ONLY** (user decision, matches phone): supervisor↔worker
  thread only, no composer, with the note: "This back-and-forth is the supervisor
  briefing and steering the worker — not you. Read-only: if it's off track, steer the
  supervisor or re-scope the mission." Back arrow returns to the mission.

## Schedules tab

**Reuse the existing `SchedulesPanel` logic verbatim** — do not reinvent it, and do
not change how schedules already work. Extract its `ListView` + `FormView` (and helpers
`recurrenceWhenLabel`, `nextFireAt`, `untilLabel`, etc.) so they render inside the
Mission Control tab instead of the right-side sheet. Same rows (recurrence pill,
soon/paused, prompt preview, last-fired/next times, `vc-checkbox` enable toggle,
**hover-reveal trash** to delete), same full form (Daily/Weekdays/Weekly/Every/Once/Cron
with conditional sub-controls, Fires-into new/existing, Model, Prompt, Mark-unread,
footer Delete/Cancel/Save). The tab's "New" header action opens the form. Deleting a
schedule keeps its tombstone behavior (`schedules-deleted.jsonl`). If cleanly extracting
is risky, instead render the existing `SchedulesPanel` body inside the tab; the key
requirement is **no regression** to current schedule behavior.

## Notifications tab

Desktop currently has no notifications reader. Source the same data the phone's
`loadAlerts` uses (`notifications.jsonl` for the vault; see how the phone server's
`/notifications` endpoint reads it, and how notes are read in the desktop for a parallel
pattern). If wiring live reads is too large, read `notifications.jsonl` directly from the
vault via an existing Tauri fs command.

- **Sections:** `Needs a reply` (`kind === "ask"`, unread) then `Heads-up` (other
  unread), then a collapsible **Archive** (read). Card layout per the mock: small
  token-only icon (primary for ask, destructive for failure, muted for info, emerald for
  success/result), title, age, uppercase intention metabar, 2-line summary.
- **"Mark as seen" button (user explicitly asked for this):** every unread card shows a
  hover **check** button ("Mark read"); read cards show a hover **archive** button. The
  detail view for an info alert has a footer **"Mark as seen"** (a.k.a. "Got it") button;
  an `ask` alert has a **"Reply to supervisor"** button that opens the asking thread.
  Opening an alert also marks it read (as on phone). "Mark all read" is the header action.

## Phone swipes → desktop equivalents

The phone uses swipe-left for row actions; desktop has no swipe. Use the app's
established **hover-reveal button** convention (as `ChatsPanel`/`SchedulesPanel` already
do for delete):
- Phone: swipe an alert to archive → Desktop: hover the card → Archive button (with a
  short slide-out/fade dismiss).
- Phone: swipe an archived mission to delete → Desktop: hover the archived row → trash
  button that kills+tombstone-deletes the mission (and its workers), gone for all clients.
- Do not add swipe. Hover-reveal is the single, discoverable path.

## Resolved detail questions (from the user, do these)

- **Modal size:** large — `w-[920px] max-w-[92vw] max-h-[85vh]` (match HistoryModal).
- **Schedule delete:** hover-trash on the row + Delete in the form footer (both already
  in SchedulesPanel — keep).
- **Notifications "I saw it" button:** implemented as the per-card Mark-read/Archive
  hover actions + the detail "Mark as seen" / "Reply" footer (see Notifications tab).
- **Drop "Needs attention":** removed; failed missions stay inline in the active list and
  surface in Notifications.
- **Delete missions from Archive:** hover-trash on archived mission rows (kill +
  tombstone-delete).
- **Scrolling:** panes scroll independently under fixed tabs; detail body scrolls between
  fixed header and fixed footer.

## Background continuation (related open note, do if time permits)

Note `d54cd90d`: when the user is chatting with a supervisor/worker from Mission Control
and closes the modal (or the app), that conversation should keep running in the
background exactly like a regular chat — it must not pause because the modal closed.
Ensure the mission/worker conversations are the same `Conversation` objects the normal
chat runtime drives, so closing the modal does not stop generation.

## Files (expected)

- `src/MissionControlModal.tsx` (new) — modal, tabs, detail views.
- `src/Titlebar.tsx` — add rocket button + store flag wiring; remove History + Clock
  buttons.
- `src/store.ts` — `showMissionControl` + setter.
- Reuse: `src/ChatsPanel.tsx` (Row style), `src/ChatPane.tsx` (`MessageBubble`,
  composer, `AgentTodoList`, `ThinkingIndicator`, `toolSummary`), `src/SchedulesPanel.tsx`
  (list + form), `src/conversations.ts`, `src-tauri/assets/phone.html` (`parseDoneWhen`,
  mission grouping logic to port).

## Done / verification

1. `npm run build` (or the project's typecheck + vite build) passes with no TS errors.
2. Launch the app (or the mocks/cockpit preview harness) and confirm: rocket opens the
   modal; three tabs switch; a mission opens with Done-when + thread + workers; a worker
   opens read-only; schedules list + form work unchanged; notifications show + mark-read +
   archive; hover actions reveal; nothing double-scrolls.
3. Keep colors strictly to `src/App.css` tokens (background/foreground/card/popover/
   primary/muted/muted-foreground/accent/secondary/destructive/border) plus `emerald-600`
   only where the app already uses it. No invented hues.
4. Commit in focused commits and push to `main` (this repo ships on push; that is the
   intended delivery — no PR review). Keep commit attribution honest (agent-authored).
   After pushing, confirm the ship workflow succeeds (watch `ship.yml`) and the release
   manifest publishes; avoid back-to-back pushes that cancel the manifest job.
