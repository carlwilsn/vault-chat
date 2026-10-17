# Whiteboard (board/)

An iPad whiteboard served by the box at `/board`, like the phone app at `/phone`:
same server, same auth (a tailnet login, or the `vc_token` cookie the page
provisions). Add it to the Home Screen for fullscreen (and no Safari
edge-swipe-back).

- `npm run build:board` → `board/dist`; `npm run build:server` embeds it (`--board-app`).
- `npm run dev:board` → :1431, proxying `/api` to a box (`VC_BOX`, default :7420).
- Tests: `test/harness/board-palm.test.ts` (palm rejection against scripted
  traces), `board-geom.test.ts` (erasers, lasso), `boardformat.test.ts`;
  `server/test/boards.test.ts` (routes).

## One infinite canvas

A board is one canvas: pan and pinch in every direction, no pages. Storage is
`boards/<slug>/` in the vault (format and limits: `src/boardFormat.ts`, routes:
`server/boards.ts`; `boards/` is hidden once in `.vaultchatignore`, and the box's
sync cycle commits it like any other vault write):

- `board.json`: `{v: 2, name, rev, grid, items: […], strokes: […]}`, one stroke or item per line.
  A stroke is `{id, tool: "pen"|"hl", color, w, xy: [x, y, …]}` in canvas units
  (1000 ≈ a sheet's width, the default view). Uniform width: no pressure is stored.
  Version 1 (pages, `pts` with pressure) loads with its pages stacked top to
  bottom and is rewritten as version 2 on its first save.
- `assets/<name>`: the files items show (PNG/JPEG now).
- `overview.png`: the whole board, fitted to its content, ≤ 1600 px on its long
  side, written 2 s after the pen lifts. It is the list's thumbnail and what the
  agent looks at. Next: a crop of the region being worked on beside it.

Rendering (`src/view.ts`): cached 512 px bitmap tiles at power-of-two zoom
levels under a live canvas. Only tiles in view are drawn; a finished stroke is
drawn into the tiles it crosses; an edit invalidates only the tiles its bounds
meet. Layers: background (plain, dots, grid) → items → ink. Ink always lies
above items.

## Items

`items: [{id, kind, x, y, w, h, src?}]`, positioned boxes in canvas units.
`image` is rendered now; `pdf`, `math` and `widget` come with the inbox. Every
item behaves the same (Carl, `INBOX.md`): drag it, scale it uniformly (corner
handles keep the aspect ratio, nothing stretches), write on top of it. The
erasers never touch items. For now the board menu has **Insert image…**
(Photos/Files), which uploads to `POST /api/v1/boards/<slug>/assets` and places
the image at the centre of the view, selected.

## The tools

Pen and highlighter (uniform width, a few preset sizes plus a slider, a few
colours each), stroke eraser (removes a stroke it touches), precise eraser
(cuts the part under its circle and splits the stroke; the pieces end exactly
on the circle's edge so their round caps stay clean; `src/geom.ts`), each with
its own size and its circle shown while erasing; select (lasso ink and items
together, or tap an item or a stroke; drag to move, corner handles to scale
uniformly, Delete). Every gesture is one undo step. The board menu (⋯) holds
Insert image, Background, Writing hand and One-finger scroll.

## Palm rejection (`src/palm.ts`)

The pen draws; nothing else does once a Pencil has been seen on the device (before
that, one finger draws). Rules, in order of strength:

1. Pen down or hovering (Pencil hover, iPad Pro M2+ / Pencil Pro), and 600 ms after
   it lifts or leaves hover: every new touch is a palm.
2. A contact wider than 56 css px is a palm; so is a third contact.
3. On the writing hand's side of the last pen position (Left: left of and below
   it; Right: right of and below), within 450 px and 2 s: palm.
4. Two fingers must land within 200 ms of each other; a single finger that rests
   280 ms before moving is a palm (only matters with one-finger scroll on).
5. A palm poisons the whole touch sequence until every finger lifts; a view
   gesture it had started is undone (the camera goes back) if it is under 700 ms
   old. Two-finger pan only zooms once the spread changes 6 %.
6. Two-finger tap = undo, never within 1 s of the pen touching.
7. Toolbar taps: fingers yes, palms (and anything while the pen is down) no.

`?debug=touch` draws each touch's contact size on the board: the numbers to tune
rules 2–3 with on a real iPad.

## The inbox (next step)

The agent never draws on a board; it sends things to the iPad's inbox and Carl
adds them as items. The design is `board/INBOX.md`: the envelope
(`boards/.inbox/<id>/entry.json`), the four kinds (`pdf` pages, `math`,
`image`, `widget`), refusals, and what the agent gets back. Adding a part
creates an item at the centre of the view, carrying its inbox id and label.
The agent sees the board through `overview.png` (and later the work-region crop);
on each save the server can push `{type:"board", slug, rev}` on the event ring
(`/poll`) so its board context re-reads the snapshot only when it changed.

**Voice joins** later: the box voice session opens with the board as context
(`contextual_update`s carrying the slug and "the board changed" on each save).

## What only a real iPad can judge

Pen latency (rAF at 120 Hz needs Safari's "Prefer Page Rendering Updates near
60fps" feature flag off), stroke widths, the palm rules' numbers against a real
resting hand (`?debug=touch`), and pinch feel.
