# Whiteboard (board/)

An iPad whiteboard served by the box at `/board`, like the phone app at `/phone`:
same server, same auth (a tailnet login, or the `vc_token` cookie the page
provisions). Add it to the Home Screen for fullscreen (and no Safari
edge-swipe-back).

- `npm run build:board` → `board/dist`; `npm run build:server` embeds it (`--board-app`).
- `npm run dev:board` → :1431, proxying `/api` to a box (`VC_BOX`, default :7420).
- Tests: `test/harness/board-palm.test.ts` (palm rejection against scripted
  traces), `board-chrome.test.ts` (after the pen, every control presses once for a Pencil or a finger tap,
  with or without iOS's click), `board-geom.test.ts` (erasers, lasso),
  `board-ink.test.ts` (how ink follows the hand, on recorded-shape handwriting), `board-scribble.test.ts` (scribble
  to erase on recorded-shape traces), `boardformat.test.ts`;
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
- `history.json`: the undo and redo (the newest 200 steps, at most 3 MB), written by the same save as the
  board and stamped with its rev, so leaving the board, reopening it or reloading keeps them; used only when its
  rev is the board's (a board changed elsewhere since has history that no longer describes it), and a step whose
  strokes or items are gone ends that direction rather than breaking anything. Not committed (`boards/.gitignore`).
  Proof: `board/preview/undo-persist.mjs`.
- `overview.png`: the whole board, fitted to its content, ≤ 1600 px on its long
  side, and `view.png`: the part in view on the iPad (≤ 1280 px; not committed), both written by the save 0.5 s
  after the pen lifts (a pen down in between postpones it). The overview is the list's thumbnail; the agent reads
  either (the "you" layer names both). Voice's LookAtScreen gets one picture with the view and the whole board side
  by side (the view outlined on it). Proof: `board/preview/board-pictures.mjs` (pen-up → both files fresh on the box,
  on a board of 600 strokes).

Rendering (`src/view.ts`): cached 512 px bitmap tiles under a live canvas, both at the device's pixel ratio.
Once the camera settles, tiles are drawn at exactly the screen's scale (zoom × devicePixelRatio) on whole device
pixels, so ink is copied pixel for pixel, as crisp as drawing it directly (mid-pinch the cached tiles scale; a
tile not yet redrawn shows the previous scale's meanwhile). Only tiles in view are drawn; a finished pen stroke is
drawn into the tiles it crosses; an edit repaints or drops only the tiles its bounds meet. Layers: background
(plain, dots, grid) → items → highlighter ink → pen ink.

Canvas memory is bounded, because iPadOS caps it (past the cap `getContext("2d")` returns null) and counts a canvas
until it is collected, which can be long after it is dropped: every settle at a new zoom is a new tile scale, so the
tiles of earlier scales piled up until a tile got no context, `renderBase` threw half way and the board showed
blank where it had not drawn yet, until a pan drew it again (Carl: "things sort of disappear, and I have to pan").
Now a dropped tile's canvas is reused (a small pool) or given back at once (sized to 0); a tile that still gets no
context gives back the older half of the cache and tries again, else it is left for the next frame; `renderBase`
never leaves a half-drawn board (it starts the tiles over); a PDF page's bitmap is at most 12 MP and all of them 40
MP (least recently drawn first out, back to the page's PNG); a pinch-out mid-gesture switches to the screen's scale
before the view needs more tiles than the cache holds (they pushed each other out every frame). The safety net: 600
ms after anything that can change what is on screen (an edit, an undo, an inbox add, a refit, an image or a PDF page
landing, the camera settling) every visible tile is repainted in place; back from the background (`visibilitychange`,
`pageshow`), the canvases are re-made and everything visible redrawn at once. Proof: `board/preview/render-stress.mjs`
(the cap emulated with no garbage collection at all, canvases wiped in the background; random strokes, scribbles,
inbox adds, undo/redo, pinches, pans; nothing in view missing after any of them; before: blank PDF pages and
`null is not an object (evaluating 'ctx.setTransform')` after 15 actions).

Strokes (`src/ink.ts`): a stroke is the Pencil's own coalesced samples (repeats and samples under half a css px
apart left out). Ink is uniform width, so it is drawn as uniform-width ink apps draw it: the samples evenly respaced
along the path (0.6 of the width, at most 1.5 units) and stabilised by **perfect-freehand**'s `getStrokePoints`
(`streamline` 0.5: the hand's tremor and the whole-px samples ironed out over the same distance at every speed);
that centreline is ONE smooth path (quadratic curves through its midpoints) stroked at the stroke's width with round
caps and joins: every point within w/2 of the line, one band of constant width however it turns or crosses itself.
(Until 2026-10-21 perfect-freehand's outline polygon was filled instead; built for pressure ink, at uniform width it
folded over itself at sharp turns and slow stretches: beads, necks and knots along Carl's handwriting.) Dashed and
dotted lines and the highlighter are the same path, with the dash pattern or at the highlighter's alpha. The stroke
being written is the same function of the same samples as the finished one, so nothing moves when the pen lifts; one
predicted sample at most, only one that carries the line on. Measured on recorded-shape handwriting
(`src/inkTraces.ts`, `test/harness/board-ink.test.ts`: tremor, sensor noise, whole-px samples) against the path the
hand meant: 0.27 px RMS off it (before: 0.33), at most 0.95 px (before: 2.1, corners cut), as smooth (wiggle 0.17
rad, before 0.16; the raw samples 0.80), and no jump on lift (before: up to 2.5 px when the bend points were
re-chosen). The pixels are one band (`board/preview/ink-band.mjs`, WebKit at DPR 2, at 0.5–4× home zoom, on the
traces, hairpins and zigzags, and any real board.json given): one connected component, nothing past w/2 (+15%) of
the line, nothing missing within it, its width across within ±15% (the filled outline, on Carl's real board at 4×:
43 of 91 strokes failed (14 at 2×), necks to 0.56 w and bulges 0.25 w past the edge). Proof in WebKit at DPR 2
(`board/preview/ink.mjs`): ink on screen against the same strokes drawn natively, the highlighter under blue ink
with no self-overlap darkening and no gaps (strokes crossing themselves and the ink, across tile seams, at 0.5×,
1×, 2×; on screen every frame for 2 s after the lift), scribble to erase with its preview, normal writing over ink
erasing nothing, and handwriting at 1× and 2× unchanged by the lift.

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
colours each; the button shows its colour). The highlighter is one path at one alpha (35%, multiplied onto the
page: no darkening where it crosses itself), always under the pen's ink, while it is drawn too (the live canvas
multiplies, with the ink it crosses cut out of it). **Scribble to erase** (`src/scribble.ts`, GoodNotes): with the
pen, scribble back and forth over strokes: once it is clearly a scribble the strokes it would erase dim (a preview,
while the Pencil is still down); when it lifts they are erased (never items), the scribble leaves no ink, one undo
step, and they fade out from their dimmed look. Anything less stays ink and the dimmed strokes come back; a
scribble over nothing is ink. A scribble is at least seven sharp reversals (eight legs) with nearly antiparallel
straight legs, fast (legs under ~190 ms), dense (the path ≥ 4.5× its box's diagonal: back and forth over one
place, not along a line); short scribbles, m, w, z, Σ, M, a star, quick zigzags and loops are writing. One eraser button (tap it again for
Stroke / Precise and its size, both remembered): stroke eraser (removes a stroke it touches), precise eraser
(cuts the part under its circle and splits the stroke; the pieces end exactly
on the circle's edge so their round caps stay clean; `src/geom.ts`), each with
its own size and its circle shown while erasing; select (lasso ink and items
together, or tap an item or a stroke; drag to move, corner handles to scale
uniformly: 12 px handles, 44 px hit areas; Delete, and Interact for a widget). Every gesture is one undo step. The board menu (⋯) holds
Insert image, Background, Writing hand and Scribble to erase (on by default).

The floating controls (`view.ts` layoutChrome): undo and redo upper left, with the board's name when a few words
of it fit; the tools in the middle (centred when there is room, else just left of the right-hand group, as on an
iPad held upright); voice, the inbox, the menu and Boards (back to the list) upper right. Proof:
`board/preview/chrome-layout.mjs` (sideways and upright: no overlap, undo/redo from there, the call pill).

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
the validated send: `server/inbox.ts`; format: `src/inboxFormat.ts`). The inbox icon's badge (on a board,
and on the board list) counts the entries new to this iPad — a new entry, or one that got more parts since the
inbox was last open here — live from the box's `/poll` feed (an inbox change arrives as a vault-log signal,
`{type:"signal", signal:{type:"inbox", …}}`; a long poll is cut off after 35 s, coming back from the background
reconnects at once, and every reconnect re-reads the list), and pops when it goes up; opening the inbox sees them
all. Proof: `board/preview/inbox-badge.mjs`.

**Show** (the agent's Show tool, `server/show.ts`): the board follows the feed as `client=board`, so the box knows a
board app is open; `{type:"show", to:"board", target:{label}}` centres the item with that label in the view below the
controls (zoomed out only if it would not fit whole), outlines it in blue for a moment, and acks what happened
(`POST /api/v1/show/<id>/ack`): a label on no item, or the board list being open, is an honest no. Proof:
`board/preview/show-label.mjs`. The sheet lists entries (being made, couldn't
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

The mic in the top-right controls starts the voice of one conversation; during a call it steps aside and the pill
under the controls is the call, one 40 px row: waves, the chat's name (tap: switch), mute and the one end button. One conversation (D3, `server/voice.ts`), as on the phone and the laptop: no agent, tool or memory of the board's own (`src/voice.ts`, the pill:
`src/voicePill.ts`). The box builds the session's prompt from that conversation's pi session and the "you"
layer; every line said goes into it; its one tool that acts, Ask, hands Carl's request to that
conversation's agent, and the agent's answer comes back into the call (`GET /api/v1/voice/updates`). It
attaches to Carl's most recently active chat (`GET /conversations`, the phone's filter), or the one he picked
in the pill's title for as long as he is active nowhere else; since its lines go into that chat, a drop, a
mic restart and a reload all continue it, and a chat he then continues on the laptop is followed. A session that closes by
itself turns the pill red with the reason ("Voice disconnected (…). Tap the mic to go on with this chat."), and
every close is in the board's log (`voice.close`: who closed it — mic, pill, switch or remote — the SDK's
reason and code, the transport, how long it was live). While live, at the start and 1.5 s after each edit, the voice agent gets a contextual update
(the board's name, the inbox parts on it with their labels, the ink) and a picture of the visible region
through the laptop's image path (`src/voiceImages.ts`, keyed by content: an unchanged picture is not sent
again); both wait while the agent speaks (`src/voiceQuiet.ts`). LookAtScreen is answered by the board itself
(a fresh picture of the view). Sends go through the agent's BoardSend/BoardMake (Ask), and a landed entry is
mentioned at the next pause. The conversation's newest images go with the call's start. A failed start turns the pill red with one
line. `?voice=fake` swaps the SDK and the session for `src/voiceFake.ts` (`window.__voiceFake` logs what was
sent). Tests: `test/harness/board-voice.test.ts`.

## What only a real iPad can judge

Pen latency (rAF at 120 Hz needs Safari's "Prefer Page Rendering Updates near
60fps" feature flag off), stroke widths, the palm rules' numbers against a real
resting hand (`?debug=touch`), and pinch feel.
