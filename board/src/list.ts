// The board list: newest first, each with its first page; "New board" names one.
import * as api from "./api";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function renderList(root: HTMLElement, open: (slug: string) => void): void {
  root.innerHTML = `
    <div class="list">
      <header><h1>Boards</h1><button class="primary" data-act="new">New board</button></header>
      <div class="grid"><p class="muted">Loading…</p></div>
    </div>`;
  const grid = root.querySelector(".grid") as HTMLElement;
  root.querySelector('[data-act="new"]')!.addEventListener("click", () => newBoard(root, open));
  api
    .listBoards()
    .then((boards) => {
      if (!boards.length) {
        grid.innerHTML = `<p class="muted">No boards yet. Start one with New board.</p>`;
        return;
      }
      grid.innerHTML = boards
        .map(
          (b) => `
        <button class="card" data-slug="${esc(b.slug)}">
          <div class="thumb"><img alt="" loading="lazy" src="${esc(api.pageUrl(b.slug, 1, b.updated))}" onerror="this.remove()"></div>
          <div class="meta"><b>${esc(b.name)}</b><span>${b.pages} page${b.pages === 1 ? "" : "s"} · ${ago(b.updated)}</span></div>
        </button>`,
        )
        .join("");
      grid.querySelectorAll<HTMLElement>(".card").forEach((c) => c.addEventListener("click", () => open(c.dataset.slug!)));
    })
    .catch((e) => {
      grid.innerHTML =
        e instanceof api.HttpError && e.status === 401
          ? `<p class="muted"><b>Not signed in to the box.</b> Open this page over Tailscale, or once from the phone link in vault-chat Settings.</p>`
          : `<p class="muted">Couldn't reach the box: ${esc(String(e?.message ?? e))}</p>`;
    });
}

function newBoard(root: HTMLElement, open: (slug: string) => void): void {
  const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const dlg = document.createElement("div");
  dlg.className = "dlg";
  dlg.innerHTML = `
    <form>
      <label>New board</label>
      <input name="name" autocomplete="off" autocapitalize="sentences" value="${esc(`Board · ${today}`)}" maxlength="120">
      <div class="row"><button type="button" data-act="cancel">Cancel</button><button class="primary" type="submit">Create</button></div>
      <p class="err"></p>
    </form>`;
  root.appendChild(dlg);
  const input = dlg.querySelector("input")!;
  input.focus();
  input.select();
  dlg.querySelector('[data-act="cancel"]')!.addEventListener("click", () => dlg.remove());
  dlg.querySelector("form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const btn = dlg.querySelector('button[type="submit"]') as HTMLButtonElement;
    btn.disabled = true;
    api
      .createBoard(input.value.trim())
      .then((r) => {
        dlg.remove();
        open(r.slug);
      })
      .catch((err) => {
        btn.disabled = false;
        (dlg.querySelector(".err") as HTMLElement).textContent = String(err?.message ?? err);
      });
  });
}
