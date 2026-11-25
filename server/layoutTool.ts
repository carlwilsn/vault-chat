// Seeing and arranging Carl's laptop screen: the transport of the workspace noun (server/model/workspace.ts, box:workspace). It rides Show's channel (server/show.ts): a
// {type:"layout", id, to:"laptop", ops} signal on the vault's feed, the laptop applies it through the app's own host
// layout ops (src/layoutOps.ts, the same ones a plugin has as api.host.layout) and acks over POST /api/v1/show/<id>/ack
// with the layout it read back from the screen. The result is only ever that ack, or an honest "offline" / "didn't confirm".
// openChat {id} switches the chat pane through the chat list's own offer (app/chats `open`, the PluginAct path: a
// {type:"plugin"} signal, so every app that has that offer does it), then reads the layout back.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { waitAck, type Ack } from "./show";
import { loopbackUrl } from "./devProxy";
import { controlDown, laptopElsewhere, noteAnswer, unansweredNote, vaultName } from "./deviceLink";

const OPS = ["openLeftPanel", "closeLeftPanel", "openRightPanel", "closeRightPanel", "closePane", "openInPane", "webPage", "split", "focus", "chatSidebar", "resize", "signOutOfSites", "openChat", "moveTile", "newChat", "autoHideTitleBar", "page", "newWindow", "closeWindow"] as const;
// The viewer's Snap spots (src/tiles.ts SPOTS), and full: the whole viewer. No stacking: a tile covered by a move or
// an open closes.
const SPOTS = ["full", "left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"];
type Op = Record<string, unknown> & { op: string };

export type LayoutDeps = {
  vault: string;
  emit: (ev: Record<string, unknown>) => void;
  /** How long the laptop has to ack (default 25 s: a file in a pane may sync first). */
  ackMs?: number;
  /** Say only what was done (the workspace noun reads the layout back as its state). */
  brief?: boolean;
  /** A dev server on the box (a loopback port a StartJob job listens on) → the origin the laptop reaches it on
   *  (server/devProxy.ts), as Show's. Absent: a loopback url is refused. */
  dev?: (port: number) => Promise<{ origin: string } | { error: string }>;
};

const PAGE_DO = ["back", "forward", "reload", "browser", "read", "click", "type", "scroll", "select"];
const httpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim());

function parseOps(a: Record<string, unknown>): Op[] | string {
  const list = Array.isArray(a.ops) ? (a.ops as unknown[]) : a.action !== undefined ? [a] : [];
  const out: Op[] = [];
  for (const raw of list) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const action = String(o.action ?? o.op ?? "");
    if (action === "get") continue;
    if (!(OPS as readonly string[]).includes(action)) return `Unknown layout action "${action}". Use get or one of: ${OPS.join(", ")}.`;
    const op: Op = { op: action };
    // A tile by its id (layout.tiles), a spot by name, a chat or a page, as the UI does them.
    const tileArgs = typeof o.tile === "string" || typeof o.spot === "string" || typeof o.chat === "string";
    if (o.spot !== undefined && !SPOTS.includes(String(o.spot))) return `spot is one of: ${SPOTS.join(", ")}.`;
    if ((action === "closePane" || action === "openInPane") && tileArgs) {
      for (const k of ["tile", "spot", "chat"]) if (o[k] !== undefined) op[k] = o[k];
      if (typeof o.path === "string" && o.path.trim()) op.path = o.path.trim();
      // A web tile (tile) to an address (url), as its address bar's Enter.
      if (action === "openInPane" && typeof o.tile === "string" && o.url !== undefined) {
        if (!httpUrl(o.url)) return "openInPane's url is an http(s) address.";
        op.url = String(o.url).trim();
      }
      if (action === "closePane" && typeof o.tile !== "string") return "closePane needs tile (an id from layout.tiles) or pane.";
      out.push(op);
      continue;
    }
    if (action === "moveTile") {
      if (typeof o.tile !== "string" || typeof o.spot !== "string") return `moveTile needs tile (an id from layout.tiles) and spot (${SPOTS.join(", ")}).`;
      out.push({ op: action, tile: o.tile, spot: o.spot });
      continue;
    }
    if (action === "autoHideTitleBar") {
      if (typeof o.on !== "boolean") return "autoHideTitleBar needs on: true or false.";
      out.push({ op: action, on: o.on });
      continue;
    }
    if (action === "newWindow") {
      out.push({ op: action });
      continue;
    }
    if (action === "closeWindow") {
      const w = o.window ?? 2;
      if (typeof w !== "number" || !Number.isInteger(w) || w < 2) return "closeWindow's window is a New window's number (2); the main window is the app.";
      out.push({ op: action, window: w });
      continue;
    }
    if (action === "newChat") {
      // A chat tile's New chat (tile), or a new chat in a place ("main" or a project's slug) at a spot.
      out.push({ op: action, ...(typeof o.tile === "string" ? { tile: o.tile } : {}), ...(typeof o.place === "string" ? { place: o.place } : {}), ...(typeof o.spot === "string" ? { spot: o.spot } : {}) });
      continue;
    }
    if (action === "page") {
      if ((o.page !== "settings" && o.page !== "notes") || typeof o.open !== "boolean") return 'page needs page: "settings" or "notes" and open: true or false.';
      out.push({ op: action, page: o.page, open: o.open });
      continue;
    }
    if (action === "openInPane" && typeof o.path === "string" && o.path.trim() && o.pane === undefined && o.url === undefined) {
      // No pane: where new things go (the tiles' placement).
      out.push({ op: action, path: o.path.trim() });
      continue;
    }
    // pane: needed to put a file in a pane; left out of a page (in place of the active pane's), of a closePane with no
    // split (the one file or page) and of webPage (the active pane's page).
    if (action === "closePane" || action === "openInPane" || action === "webPage") {
      if (o.pane !== undefined && o.pane !== "left" && o.pane !== "right") return `${action}: pane is "left" or "right".`;
      if (o.pane !== undefined) op.pane = o.pane;
    }
    if (action === "openInPane") {
      if (o.url !== undefined) {
        if (o.path !== undefined) return "openInPane takes path (a vault file) or url (a web page), not both.";
        if (!httpUrl(o.url)) return "openInPane's url is an http(s) address.";
        op.url = o.url.trim();
      } else {
        if (typeof o.path !== "string" || !o.path.trim()) return "openInPane needs path (vault-relative) or url (a web page).";
        if (op.pane === undefined) return 'openInPane of a file needs pane: "left" or "right".';
        op.path = o.path.trim();
      }
    }
    if (action === "webPage") {
      if (!PAGE_DO.includes(String(o.do))) return `webPage needs do: ${PAGE_DO.join(", ")}.`;
      op.do = o.do;
      if (o.url !== undefined) {
        if (o.do !== "browser" || !httpUrl(o.url)) return "webPage's url (an http(s) address) goes with do: browser.";
        op.url = o.url.trim();
      }
      // Inside the page (src/webDrive.ts checks them again on the laptop): an element by ref or text, what to type.
      if (o.ref !== undefined) {
        if (typeof o.ref !== "string" || !/^e\d{1,6}$/.test(o.ref)) return 'webPage\'s ref is one the page\'s read gave, like "e12".';
        op.ref = o.ref;
      }
      if (o.text !== undefined) {
        if (typeof o.text !== "string" || !o.text.trim()) return "webPage's text is what the element reads.";
        op.text = o.text;
      }
      if (o.value !== undefined) {
        if (typeof o.value !== "string") return "webPage's value is the text to type.";
        op.value = o.value;
      }
      if (o.enter !== undefined) op.enter = o.enter === true;
      if (o.by !== undefined) {
        if (!(o.by === "top" || o.by === "bottom" || (typeof o.by === "number" && Number.isFinite(o.by)))) return 'webPage\'s by is pixels, "top" or "bottom".';
        op.by = o.by;
      }
      if ((o.do === "click" || o.do === "type") && op.ref === undefined && op.text === undefined) return `webPage ${o.do} needs ref (from panes[].page.elements) or text.`;
      if (o.do === "type" && op.value === undefined) return "webPage type needs value.";
    }
    if (action === "split") {
      if (typeof o.on !== "boolean") return `${action} needs on: true or false.`;
      op.on = o.on;
    }
    if (action === "chatSidebar") {
      if (typeof o.open !== "boolean") return "chatSidebar needs open: true or false.";
      op.open = o.open;
    }
    if (action === "resize") {
      for (const k of ["leftPanel", "chat"] as const) if (o[k] !== undefined) {
        if (typeof o[k] !== "number" || !Number.isFinite(o[k])) return `resize: ${k} is a width in pixels.`;
        op[k] = o[k];
      }
      if (o.tiles !== undefined) {
        const t = o.tiles as Record<string, unknown> | null;
        if (!t || typeof t !== "object") return "resize: tiles is { x?, xb?, left?, right? }, fractions between 0 and 1.";
        const tiles: { x?: number; xb?: number; left?: number; right?: number } = {};
        for (const k of ["x", "xb", "left", "right"] as const) if (t[k] !== undefined) {
          const v = t[k]; if (typeof v !== "number" || !(v > 0 && v < 1)) return `resize: tiles.${k} is a fraction between 0 and 1.`;
          tiles[k] = v;
        }
        op.tiles = tiles;
      }
      if (op.leftPanel === undefined && op.chat === undefined && op.tiles === undefined) return "resize needs leftPanel and/or chat (pixels), or tiles (fractions).";
    }
    if (action === "openChat") {
      if (typeof o.id !== "string" || !o.id.trim()) return 'openChat needs id: a chat\'s id, "main", or "project-<slug>".';
      op.id = o.id.trim();
    }
    if (action === "focus") {
      if (typeof o.target !== "string" || !o.target) return 'focus needs target: "left", "right", "chat" or a tile id.';
      op.target = o.target;
    }
    out.push(op);
  }
  if (!list.length) return "Layout needs action (get, or one of: " + OPS.join(", ") + ") or ops.";
  return out;
}

type Step = { op: string; ok: boolean; note?: string; error?: string };

async function ask(d: LayoutDeps, type: string, fields: Record<string, unknown>, ms: number, win = 1): Promise<Ack | null> {
  const id = `${type}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const got = waitAck(id, ms);
  // A New window (2) answers only what names it; the main window what names none (src/boxChat.ts signal).
  d.emit({ type, id, to: "laptop", ...fields, ...(win > 1 ? { window: win } : {}) });
  const ack = await got;
  noteAnswer("laptop", type, !!ack);
  return ack;
}

/** openChat: the chat list's own `open` (app/chats, as PluginAct runs it). The chat open afterwards, or why not. */
async function openChat(d: LayoutDeps, chat: string, ms: number, win = 1): Promise<{ step: Step; open?: unknown }> {
  const ack = await ask(d, "plugin", { op: "act", plugin: "app/chats", action: "open", args: { id: chat } }, ms, win);
  if (!ack) return { step: { op: "openChat", ok: false, error: `the laptop did not answer within ${Math.round(ms / 1000)} s` } };
  const raw = (ack.data as { answer?: unknown } | undefined)?.answer;
  let x: { ok?: boolean; error?: string; result?: { open?: unknown }; state?: { selected?: unknown } } | null = null;
  try {
    x = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    x = null;
  }
  if (!x) return { step: { op: "openChat", ok: false, error: `no answer from the chat list${ack.error ? `: ${ack.error}` : ""} (an older app?)` } };
  if (!x.ok) return { step: { op: "openChat", ok: false, error: x.error ?? "the chat list refused" } };
  const open = x.state?.selected ?? x.result?.open ?? null;
  return { step: { op: "openChat", ok: true, note: `open now: ${JSON.stringify(open)}` }, open };
}

/** The last layout the laptop read back (any layout ack, by anyone), kept on the box: the workspace noun's state. It
 *  outlives a box restart: each vault's last layout is kept in <state>/workspace.json (written a moment after it
 *  changes), and the laptop puts its tiles back from it at start (GET /api/v2/layout). */
export type KeptLayout = { layout: unknown; at: number; open?: unknown };
let kept: KeptLayout | null = null;
/** A New window's (src/newWindow.ts, window 2) last layout, by vault and window number: each window has its own tiles.
 *  Kept while the window is open and across a restart (the laptop opens it again); dropped when it is closed. */
let keptVault: string | null = null;
const keptListeners = new Set<() => void>();
export const keptLayout = (): KeptLayout | null => (loadStored(), kept);
export function onLayoutKept(fn: () => void): () => void {
  keptListeners.add(fn);
  return () => keptListeners.delete(fn);
}
const heard = () => {
  for (const f of [...keptListeners]) f();
};
/** A layout's window (2, 3, …: a New window), or 1: the main window. */
const windowOf = (w: unknown, layout?: unknown): number => {
  const n = typeof w === "number" ? w : (layout as { window?: unknown } | null)?.window;
  return typeof n === "number" && Number.isInteger(n) && n >= 2 ? n : 1;
};
function keep(layout: unknown, open: unknown, vault?: string, migratedFrom?: unknown): void {
  loadStored();
  const win = windowOf(undefined, layout);
  if (win > 1) {
    // A New window's own read-back (its ack, or its own word): kept by window, beside the main window's.
    const v = vault ?? keptVault;
    if (!v) return;
    const was = stored.windows[v]?.[String(win)];
    if (was && JSON.stringify(was.layout) === JSON.stringify(layout)) return;
    stored.windows[v] = { ...(stored.windows[v] ?? {}), [String(win)]: { layout, at: Date.now() } };
    schedule();
    heard();
    return;
  }
  const was = kept ? JSON.stringify(kept.layout) : "";
  kept = { layout, at: Date.now(), ...(open !== undefined ? { open } : kept?.open !== undefined ? { open: kept.open } : {}) };
  if (vault) {
    keptVault = vault;
    store(vault, kept, migratedFrom);
  }
  if (JSON.stringify(layout) !== was || open !== undefined) heard();
}
/** The laptop's own word that its layout changed (POST /api/v2/layout: Carl dragged a sash, toggled a panel, opened a
 *  file), for its open vault: kept as the read-back, and the workspace noun's watchers hear it. migratedFrom: the
 *  laptop just turned an older layout into tiles (the box backs up what it had first). window: a New window's (2),
 *  whose own tiles are kept beside the main window's; closed: that window was closed, its tiles are dropped. */
export function keepLaptopLayout(layout: unknown, vault?: string, migratedFrom?: unknown, window?: unknown, closed?: unknown): void {
  const win = windowOf(window, layout);
  if (closed === true) {
    if (win > 1) dropWindow(vault ?? keptVault, win);
    return;
  }
  if (layout && typeof layout === "object") keep(win > 1 ? { ...(layout as object), window: win } : layout, undefined, vault, migratedFrom);
}
function dropWindow(vault: string | null, win: number): void {
  loadStored();
  if (!vault || !stored.windows[vault]?.[String(win)]) return;
  const { [String(win)]: _gone, ...rest } = stored.windows[vault]!;
  if (Object.keys(rest).length) stored.windows[vault] = rest;
  else delete stored.windows[vault];
  schedule();
  heard();
}
/** A vault's last kept layout (null: none yet), the main window's or a New window's (window ≥ 2): the laptop's start
 *  puts its tiles back from it. */
export function storedLayout(vault: string, window = 1): KeptLayout | null {
  loadStored();
  if (window > 1) return stored.windows[vault]?.[String(window)] ?? null;
  return stored.vaults[vault] ?? null;
}
/** The New windows kept for a vault (their numbers): open, or open when the app last closed. */
export function keptWindowNumbers(vault: string): number[] {
  loadStored();
  return Object.keys(stored.windows[vault] ?? {}).map(Number).filter((n) => n >= 2).sort((a, b) => a - b);
}
/** Every window's last layout for the vault the laptop has open (the main window first): box:workspace's windows. */
export function keptWindows(): { window: number; layout: unknown; at: number; open?: unknown }[] {
  loadStored();
  const v = keptVault ?? Object.entries(stored.vaults).sort((x, y) => y[1].at - x[1].at)[0]?.[0] ?? null;
  const others = v ? keptWindowNumbers(v).map((n) => ({ window: n, ...stored.windows[v]![String(n)]! })) : [];
  return [...(kept ? [{ window: 1, ...kept }] : []), ...others];
}
/** Tests: forget it (in memory; the file stays). */
export function resetKeptLayout(): void {
  kept = null;
  keptVault = null;
  stored = { vaults: {}, windows: {} };
  loaded = false;
}

// ---- kept on disk, per vault (and per New window)
type Stored = { vaults: Record<string, KeptLayout>; windows: Record<string, Record<string, KeptLayout>> };
let stored: Stored = { vaults: {}, windows: {} };
let loaded = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const stateDir = () => process.env.VC_STATE_DIR || join(homedir(), ".local", "state", "vault-chat-server");
const storeFile = () => join(stateDir(), "workspace.json");
const hasTiles = (l: unknown) => Array.isArray((l as { tiles?: unknown } | null)?.tiles);
function loadStored(): void {
  if (loaded) return;
  loaded = true;
  try {
    const j = JSON.parse(readFileSync(storeFile(), "utf8")) as Partial<Stored>;
    if (j && typeof j.vaults === "object" && j.vaults) stored = { vaults: j.vaults, windows: j.windows && typeof j.windows === "object" ? j.windows : {} };
  } catch {
    /* none yet, or unreadable: start empty (a bad file is replaced on the next write) */
  }
  // The newest vault's layout is the read-back until the laptop says more.
  if (!kept) {
    const newest = Object.entries(stored.vaults).sort((x, y) => y[1].at - x[1].at)[0];
    kept = newest?.[1] ?? null;
    keptVault ??= newest?.[0] ?? null;
  }
}
function store(vault: string, k: KeptLayout, migratedFrom: unknown): void {
  const before = stored.vaults[vault];
  // The first tiles for a vault whose layout was the older split (or the laptop says it just migrated one): what the
  // box had is written to a backup first, never lost.
  if ((before && !hasTiles(before.layout) && hasTiles(k.layout)) || migratedFrom !== undefined) {
    try {
      const dir = join(stateDir(), "backups", "workspace");
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(join(dir, `layout-before-tiles-${stamp}.json`), JSON.stringify({ vault, at: new Date().toISOString(), before: before ?? null, migratedFrom: migratedFrom ?? null }, null, 2) + "\n", { mode: 0o600 });
    } catch (e) {
      console.warn("[workspace] the layout backup could not be written:", (e as Error).message);
    }
  }
  stored.vaults[vault] = k;
  schedule();
}
function schedule(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(flushStored, 500);
  (writeTimer as { unref?: () => void }).unref?.();
}
/** Write the kept layouts now (atomically: a temp file renamed over). */
export function flushStored(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${storeFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
    renameSync(tmp, storeFile());
  } catch (e) {
    console.warn("[workspace] the layout could not be kept:", (e as Error).message);
  }
}

export async function layoutTool(d: LayoutDeps, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; layout?: unknown }> {
  const ops = parseOps(args);
  if (typeof ops === "string") return { ok: false, text: ops };
  // Which window (window: 2, a New window; left out: the main window). Opening and closing windows is the main one's.
  const win = args.window === undefined ? 1 : Number(args.window);
  if (!Number.isInteger(win) || win < 1) return { ok: false, text: "window is a window's number: 1 the main window, 2 a New window (see windows)." };
  if (win > 1 && ops.some((o) => o.op === "newWindow" || o.op === "closeWindow")) return { ok: false, text: "newWindow and closeWindow are the main window's: leave window out (closeWindow takes window: 2 as its own argument)." };
  const down = controlDown("laptop");
  if (down) return { ok: false, text: `${down} So its layout can't be read or changed. Only the laptop app has panes. Say so; don't guess.` };
  if (win > 1 && !keptWindows().some((w) => w.window === win)) return { ok: false, text: `There is no window ${win} open on the laptop (windows lists them). newWindow opens one.` };
  // The panes show the vault the laptop has open (the one truth: server/deviceLink.ts laptopElsewhere). A path that is
  // a file there opens there; one only in this chat's vault would open the wrong file, so Show (which switches) does it.
  const elsewhere = laptopElsewhere(d.vault);
  const foreign = elsewhere ? ops.filter((o) => o.op === "openInPane" && typeof o.path === "string" && !existsSync(join(elsewhere, String(o.path)))) : [];
  if (elsewhere && foreign.length) {
    return { ok: false, text: `The laptop app has the vault ${vaultName(elsewhere)} open, and ${foreign.map((o) => o.path).join(", ")} is not a file there (its panes open that vault's files). Nothing was changed. To put this chat's file in a pane, use Show {path, where: "laptop", pane}: it switches the app to this chat's vault (${vaultName(d.vault)}) first.` };
  }
  // A dev server on the box (http://localhost:<port>/…): through the box's proxy, as Show opens it.
  for (const op of ops) {
    const loop = op.op === "openInPane" && typeof op.url === "string" ? loopbackUrl(op.url) : null;
    if (!loop) continue;
    if (!d.dev) return { ok: false, text: "A localhost address is a dev server on the box, and it can't be opened on the laptop here (no proxy in this server). Nothing was changed." };
    const r = await d.dev(loop.port);
    if ("error" in r) return { ok: false, text: `Not opened: ${r.error} Nothing was changed.` };
    op.url = r.origin + loop.path;
  }
  const ms = d.ackMs ?? 25_000;
  // In order: each openChat through the chat list, the layout ops between them in one layout request; the last request
  // (a layout one, maybe with no ops) reads the layout back.
  const results: Step[] = [];
  let open: unknown;
  let batch: Op[] = [];
  let ack: Ack | null = null;
  let allOk = true;
  let lost = false;
  const flush = async (): Promise<boolean> => {
    ack = await ask(d, "layout", { ops: batch }, ms, win);
    batch = [];
    if (!ack) return false;
    const data = (ack.data ?? {}) as { results?: Step[] };
    results.push(...(data.results ?? []));
    if (!ack.ok) allOk = false;
    return true;
  };
  for (const op of ops) {
    if (op.op !== "openChat") {
      batch.push(op);
      continue;
    }
    if (batch.length && !(await flush())) {
      lost = true;
      break;
    }
    const r = await openChat(d, String(op.id), ms, win);
    results.push(r.step);
    if (!r.step.ok) allOk = false;
    else open = r.open;
  }
  if (!lost && (batch.length || !ops.length || ops[ops.length - 1]!.op === "openChat")) await flush();
  const done = results.map((r) => `- ${r.op}: ${r.ok ? `done${r.note ? ` (${r.note})` : ""}` : `FAILED: ${r.error}`}`);
  const last = ack as Ack | null;
  if (!last) return { ok: false, text: [...(done.length ? ["Before the read-back:", ...done] : []), `Sent the layout request to the laptop, but it did not confirm within ${Math.round(ms / 1000)} s (an older app without layout control, or it is busy). Don't tell Carl it changed; read box:workspace again to check.${unansweredNote("laptop")}`].join("\n") };
  const data = (last.data ?? {}) as { layout?: unknown };
  if (!data.layout) return { ok: false, text: `The laptop answered without a layout${last.error ? `: ${last.error}` : ""} (an older app?). Nothing is confirmed.` };
  keep(data.layout, open);
  if (d.brief) return { ok: allOk && last.ok, text: [ops.length ? (allOk ? "Applied." : "Not everything applied:") : "Read the layout from the screen.", ...done, ...(open !== undefined ? [`Open chat (read back from the chat list): ${JSON.stringify(open)}`] : [])].join("\n"), layout: data.layout };
  const text = [
    ops.length ? (allOk ? "Applied." : "Not everything applied:") : "Layout now:",
    ...done,
    `Summary: ${last.landed ?? ""}`,
    ...(open !== undefined ? [`Open chat (read back from the chat list): ${JSON.stringify(open)}`] : []),
    "Layout (read back from the screen):",
    JSON.stringify(data.layout),
  ].join("\n");
  return { ok: allOk && last.ok, text, layout: data.layout };
}
