// The agent's Layout tool: see and arrange Carl's laptop screen. It rides Show's channel (server/show.ts): a
// {type:"layout", id, to:"laptop", ops} signal on the vault's feed, the laptop applies it through the app's own host
// layout ops (src/layoutOps.ts, the same ones a plugin has as api.host.layout) and acks over POST /api/v1/show/<id>/ack
// with the layout it read back from the screen. The result is only ever that ack, or an honest "offline" / "didn't confirm".
// openChat {id} switches the chat pane through the chat list's own offer (app/chats `open`, the PluginAct path: a
// {type:"plugin"} signal, so every app that has that offer does it), then reads the layout back.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { waitAck, type Ack } from "./show";
import { controlDown, linkVault, noteAnswer, unansweredNote } from "./deviceLink";

const OPS = ["openLeftPanel", "closeLeftPanel", "openRightPanel", "closeRightPanel", "closePane", "openInPane", "split", "focus", "fullscreenChat", "chatSidebar", "openChat"] as const;
type Op = Record<string, unknown> & { op: string };

export const LAYOUT_DESCRIPTION =
  "See and arrange what is on Carl's laptop screen: the viewer's panes (a split of two files, \"left\" and \"right\"; stacked: left is the top), the left panel (file tree), the chat (the right panel, or full screen). " +
  "action \"get\" returns the real layout now (panes and their files, split, which panel is open, chat open / full screen, window size and the width of each column): use it to see what he sees. " +
  "The other actions: openLeftPanel / closeLeftPanel, openRightPanel / closeRightPanel (the chat panel), closePane {pane: left|right} (a split goes back to one file), openInPane {path, pane: left|right} (turns the split on when one other file is open), split {on: bool} (off keeps the active pane), focus {target: left|right|chat}, fullscreenChat {on: bool}, chatSidebar {open: bool}, openChat {id} (switch the chat pane to a chat: its id, \"main\" for Main, or \"project-<slug>\" for a project's thread; the result names the chat open after it). " +
  "Several at once: ops: [{action, ...}, ...]. Every call returns the layout read back from the screen after the change (or why one failed, or that the laptop is offline): never tell Carl it changed without that. " +
  "Use it when he asks to close the side tabs, hide the file tree or chat, put X on the left, make the viewer bigger, or when you need to know what is on his screen. To switch chats use openChat, not clicks in the chat list (clicking a place's bar, Main or a project, only shows or hides its chats). Only the laptop has these panes.";

export const LAYOUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["get", ...OPS], description: "get, or one change." },
    pane: { type: "string", enum: ["left", "right"], description: "closePane, openInPane." },
    path: { type: "string", description: "openInPane: the vault-relative file." },
    id: { type: "string", description: 'openChat: the chat\'s id (ListConversations), "main", or "project-<slug>".' },
    on: { type: "boolean", description: "split, fullscreenChat." },
    open: { type: "boolean", description: "chatSidebar." },
    target: { type: "string", enum: ["left", "right", "chat"], description: "focus." },
    ops: { type: "array", items: { type: "object" }, description: "Several changes in order, each {action, ...its fields}." },
  },
  additionalProperties: false,
} as const;

export type LayoutDeps = {
  vault: string;
  emit: (ev: Record<string, unknown>) => void;
  /** How long the laptop has to ack (default 25 s: a file in a pane may sync first). */
  ackMs?: number;
};

function parseOps(a: Record<string, unknown>): Op[] | string {
  const list = Array.isArray(a.ops) ? (a.ops as unknown[]) : a.action !== undefined ? [a] : [];
  const out: Op[] = [];
  for (const raw of list) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const action = String(o.action ?? o.op ?? "");
    if (action === "get") continue;
    if (!(OPS as readonly string[]).includes(action)) return `Unknown layout action "${action}". Use get or one of: ${OPS.join(", ")}.`;
    const op: Op = { op: action };
    if (action === "closePane" || action === "openInPane") {
      if (o.pane !== "left" && o.pane !== "right") return `${action} needs pane: "left" or "right".`;
      op.pane = o.pane;
    }
    if (action === "openInPane") {
      if (typeof o.path !== "string" || !o.path.trim()) return "openInPane needs a vault-relative path.";
      op.path = o.path.trim();
    }
    if (action === "split" || action === "fullscreenChat") {
      if (typeof o.on !== "boolean") return `${action} needs on: true or false.`;
      op.on = o.on;
    }
    if (action === "chatSidebar") {
      if (typeof o.open !== "boolean") return "chatSidebar needs open: true or false.";
      op.open = o.open;
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

/** The laptop has another vault open than this chat's: a vault-relative path would land in the wrong vault. */
function otherVault(d: LayoutDeps): string | null {
  const v = linkVault("laptop");
  return v && resolve(v).toLowerCase() !== resolve(d.vault).toLowerCase() ? v : null;
}

export async function layoutTool(d: LayoutDeps, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const ops = parseOps(args);
  if (typeof ops === "string") return { ok: false, text: ops };
  const down = controlDown("laptop");
  if (down) return { ok: false, text: `${down} So its layout can't be read or changed. Only the laptop app has panes. Say so; don't guess.` };
  const elsewhere = otherVault(d);
  if (elsewhere && ops.some((o) => o.op === "openInPane")) {
    const name = elsewhere.split(/[\\/]/).filter(Boolean).pop();
    return { ok: false, text: `The laptop app has another vault open (${name}), so a path of this chat's vault can't be opened in its panes. Nothing was changed. Carl can switch vaults in the app's vault picker; don't do it for him unless he asks.` };
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
  if (!last) return { ok: false, text: [...(done.length ? ["Before the read-back:", ...done] : []), `Sent the layout request to the laptop, but it did not confirm within ${Math.round(ms / 1000)} s (an older app without layout control, or it is busy). Don't tell Carl it changed; use Layout {action: "get"} to check.${unansweredNote("laptop")}`].join("\n") };
  const data = (last.data ?? {}) as { layout?: unknown };
  if (!data.layout) return { ok: false, text: `The laptop answered without a layout${last.error ? `: ${last.error}` : ""} (an older app?). Nothing is confirmed.` };
  const text = [
    ops.length ? (allOk ? "Applied." : "Not everything applied:") : "Layout now:",
    ...done,
    `Summary: ${last.landed ?? ""}`,
    ...(open !== undefined ? [`Open chat (read back from the chat list): ${JSON.stringify(open)}`] : []),
    "Layout (read back from the screen):",
    JSON.stringify(data.layout),
  ].join("\n");
  return { ok: allOk && last.ok, text };
}
