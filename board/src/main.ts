// The whiteboard app: #/b/<slug> is a board, anything else the list.
import "katex/dist/katex.min.css";
import "./style.css";
import * as api from "./api";
import { renderList } from "./list";
import { BoardView } from "./view";
import { isField } from "./chrome";
import { installBoardLog } from "./log";

installBoardLog();

const app = document.getElementById("app")!;
let current: BoardView | null = null;

// Safari's own pinch-zoom of the page, outside the canvas too (a text field keeps its own touches).
for (const t of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(t, (e) => !isField(e.target) && e.preventDefault(), { passive: false });

const slugOf = () => /^#\/b\/([a-z0-9-]+)$/.exec(location.hash)?.[1] ?? null;

async function route(): Promise<void> {
  const slug = slugOf();
  if (current) {
    const v = current;
    current = null;
    await v.close();
    v.el.remove();
  }
  if (!slug) {
    document.title = "Whiteboard";
    renderList(app, (s) => (location.hash = `#/b/${s}`));
    return;
  }
  app.innerHTML = `<div class="grid h-full place-items-center bg-sys-grouped text-subhead text-sys-secondary/60">Opening…</div>`;
  try {
    // The board and the undo history saved with it, together.
    const [board, history] = await Promise.all([api.getBoard(slug), api.getHistory(slug).catch(() => null)]);
    if (slugOf() !== slug) return;
    document.title = board.name;
    const v = new BoardView(slug, board, () => (location.hash = ""), history);
    app.innerHTML = "";
    app.appendChild(v.el);
    v.mount();
    current = v;
    (window as unknown as { __board: BoardView }).__board = v;
  } catch (e) {
    app.innerHTML = `<div class="grid h-full place-items-center bg-sys-grouped p-8 text-center"><div><p class="text-subhead text-sys-secondary/70">Couldn't open this board: ${String((e as Error)?.message ?? e)}</p><p class="mt-3"><a class="text-subhead font-semibold text-sys-blue" href="#">All boards</a></p></div></div>`;
  }
}

window.addEventListener("hashchange", () => void route());
void route();
