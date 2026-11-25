// Seeing and arranging Carl's laptop screen: the transport of the workspace noun (server/model/workspace.ts, box:workspace). It rides Show's channel (server/show.ts): a
// {type:"layout", id, to:"laptop", ops} signal on the vault's feed, the laptop applies it through the app's own host
// layout ops (src/layoutOps.ts, the same ones a plugin has as api.host.layout) and acks over POST /api/v1/show/<id>/ack
// with the layout it read back from the screen. The result is only ever that ack, or an honest "offline" / "didn't confirm".
// openChat {id} switches the chat pane through the chat list's own offer (app/chats `open`, the PluginAct path: a
// {type:"plugin"} signal, so every app that has that offer does it), then reads the layout back.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { waitAck, type Ack } from "./show";
import { loopbackUrl } from "./devProxy";
import { controlDown, laptopElsewhere, noteAnswer, unansweredNote, vaultName } from "./deviceLink";

const OPS = ["openLeftPanel", "closeLeftPanel", "openRightPanel", "closeRightPanel", "closePane", "openInPane", "webPage", "split", "focus", "fullscreenChat", "chatSidebar", "resize", "signOutOfSites", "openChat"] as const;
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
    if (action === "split" || action === "fullscreenChat") {
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
      if (op.leftPanel === undefined && op.chat === undefined) return "resize needs leftPanel and/or chat (pixels).";
    }
    if (action === "openChat") {
      if (typeof o.id !== "string" || !o.id.trim()) return 'openChat needs id: a chat\'s id, "main", or "project-<slug>".';
      op.id = o.id.trim();
    }
    if (action === "focus") {
      if (o.target !== "left" && o.target !== "right" && o.target !== "chat") return 'focus needs target: "left", "right" or "chat".';
      op.target = o.target;
    }
    out.push(op);
  }
  if (!list.length) return "Layout needs action (get, or one of: " + OPS.join(", ") + ") or ops.";
  return out;
}

type Step = { op: string; ok: boolean; note?: string; error?: string };

async function ask(d: LayoutDeps, type: string, fields: Record<string, unknown>, ms: number): Promise<Ack | null> {
  const id = `${type}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const got = waitAck(id, ms);
  d.emit({ type, id, to: "laptop", ...fields });
  const ack = await got;
  noteAnswer("laptop", type, !!ack);
  return ack;
}

/** openChat: the chat list's own `open` (app/chats, as PluginAct runs it). The chat open afterwards, or why not. */
async function openChat(d: LayoutDeps, chat: string, ms: number): Promise<{ step: Step; open?: unknown }> {
  const ack = await ask(d, "plugin", { op: "act", plugin: "app/chats", action: "open", args: { id: chat } }, ms);
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

/** The last layout the laptop read back (any layout ack, by anyone), kept on the box: the workspace noun's state. */
export type KeptLayout = { layout: unknown; at: number; open?: unknown };
let kept: KeptLayout | null = null;
const keptListeners = new Set<() => void>();
export const keptLayout = (): KeptLayout | null => kept;
export function onLayoutKept(fn: () => void): () => void {
  keptListeners.add(fn);
  return () => keptListeners.delete(fn);
}
function keep(layout: unknown, open: unknown): void {
  const was = kept ? JSON.stringify(kept.layout) : "";
  kept = { layout, at: Date.now(), ...(open !== undefined ? { open } : kept?.open !== undefined ? { open: kept.open } : {}) };
  if (JSON.stringify(layout) !== was || open !== undefined) for (const f of [...keptListeners]) f();
}
/** The laptop's own word that its layout changed (POST /api/v2/layout: Carl dragged a sash, toggled a panel, opened a
 *  file): kept as the read-back, and the workspace noun's watchers hear it. */
export function keepLaptopLayout(layout: unknown): void {
  if (layout && typeof layout === "object") keep(layout, undefined);
}
/** Tests: forget it. */
export function resetKeptLayout(): void {
  kept = null;
}

export async function layoutTool(d: LayoutDeps, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; layout?: unknown }> {
  const ops = parseOps(args);
  if (typeof ops === "string") return { ok: false, text: ops };
  const down = controlDown("laptop");
  if (down) return { ok: false, text: `${down} So its layout can't be read or changed. Only the laptop app has panes. Say so; don't guess.` };
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
    ack = await ask(d, "layout", { ops: batch }, ms);
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
    const r = await openChat(d, String(op.id), ms);
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
