// The whiteboard app: #/b/<slug> is a board, anything else the list.
import "katex/dist/katex.min.css";
import "./style.css";
import * as api from "./api";
import { renderList } from "./list";
import { BoardView } from "./view";
import { isField } from "./chrome";
import { blog, flushBoardLog, installBoardLog } from "./log";
import { ackLocal, getLocal, localKey, putLocal, type LocalRec } from "./local";
import type { Board, BoardHistory } from "../../src/boardFormat";
import { startAttentionBeat } from "../../src/attentionBeat";

installBoardLog();
// On screen = Carl is at the iPad: the box keeps his phone quiet meanwhile (src/attentionBeat.ts).
startAttentionBeat({ device: "board", post: (b) => api.postAttention({ ...b, device: "board" }) });
// For the preview checks (board/preview/*.mjs): send the log now.
(window as unknown as { __flushLog: () => Promise<void> }).__flushLog = () => flushBoardLog();

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
    // The board and the undo history saved with it, together — and what this iPad kept of it that the box never got.
    const key = localKey(api.vaultKey(), slug);
    const [got, history, rec] = await Promise.all([
      api.getBoard(slug).then(
        (b) => ({ b, e: null }),
        (e) => ({ b: null, e }),
      ),
      api.getHistory(slug).catch(() => null),
      within(getLocal(key), 3000).catch(() => null),
    ]);
    if (slugOf() !== slug) return;
    if (!got.b && !rec) throw got.e;
    const opened = rec ? await recover(slug, key, rec, got.b) : { board: got.b!, recovered: null };
    if (slugOf() !== slug) return;
    const board = opened.board;
    document.title = board.name;
    const v = new BoardView(slug, board, () => (location.hash = ""), opened.board === got.b ? (history as BoardHistory | null) : null, opened.recovered);
    app.innerHTML = "";
    app.appendChild(v.el);
    v.mount();
    current = v;
    (window as unknown as { __board: BoardView }).__board = v;
  } catch (e) {
    app.innerHTML = `<div class="grid h-full place-items-center bg-sys-grouped p-8 text-center"><div><p class="text-subhead text-sys-secondary/70">Couldn't open this board: ${String((e as Error)?.message ?? e)}</p><p class="mt-3"><a class="text-subhead font-semibold text-sys-blue" href="#">All boards</a></p></div></div>`;
  }
}

/**
 * Opening a board this iPad holds unsaved work of (local.ts: the app was closed, reloaded or killed, or a save was
 * cut off): the box gets it first. It takes it when nothing else changed the board since (or it was this page's own
 * save whose answer was lost: server/boards.ts), or has it already; when the board really was changed elsewhere,
 * Carl chooses. Unreachable box: the board opens from the iPad's copy and the usual save retries send it.
 */
async function recover(slug: string, key: string, rec: LocalRec, server: Board | null): Promise<{ board: Board; recovered: { writer: string; gen: number } | null }> {
  const local = JSON.parse(rec.json) as Board;
  const info = { slug, strokes: rec.strokes, base: rec.base, rev: server?.rev ?? null, age: Math.round((Date.now() - rec.at) / 1000) };
  // Fresh: saved again from the view once it is up (the agent's pictures of it).
  const fresh = (b: Board) => Object.assign(b, { fresh: true });
  if (server) {
    try {
      const r = await api.saveBoard(slug, rec.json, rec.base, { writer: rec.writer, gen: rec.gen });
      await ackLocal(key, rec.writer, rec.gen);
      if (r.already) {
        blog("local.had", { ...info, now: r.rev });
        return { board: r.rev === server.rev ? server : await api.getBoard(slug), recovered: null };
      }
      blog("local.recovered", { ...info, now: r.rev });
      return { board: fresh({ ...local, rev: r.rev, updated: r.updated }), recovered: null };
    } catch (e) {
      if (!(e instanceof api.HttpError && e.status === 409)) {
        blog("local.offline", { ...info, error: String((e as Error)?.message ?? e).slice(0, 160) });
        return { board: fresh({ ...local, rev: rec.base }), recovered: { writer: rec.writer, gen: rec.gen } };
      }
    }
    // Changed elsewhere since this iPad's copy was made: Carl picks (nothing is lost either way; the box's
    // versions are in the vault's history, this iPad's is kept aside on the device).
    const when = new Date(rec.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const keepMine = confirm(
      `“${local.name}” has changes on this iPad from ${when} that never reached the box (${rec.strokes} strokes), and the board was changed elsewhere since.\n\n` +
        `OK: keep this iPad's version.\nCancel: keep the box's version (this iPad's stays saved aside on it).`,
    );
    blog("local.conflict", { ...info, kept: keepMine ? "ipad" : "box" });
    if (!keepMine) {
      await putLocal({ ...rec, key: `${key}\u0000aside\u0000${rec.at}` });
      await ackLocal(key, rec.writer, rec.gen);
      return { board: server, recovered: null };
    }
    // This iPad's version on top of the box's newest (one more rev; the box's stays in the vault's history).
    try {
      const r = await api.saveBoard(slug, rec.json, server.rev, { writer: rec.writer, gen: rec.gen });
      await ackLocal(key, rec.writer, rec.gen);
      return { board: fresh({ ...local, rev: r.rev, updated: r.updated }), recovered: null };
    } catch {
      return { board: fresh({ ...local, rev: server.rev }), recovered: { writer: rec.writer, gen: rec.gen } };
    }
  }
  blog("local.offline", { ...info, error: "the board did not load" });
  return { board: fresh({ ...local, rev: rec.base }), recovered: { writer: rec.writer, gen: rec.gen } };
}

/** `p`, or a rejection after `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), ms);
    p.then(
      (v) => (clearTimeout(t), res(v)),
      (e) => (clearTimeout(t), rej(e)),
    );
  });
}

window.addEventListener("hashchange", () => void route());
void route();
