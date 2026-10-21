// The laptop's half of pi's Show tool (server/show.ts): the box puts a
// {type:"show", to:"laptop", id, path | url, target?} signal on the feed
// (/poll); src/boxChat.ts hands it here; this opens the file the way clicking
// it in the file tree does (setCurrentFile — never a second time when it is
// already on screen, so an open file only scrolls), sends the target to the
// viewer through the same request voice's ScrollTo uses (requestScrollAnchor +
// the viewer's answer, src/scrollTarget.ts), and acks the box with what
// actually happened: the spot it landed on, or the viewer's error.
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { isUnreadableAsText } from "./fileKind";
import { awaitScroll } from "./scrollTarget";
import { encodeTarget, hasTarget, type ViewTarget } from "./viewTarget";

export type ShowSignal = { type: "show"; id: string; to?: string; path?: string; url?: string; target?: ViewTarget };
export type ShowAck = { ok: boolean; landed?: string; error?: string };

export type ShowDeps = {
  /** Bring the box's latest files here now (a file the agent just made may not have synced yet). */
  sync?: () => Promise<void>;
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
    const s = useStore.getState();
    // On screen already (the main view or a split pane): it is not opened again, only moved.
    const shown = [s.currentFile, ...s.panes.map((p) => p.file)].find((f): f is string => !!f && norm(f) === norm(want));
    let path = shown ?? want;
    if (!shown) {
      if (!(await exists(want))) {
        await deps.sync?.().catch(() => {});
        if (!(await exists(want))) return { ok: false, error: `${sig.path} is not on the laptop yet (the vault sync has not brought it); nothing was opened` };
      }
      path = want;
      const content = isUnreadableAsText(path) ? "" : await invoke<string>("read_text_file", { path });
      useStore.getState().setCurrentFile(path, content);
    }
    // The viewer must be on screen: the full-screen chat has none.
    const st = useStore.getState();
    if (st.chatFullscreen) st.toggleChatFullscreen();
    const t = sig.target ?? {};
    if (!hasTarget(t)) return { ok: true, landed: shown ? `${name} is open (it already was)` : `opened ${name}` };
    const answer = awaitScroll(path, encodeTarget(t), deps.answerMs ?? 9000);
    useStore.getState().requestScrollAnchor(path, encodeTarget(t));
    const outcome = await answer;
    if (outcome === null) return { ok: false, error: `${name} is open, but its viewer did not say where it landed within ${Math.round((deps.answerMs ?? 9000) / 1000)} s (still loading?)` };
    if (/^Error/.test(outcome) || /^Superseded/.test(outcome)) return { ok: false, error: `${name} is open, but: ${outcome.replace(/^Error:\s*/, "").replace("Call ScrollTo again", "Call Show again")}` };
    return { ok: true, landed: `${shown ? "" : `opened ${name}; `}${outcome.charAt(0).toLowerCase()}${outcome.slice(1)}` };
  } catch (e) {
    return { ok: false, error: `the laptop could not open it: ${(e as Error)?.message ?? String(e)}` };
  }
}
