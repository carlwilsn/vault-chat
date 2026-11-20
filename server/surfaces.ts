// The phone app is a surface Carl (or the agent's Plugins tool) can switch off and on live, like any
// plugin (src/appPlugins.ts SURFACE_PLUGINS; the record is the supervisor's plugin.desired, server/supervisor.ts). This
// is the box's half: what a surface that is off no longer gets, and the line said where it would have appeared.
//   phone  no push (server/pushGate.ts); /phone serves the off line, an open phone goes to it.
// Turned on again, everything comes back on the next look (the off page looks again every 30 s).
import { PHONE_SURFACE_ID } from "../src/appPlugins";
import { pluginDesired } from "./supervisor";

export type Surface = "phone";

const ID: Record<Surface, string> = { phone: PHONE_SURFACE_ID };
const NAME: Record<Surface, string> = { phone: "The phone app" };
const WORD: Record<Surface, string> = { phone: "phone" };

/** The surface's supervisor id (app/phone). */
export function surfaceId(s: Surface): string {
  return ID[s];
}

/** Null: the surface is on. A line: it is off, why, and how to turn it on (nothing reaches it meanwhile). */
export function surfaceOff(vault: string, s: Surface, now = Date.now()): string | null {
  let d;
  try {
    d = pluginDesired(vault, ID[s], now);
  } catch {
    return null; // no log to read: the default, on
  }
  if (d.state !== "stopped") return null;
  const by = d.by ? ` by ${d.by === "carl" ? "Carl" : d.by}` : "";
  return `${NAME[s]} is turned off${by}${d.reason ? ` (${d.reason})` : ""}, so nothing was sent to it. Turn it on with Plugins {action: "enable", plugin: "${WORD[s]}"}.`;
}

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What /phone serves while the surface is off: the one line, looked at again every 30 s. */
export function surfaceOffPage(s: Surface, line: string): string {
  const shown = line.replace(/, so nothing was sent to it\..*$/, ".");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>vault-chat</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.45 system-ui,sans-serif;color:#9a9a9a;background:#111}div{padding:24px;text-align:center}</style></head><body><div data-el="surface-off" data-vc-plugin="${esc(ID[s])}">${esc(shown)}</div></body></html>`;
}
