# Whiteboard (board/)

An iPad whiteboard served by the box at `/board`, like the phone app at `/phone`:
same server, same auth (a tailnet login, or the `vc_token` cookie the page
provisions). Add it to the Home Screen for fullscreen (and no Safari
edge-swipe-back).

- `npm run build:board` → `board/dist`; `npm run build:server` embeds it (`--board-app`).
- `npm run dev:board` → :1431, proxying `/api` to a box (`VC_BOX`, default :7420).
- Tests: `test/harness/board-palm.test.ts` (palm rejection against scripted
  traces), `board-chrome.test.ts` (after the pen, every control presses once for a Pencil or a finger tap,
  with or without iOS's click), `board-geom.test.ts` (erasers, lasso), `boardformat.test.ts`;
  `server/test/boards.test.ts` (routes), `board-place.test.ts` (where inbox parts land), `server/test/inbox.test.ts` (the validated send, each refusal, the routes, makes).
- The chrome is Tailwind (`board/tailwind.config.js`: the desktop's config and tokens as a preset, iPadOS colours, light and dark); the canvas engine is plain TypeScript.
- Preview data: `npx tsx board/preview/seed-inbox.ts <vault> [box url]` seeds a box's inbox through the real send.

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

`items: [{id, kind, x, y, w, h, src?, …}]`, positioned boxes in canvas units. Every item behaves the
same (Carl, `INBOX.md`): drag it, scale it uniformly (corner handles keep the aspect ratio, nothing
stretches), write on top of it. Ink lying wholly inside an item moves and scales with it (one undo
step); ink that only crosses its edge stays. The erasers never touch items. Kinds (`src/items.ts`):

- `image`: PNG/JPEG/WebP/SVG, drawn in the tiles.
- `pdf` (`page`, `lw`×`lh` in points, `snap`): the page's PNG (1600 px on its long side, made by pdf.js when the
  page is added, or the first time an older board opens) is what opening the board shows, at once; pdf.js renders
  the page only when it is seen closer than that PNG is sharp, and again sharper when the camera settles zoomed in.
  Board assets never change under their name, so the browser keeps them (`immutable`). Opening a board: its pages are
  on screen in about 0.2–0.3 s (pdf.js alone took 0.8–1.2 s).
- `math`: the box's typeset markdown (KaTeX HTML, `assets/*.html`), as DOM: vector at any zoom.
- `widget`: the bundle in an iframe (`sandbox="allow-scripts"`, CSP `default-src 'none'`), laid out
  once at `lw`×`lh` css px and zoomed as a whole; it takes touches only after **Interact** (Done, or a
  touch elsewhere, ends it).

Math and widgets sit under the base canvas, which is transparent where they are, so ink always lies
above them; `snap` (the box's PNG of them) is what the overview draws. **Insert image…** in the board
menu uploads to `POST /api/v1/boards/<slug>/assets`. Items from the inbox come from
`POST /api/v1/boards/<slug>/from-inbox {id, part?}` (the files copied into `assets/`, named by content).
Board files are served inert: an SVG or PDF with CSP `sandbox`, math and bundles as plain text.

## The tools

Pen and highlighter (uniform width, a few preset sizes plus a slider, a few
colours each; the button shows its colour), one eraser button (tap it again for
Stroke / Precise and its size, both remembered): stroke eraser (removes a stroke it touches), precise eraser
(cuts the part under its circle and splits the stroke; the pieces end exactly
on the circle's edge so their round caps stay clean; `src/geom.ts`), each with
its own size and its circle shown while erasing; select (lasso ink and items
together, or tap an item or a stroke; drag to move, corner handles to scale
uniformly: 12 px handles, 44 px hit areas; Delete, and Interact for a widget). Every gesture is one undo step. The board menu (⋯) holds
Insert image, Background, Writing hand and One-finger scroll.

## Palm rejection (`src/palm.ts`)

The pen draws. One finger pans (One-finger scroll, on by default; off, a finger writes until a Pencil has
been seen). Two fingers pan and pinch whenever the Pencil is not touching the screen. Rules:

1. Pen down: every touch is a palm, and a gesture it lands in is undone if young (under 700 ms).
2. Contact sizes are iPadOS's (twice UITouch's majorRadius, in ~20.9 px steps: a fingertip 41.75 or
   62.6, a thumb or a pressed finger 83.5, a palm 104+). A contact 95 css px or wider is a palm; so is a
   third contact. (Until 2026-10-18 the limit was 56: most real fingers and every thumb were palms.)
3. One finger is a palm while the pen hovers (Pencil hover, iPad Pro M2+ / Pencil Pro) and 600 ms after it
   lifts or leaves hover; on the writing hand's side of the last pen position (Left: left of and below it;
   Right: right of and below) within 450 px and 2 s; and when it rests 280 ms before moving.
4. Two fingers land within 280 ms of each other. A pair is never stopped by hover, the lockout after the
   pen or the hand side; a pair that lands while the pen is near must move 24 px (not 10) before it pans,
   so a palm settling as two small contacts does not nudge the page. It zooms once its spread changes 6 %
   and 16 px.
5. A palm poisons the whole touch sequence until every finger lifts.
6. Two-finger tap = undo, never within 1 s of the pen touching.
7. The chrome (toolbar, popovers, menu, inbox, selection pill) is not the arbiter's: any pointer that lands
   on it, Pencil or finger, presses its button on pointerup, once (`src/chrome.ts`; the click iOS may add after
   it is dropped, wherever it lands). Palm rules apply on the canvas only.

`?debug=touch` draws each touch's contact size on the board. The board's log (`gestures` lines) counts
pans, pinches, one-finger pans, undo taps and each palm rejection by reason, with the largest contact seen:
what a real-device report is read from. Proof in WebKit with the iPad's Mac UA and real contact sizes:
`board/preview/gestures.mjs`.

## The inbox

The agent never draws on a board; it sends things to the iPad's inbox (`board/INBOX.md`; storage and
the validated send: `server/inbox.ts`; format: `src/inboxFormat.ts`). The inbox icon's badge counts
unread entries, live from `{type:"inbox"}` on `/poll`. The sheet lists entries (being made, couldn't
make, unread); an entry's viewer shows its parts; **Add all** or **Add** per part lands them at the
centre of the view, selected (`src/place.ts`), and tells the box which items they became.

The agent's tools (`server/engine/engine.ts`): **BoardSend** (validated: PDF pages in range and ≤ 20,
KaTeX compiles, image type/size/SVG safety, a widget bundles with esbuild and mounts without throwing
in a headless Chromium that also takes its snapshot), **BoardMake** (returns at once; a background pi
sub-agent makes the files and sends them with `make`; the entry shows as being made, then lands or
says why it couldn't), **BoardInbox** (status, and whether added items are still on their board).

The box needs a Chromium for widgets (`server/headless.ts` finds `chromium`, or `VC_HEADLESS_BROWSER`);
without one a widget send is refused with that reason and math has no snapshot. esbuild is the repo's,
or a pinned copy the server installs into its state dir on first use (`VC_ESBUILD_DIR` overrides).

## Voice

The mic in the top-right controls talks to the box's one voice agent, by the phone's path
(`server/voice.ts`: the session, its tools, its transcript): no agent, tool or memory of the board's own
(`src/voice.ts`, the pill: `src/voicePill.ts`). It keeps ONE conversation for as long as Carl is on the
board: the first start continues his most recently active chat (`GET /conversations`, the phone's filter), and
every later start — after a drop, after he ends it and taps the mic again, after a reload (remembered 12 h) —
continues the board's thread, the voice conversation its lines went into; the box builds the session's prompt
from that thread's turns. Only picking another chat in the pill's title changes it. A session that closes by
itself turns the pill red with the reason ("Voice disconnected (…). Tap the mic to go on with this chat."), and
every close is in the board's log (`voice.close`: who closed it — mic, pill, switch or remote — the SDK's
reason and code, the transport, how long it was live). While live, at the start and 1.5 s after each edit, the voice agent gets a contextual update
(the board's name, the inbox parts on it with their labels, the ink) and a picture of the visible region
through the laptop's image path (`src/voiceImages.ts`, keyed by content: an unchanged picture is not sent
again); both wait while the agent speaks (`src/voiceQuiet.ts`). Sends still go through BoardSend/BoardMake
(AskAgent), and a landed entry is mentioned at the next pause. A failed start turns the pill red with one
line. `?voice=fake` swaps the SDK and the session for `src/voiceFake.ts` (`window.__voiceFake` logs what was
sent). Tests: `test/harness/board-voice.test.ts`.

## What only a real iPad can judge

Pen latency (rAF at 120 Hz needs Safari's "Prefer Page Rendering Updates near
60fps" feature flag off), stroke widths, the palm rules' numbers against a real
resting hand (`?debug=touch`), and pinch feel.
