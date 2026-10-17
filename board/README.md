# Whiteboard (board/)

An iPad whiteboard served by the box at `/board`, like the phone app at `/phone`:
same server, same auth (a tailnet login, or the `vc_token` cookie the page
provisions). Add it to the Home Screen for fullscreen.

- `npm run build:board` → `board/dist`; `npm run build:server` embeds it (`--board-app`).
- `npm run dev:board` → :1431, proxying `/api` to a box (`VC_BOX`, default :7420).
- Storage: `boards/<slug>/board.json` + `page-N.png` in the vault (format and
  limits: `src/boardFormat.ts`; routes: `server/boards.ts`). `boards/` is hidden
  once in `.vaultchatignore`. The box's sync cycle commits the files like any
  other vault write.
- Ink: Pointer Events (coalesced + predicted), perfect-freehand, a per-page
  bitmap cache under a live canvas (`src/view.ts`).

## Later milestones (designed for, not built)

**The agent sees a board.** Through the page snapshots: `page-N.png`
(1200 px wide, white, written ~2 s after the pen lifts, only for pages that
changed). Its file tools can already read them. Live awareness comes from one
event: on every save the server pushes `{type:"board", slug, rev, pages:[…]}`
on the box's event ring (`/poll`), naming the pages whose PNG changed; the
agent's board context re-reads only those. Strokes stay out of the prompt;
`board.json` is for the app and for diffs.

**The agent places things.** The `items` array in `board.json` (already
parsed and kept by both sides): `{id, kind, page, x, y, w, h, …}` in page
units, `kind` one of `text`, `latex`, `image`, `pdf-page`; images and PDF page
renders as files next to the board (`boards/<slug>/assets/…`) referenced by
path. The app draws an items layer between the page and the ink and can
lasso-move items like strokes. The agent writes through a server route that
does the same rev-checked read-modify-write as a save (a 409 makes the app
reload and merge: items are the agent's, strokes are Carl's, so the merge is
by field). "Worked math" is a `latex` item, or ink later.

**Voice joins.** The existing box voice session (`/api/v1/voice/session`,
ElevenLabs, the same agent tools). The board page opens it like the phone
does, with the open board as context: `contextual_update`s carrying the board
slug, the page in view and "page N changed" on each save, so the voice agent
can look at `page-N.png` when it matters, and place items with the route above.

## What only a real iPad can judge

Pen latency (rAF at 120 Hz needs Safari's "Prefer Page Rendering Updates near
60fps" feature flag off), the pressure curve and stroke widths, palm rejection
with a resting hand, and pinch feel.
