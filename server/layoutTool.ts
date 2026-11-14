// The agent's Layout tool: see and arrange Carl's laptop screen. It rides Show's channel (server/show.ts): a
// {type:"layout", id, to:"laptop", ops} signal on the vault's feed, the laptop applies it through the app's own host
// layout ops (src/layoutOps.ts, the same ones a plugin has as api.host.layout) and acks over POST /api/v1/show/<id>/ack
// with the layout it read back from the screen. The result is only ever that ack, or an honest "offline" / "didn't confirm".
import { randomBytes } from "node:crypto";
import { feedLive, waitAck } from "./show";

const OPS = ["openLeftPanel", "closeLeftPanel", "openRightPanel", "closeRightPanel", "closePane", "openInPane", "split", "focus", "fullscreenChat", "chatSidebar"] as const;
type Op = Record<string, unknown> & { op: string };

export const LAYOUT_DESCRIPTION =
  "See and arrange what is on Carl's laptop screen: the viewer's panes (a split of two files, \"left\" and \"right\"; stacked: left is the top), the left panel (file tree), the chat (the right panel, or full screen). " +
  "action \"get\" returns the real layout now (panes and their files, split, which panel is open, chat open / full screen, window size and the width of each column): use it to see what he sees. " +
  "The other actions: openLeftPanel / closeLeftPanel, openRightPanel / closeRightPanel (the chat panel), closePane {pane: left|right} (a split goes back to one file), openInPane {path, pane: left|right} (turns the split on when one other file is open), split {on: bool} (off keeps the active pane), focus {target: left|right|chat}, fullscreenChat {on: bool}, chatSidebar {open: bool}. " +
  "Several at once: ops: [{action, ...}, ...]. Every call returns the layout read back from the screen after the change (or why one failed, or that the laptop is offline): never tell Carl it changed without that. " +
  "Use it when he asks to close the side tabs, hide the file tree or chat, put X on the left, make the viewer bigger, or when you need to know what is on his screen. Only the laptop has these panes.";

export const LAYOUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["get", ...OPS], description: "get, or one change." },
    pane: { type: "string", enum: ["left", "right"], description: "closePane, openInPane." },
    path: { type: "string", description: "openInPane: the vault-relative file." },
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
    if (action === "focus") {
      if (o.target !== "left" && o.target !== "right" && o.target !== "chat") return 'focus needs target: "left", "right" or "chat".';
      op.target = o.target;
    }
    out.push(op);
  }
  if (!list.length) return "Layout needs action (get, or one of: " + OPS.join(", ") + ") or ops.";
  return out;
}

export async function layoutTool(d: LayoutDeps, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const ops = parseOps(args);
  if (typeof ops === "string") return { ok: false, text: ops };
  if (!feedLive(d.vault, "laptop")) return { ok: false, text: "The laptop isn't online (the vault-chat app isn't open and connected on it), so its layout can't be read or changed. Only the laptop app has panes. Say so; don't guess." };
  const id = `layout-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const ms = d.ackMs ?? 25_000;
  const got = waitAck(id, ms);
  d.emit({ type: "layout", id, to: "laptop", ops });
  const ack = await got;
  if (!ack) return { ok: false, text: `Sent the layout request to the laptop, but it did not confirm within ${Math.round(ms / 1000)} s (an older app without layout control, or it is busy). Don't tell Carl it changed; use Layout {action: "get"} to check.` };
  const data = (ack.data ?? {}) as { results?: { op: string; ok: boolean; note?: string; error?: string }[]; layout?: unknown };
  if (!data.layout) return { ok: false, text: `The laptop answered without a layout${ack.error ? `: ${ack.error}` : ""} (an older app?). Nothing is confirmed.` };
  const lines = (data.results ?? []).map((r) => `- ${r.op}: ${r.ok ? `done${r.note ? ` (${r.note})` : ""}` : `FAILED: ${r.error}`}`);
  const text = [ops.length ? (ack.ok ? "Applied." : "Not everything applied:") : "Layout now:", ...lines, `Summary: ${ack.landed ?? ""}`, "Layout (read back from the screen):", JSON.stringify(data.layout)].join("\n");
  return { ok: ack.ok, text };
}
