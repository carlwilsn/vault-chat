# The board inbox: what the agent can send

The agent never draws on a board. It sends things to the iPad's **inbox** (top-right
icon, badge = unread). Carl opens an item to read it, then **Add to board**: the whole
thing or one part, landing at the centre of his view, moved and resized with the
select tool. The agent sees the board (ink + items) through snapshots.

## The envelope

One send = one inbox entry, stored in the vault at `boards/.inbox/<id>/entry.json`
(files it needs sit beside it).

```json
{
  "id": "2026-10-16-cauchy-set",
  "title": "Cauchy sequences: problem set",
  "note": "Five problems, easiest first.",
  "from": { "conversation": "<conv id>" },
  "createdAt": 1792200000000,
  "parts": [ { "kind": "...", "...": "..." } ],
  "status": "unread" | "read" | "added"
}
```

`parts` is ordered. Each part is addable on its own: one PDF page, one problem,
one graph. `title` and `note` are plain one-liners shown in the inbox list.

## The four kinds

Every part has `kind`, an optional `label` (shown in the inbox, e.g. "Problem 3"),
and an optional `width`: the width it lands at, in canvas units, where the
default view is 1000 wide. Without one, a part lands 60% of the view wide.

### 1. `pdf`: pages of a PDF in the vault

```json
{ "kind": "pdf", "path": "IEMS 469/lec7.pdf", "pages": [3, 4, 5] }
```

- **The agent sends:** a vault path and page numbers (1-based). Page ranges are listed out. At most 20 pages per part.
- **The inbox shows:** the pages, scrollable, as in the PDF viewer.
- **On the board:** each page is its own item (an image item backed by the PDF). It re-renders crisply when zoomed in, so text stays sharp.
- **Fails when:** the path is missing, or a page is out of range. The send is refused with the reason, so the agent can fix it before Carl ever sees it.

### 2. `math`: typeset text and LaTeX

```json
{ "kind": "math", "label": "Problem 3", "markdown": "Let $x_n=\\sum_{k=1}^n \\frac{(-1)^k}{k}$. Show $(x_n)$ is Cauchy.\n\n$$|x_m-x_n|<\\frac1{n+1}$$" }
```

- **The agent sends:** markdown with `$…$` and `$$…$$`, which is the same markdown pipeline as everywhere else in vault-chat (lists, bold and tables work).
- **It's rendered:** to vector (KaTeX → SVG) in a clean printed style, black on transparent, at a fixed reading size.
- **On the board:** one item per part, sharp at any zoom.
- **A problem set** is several `math` parts, one per problem, so each problem can be added and placed on its own with room to work around it.
- **Fails when:** the TeX has an error (the send is refused, with KaTeX's message), or TeX is written outside `$…$` (`\max`, `x_{n}` in plain text would show raw).

### 3. `image`: a picture or a graph

```json
{ "kind": "image", "path": "boards/.inbox/<id>/phase-plot.svg", "alt": "Phase plot of x' = x(1-x)" }
```

- **The agent sends:** a PNG, JPG, WebP or SVG file in the vault. Usually it makes the file itself, by running code on the box (e.g. matplotlib saving SVG), and puts it beside the entry.
- **Graphs are images.** There's no separate chart format to learn: whatever plotting the agent is good at, the output is an SVG or PNG.
- **`alt` is required:** one line saying what it shows. It's what the agent remembers it sent.
- **On the board:** an image item. SVG stays sharp at any zoom.
- **Limits:** 20 MB, and 4096 px on the long side for bitmaps.

### 4. `widget`: something live, written in TypeScript

```json
{ "kind": "widget", "path": "boards/.inbox/<id>/value-iteration.ts", "alt": "Value iteration on a 4x4 grid; slider for gamma" }
```

- **The agent sends:** one TypeScript module (raw TS, no framework required), exporting `mount(el: HTMLElement, api)`. It draws into `el` with DOM, canvas or SVG.
  - `api` gives it `size()`, `onResize(fn)` and `theme`. That's all.
  - It can't use the network, storage, or the parent page.
- **It's built and run:** the box bundles it (esbuild), and it runs in a sandboxed iframe (`sandbox="allow-scripts"`, CSP `default-src 'none'`).
- **On the board:** a live item that is interactive when tapped into ("Interact"). Otherwise the pen writes over it like any item, so ink and widget never fight over touches.
- **What the agent sees:** a PNG snapshot taken when the widget renders and when Carl leaves interact mode, plus `alt`.
- **Fails when:** it doesn't build, or throws on mount. The send is refused with the error, so a broken widget never reaches the inbox. Also when its strings carry TeX (`"$\gamma$"`): a widget has no typesetter, so it writes Unicode (γ, ‖V‖∞, Vₖ₊₁) or the formula goes in a `math` part beside it.
- This is the test bed for the original "show me" idea: if widgets on the board turn out good and fast enough, the same kind can later open as its own window on the laptop.

## What the agent gets back

- **The send tool** returns `{ id, parts: n }`, or a refusal with the reason (above), so a bad send never reaches the inbox.
- **Status:** the agent can read an entry's status (`unread` / `read` / `added`) and, for added parts, whether they're still on the board.
- **The board** it reads as an overview snapshot plus a crop of where Carl is writing. Added items carry their inbox id and label, so the agent can say "under Problem 3" and mean the right thing.

## Not in this design (on purpose)

- The agent placing things directly on the board.
- Handwriting-style agent ink.
- Video.
- Live HTML pages.
- Remote URLs. Everything sent is a file in the vault, so it syncs, versions, and works offline on the iPad.

## On the board, every kind behaves the same (Carl, 2026-10-16)

- **An object:** every added part is an object on the canvas. Carl drags it, scales it, and writes on top of it with the pen (ink always lies above objects).
- **Scaling:** always uniform. Nothing ever stretches, and there is no free-form resize.
- **Widgets:** a widget scales as a whole too. It is laid out once at its send size, then zoomed like an image. Reshaping a widget, so its layout reflows, is a possible later option; it is not built.

## Sending never blocks the conversation (Carl, 2026-10-16)

Carl keeps talking while things are made. The rule:

- **Ready → send directly.** When everything already exists, the agent sends it itself, in about a second. That covers a PDF and its pages, math it has already written, or an image file that exists. Validation is the only wait.
- **Needs making → delegate.** When something must be made first (a problem set, a graph, a widget), the agent hands it to a background sub-agent with one call (`BoardMake {request, title}`). The call returns at once ("making it, it'll land in your inbox"), and the conversation continues.
  - The sub-agent works in the same vault with the same context summary. It makes the files, sends them through the same validated send, and fixes refusals itself.
  - When it finishes, the inbox badge appears, and voice says it in a short line at the next natural pause.
- **Voice** follows the same rule, and never waits on a make.
- **Several makes** can run at once. Each appears in the inbox as "being made" with its title, so nothing is invisible.
- **A make that fails** after its own retries shows in the inbox as "couldn't make: <reason>". It never fails silently.
