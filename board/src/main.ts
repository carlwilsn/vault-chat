// The whiteboard app: #/b/<slug> is a board, anything else the list.
import "./style.css";
import * as api from "./api";
import { renderList } from "./list";
import { BoardView } from "./view";

const app = document.getElementById("app")!;
let current: BoardView | null = null;

// Safari's own pinch-zoom of the page, outside the canvas too.
for (const t of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });

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
  app.innerHTML = `<div class="list"><p class="muted">Opening…</p></div>`;
  try {
    const board = await api.getBoard(slug);
    if (slugOf() !== slug) return;
    document.title = board.name;
    const v = new BoardView(slug, board, () => (location.hash = ""));
    app.innerHTML = "";
    app.appendChild(v.el);
    v.mount();
    current = v;
    (window as unknown as { __board: BoardView }).__board = v;
  } catch (e) {
    app.innerHTML = `<div class="list"><p class="muted">Couldn't open this board: ${String((e as Error)?.message ?? e)}</p><p><a href="#">All boards</a></p></div>`;
  }
}

window.addEventListener("hashchange", () => void route());
void route();
