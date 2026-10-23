// The laptop's half of pi's Show tool (server/show.ts): the box puts a
// {type:"show", to:"laptop", id, path | url, target?} signal on the feed
// (/poll); src/boxChat.ts hands it here; this opens the file the way clicking
// it in the file tree does (setCurrentFile — never a second time when it is
// already on screen, so an open file only scrolls), sends the target to the
// viewer through the same request voice's ScrollTo uses (requestScrollAnchor +
// the viewer's answer, src/scrollTarget.ts), and acks the box with what
// actually happened: the spot it landed on, or the viewer's error.
//
// A file the vault sync has not brought yet, or brought an older copy of (the
// signal's `sha` is the box's copy), opens from the box's copy (GET
// /api/v1/vault/file, the same bytes liveReload shows ahead of the disk while a
// merge is on its way), and the sync is kicked to catch the disk up behind it.
// A sync lag is never an error; only a file neither the box nor the disk can
// give is.
//
// With `pane` ("left" | "right", src/paneLayout.ts's names) it goes into that
// pane of the split screen instead, turning split on when one other file is
// open (the store's drop-at-edge). Whenever the screen is split afterwards, the
// ack says which pane holds what, so the agent can describe and rebuild it.
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { fileKind, isUnreadableAsText } from "./fileKind";
import { holdBoxCopy } from "./liveReload";
import { awaitScroll } from "./scrollTarget";
import { encodeTarget, hasTarget, type ViewTarget } from "./viewTarget";
import { layoutLine, placeInPane, PANE_SIDES, type PaneSide } from "./paneLayout";

/** `sha`: the sha256 (hex) of the box's copy of `path`. */
export type ShowSignal = { type: "show"; id: string; to?: string; path?: string; url?: string; target?: ViewTarget; pane?: string; sha?: string };
/** `pane`: the pane it was put in (only when one was asked for — an older app has none). `layout`: the split afterwards. */
export type ShowAck = { ok: boolean; landed?: string; error?: string; pane?: PaneSide; layout?: string };

export type ShowDeps = {
  /** Bring the box's latest files here now (a file the agent just made may not have synced yet). */
  sync?: () => Promise<void>;
  /** The box's copy of a vault-relative file (null: the box did not give it). */
  boxFile?: (rel: string) => Promise<Uint8Array | null>;
  /** Open a web address outside the app. */
  openUrl?: (url: string) => Promise<void>;
  /** How long the viewer has to say where it landed (a PDF loads first). */
  answerMs?: number;
};

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const nameOf = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** The laptop path for a vault-relative one. */
function localPath(vault: string, rel: string): string {
  return `${vault.replace(/[\\/]+$/, "")}/${rel.replace(/^[\\/]+/, "")}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>("path_exists", { path });
  } catch {
    // An older shell without the command: reading it says.
    try {
      await invoke<string>("read_text_file", { path });
      return true;
    } catch {
      return false;
    }
  }
}

async function shaOf(path: string): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await invoke<number[]>("read_binary_file", { path }));
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** The box's copy, when it can be shown ahead of the disk (text, PDFs, images). */
async function boxCopy(deps: ShowDeps, rel: string, path: string): Promise<Uint8Array | null> {
  const kind = fileKind(path).kind;
  if (!deps.boxFile || kind === "video" || kind === "unsupported") return null;
  try {
    return await deps.boxFile(rel);
  } catch {
    return null;
  }
}

/** Do what the signal asks; never throws (the answer is the ack). */
export async function showOnLaptop(sig: ShowSignal, deps: ShowDeps = {}): Promise<ShowAck> {
  try {
    if (sig.url) {
      const open = deps.openUrl ?? (async (u: string) => (await import("./opener")).openUrl(u));
      await open(sig.url);
      return { ok: true, landed: `opened ${sig.url} in the browser` };
    }
    const vault = useStore.getState().vaultPath;
    if (!sig.path) return { ok: false, error: "nothing to show (no path or url)" };
    if (!vault) return { ok: false, error: "no vault is open in the laptop app" };
    const want = localPath(vault, sig.path);
    const name = nameOf(want);
    const pane = PANE_SIDES.includes(sig.pane as PaneSide) ? (sig.pane as PaneSide) : null;
    if (sig.pane !== undefined && !pane) return { ok: false, error: `pane is "left" or "right", not "${sig.pane}"` };
    const s = useStore.getState();
    // On screen already (the main view or a split pane): it is not opened again, only moved.
    const shown = [s.currentFile, ...s.panes.map((p) => p.file)].find((f): f is string => !!f && norm(f) === norm(want));
    const path = shown ?? want;
    // Not here yet, or an older copy: the box's copy is shown now and the sync catches the disk up behind it.
    let ahead: Uint8Array | null = null;
    if (!shown) {
      const here = await exists(want);
      const stale = here && !!sig.sha && (await shaOf(want)) !== sig.sha;
      if (!here || stale) {
        ahead = await boxCopy(deps, sig.path, want);
        if (ahead) void deps.sync?.().catch(() => {});
        else if (!here) {
          await deps.sync?.().catch(() => {});
          if (!(await exists(want))) return { ok: false, error: `${sig.path} could not be fetched from the box and is not on the laptop; nothing was opened` };
        }
      }
    }
    const copy = ahead;
    const read = async () => (copy ? (holdBoxCopy(path, copy) ?? "") : isUnreadableAsText(path) ? "" : await invoke<string>("read_text_file", { path }));
    let opened = false;
    if (pane) {
      const r = placeInPane(pane, path, shown ? "" : await read());
      // A file already on screen keeps its live content: the swap / focus moved it, nothing was read.
      opened = r.opened;
    } else if (!shown) {
      useStore.getState().setCurrentFile(path, await read());
      opened = true;
    }
    const after = useStore.getState();
    const split = after.panes.length >= 2;
    const layout = split ? layoutLine(after, vault) : "";
    const where = pane ? (split ? ` in the ${pane} pane` : " (alone: a split needs a second file — Show another one with the other pane)") : "";
    const tail = (t: string) => `${t}${layout ? `. ${layout}` : ""}`;
    const extra = { ...(pane ? { pane } : {}), ...(layout ? { layout } : {}) };
    // The viewer must be on screen: the full-screen chat has none.
    const st = useStore.getState();
    if (st.chatFullscreen) st.toggleChatFullscreen();
    const t = sig.target ?? {};
    if (!hasTarget(t)) return { ok: true, landed: tail(opened ? `opened ${name}${where}` : `${name} is open${where} (it already was)`), ...extra };
    const answer = awaitScroll(path, encodeTarget(t), deps.answerMs ?? 9000);
    useStore.getState().requestScrollAnchor(path, encodeTarget(t));
    const outcome = await answer;
    if (outcome === null) return { ok: false, ...extra, error: `${name} is open, but its viewer did not say where it landed within ${Math.round((deps.answerMs ?? 9000) / 1000)} s (still loading?)` };
    if (/^Error/.test(outcome) || /^Superseded/.test(outcome)) return { ok: false, ...extra, error: `${name} is open, but: ${outcome.replace(/^Error:\s*/, "").replace("Call ScrollTo again", "Call Show again")}` };
    return { ok: true, landed: tail(`${opened ? `opened ${name}${where}; ` : pane && split ? `${name} is in the ${pane} pane; ` : ""}${outcome.charAt(0).toLowerCase()}${outcome.slice(1)}`), ...extra };
  } catch (e) {
    return { ok: false, error: `the laptop could not open it: ${(e as Error)?.message ?? String(e)}` };
  }
}
