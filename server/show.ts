// pi's Show tool: put a file (or a web address) in front of Carl, on the
// device he names — or the one he is on now — and report what actually
// happened there.
//
//   laptop  a {type:"show", to:"laptop", id, path | url, target?, pane?} signal on the
//           vault's feed (/poll); the laptop app opens it as a click in the file
//           tree does, scrolled to the target (src/showOnLaptop.ts), and acks
//           (POST /api/v1/show/<id>/ack). Success is only ever that ack. The signal
//           carries the file's sha256: a laptop whose copy is missing or different
//           (the vault sync not there yet) shows the box's copy, fetched over the
//           same link (GET /api/v1/vault/file), and the sync catches up behind it. A laptop
//           with no live feed gets nothing sent and an honest "not online".
//           `pane` ("left" | "right") puts it in that pane of the split screen,
//           turning split on (src/paneLayout.ts); the ack then names which pane
//           holds what.
//   phone   the same signal to the phone app (its sheet shows markdown and
//           images, and opens PDFs and pages in the phone's own viewer); acked.
//   here    the device of the originating human interaction.
//
// Targets are src/viewTarget.ts's, per file type (the laptop's viewers land
// them; a target that does not fit the type is refused here, before anything
// is sent). Presence: a client's /poll carries `client=laptop|phone`;
// a poll in flight, or one that ended a moment ago, is a live client.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileKind } from "../src/fileKind";
import { hasTarget, spotLabel, targetError, targetOf, type ViewTarget } from "../src/viewTarget";
import { loopbackUrl } from "./devProxy";
import { vaultFor, type NamedVault } from "./vaultRefs";
import { controlLive, laptopElsewhere, linkOpened, resetLinks, vaultName } from "./deviceLink";

export type Device = "laptop" | "phone";
const DEVICES: Device[] = ["laptop", "phone"];
const DEVICE_NAME: Record<Device, string> = { laptop: "laptop", phone: "phone" };

// ---------------------------------------------------------------- presence (who is on the feed)

/** A client whose last poll ended this long ago still counts as live (the next poll starts at once). */
const LIVE_GRACE_MS = 8_000;
const presence = new Map<string, { open: number; last: number }>();
const pkey = (vault: string, client: string) => `${resolve(vault).toLowerCase()}|${client}`;

/** A /poll from `client` started: call the returned function when it ends. */
export function feedOpened(vault: string, client: string | null | undefined): () => void {
  const c = DEVICES.includes(client as Device) ? (client as Device) : null;
  if (!c) return () => {};
  // The device's control link, across vaults (server/deviceLink.ts).
  const leaveLink = linkOpened(vault, c);
  const k = pkey(vault, c);
  const p = presence.get(k) ?? { open: 0, last: 0 };
  p.open++;
  p.last = Date.now();
  presence.set(k, p);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    p.open = Math.max(0, p.open - 1);
    p.last = Date.now();
    leaveLink();
  };
}

/** Is `client`'s app following this vault's feed right now? */
export function feedLive(vault: string, client: Device, now = Date.now()): boolean {
  const p = presence.get(pkey(vault, client));
  return !!p && (p.open > 0 || now - p.last < LIVE_GRACE_MS);
}

/** Tests: forget every client. */
export function resetPresence(): void {
  presence.clear();
  resetLinks();
}

// ---------------------------------------------------------------- acks

export type Ack = { ok: boolean; landed?: string; error?: string; pane?: string; vault?: string; data?: unknown; image?: { data: string; mimeType?: string }; images?: { data: string; mimeType?: string; name?: string }[] };
const waits = new Map<string, (a: Ack) => void>();

/** POST /api/v1/show/<id>/ack: a client says what happened. False: no one is waiting for it (late, or unknown). */
export function ackShow(id: string, body: unknown): boolean {
  const w = waits.get(id);
  if (!w) return false;
  waits.delete(id);
  const b = (body ?? {}) as Record<string, unknown>;
  w({ ok: b.ok === true, ...(typeof b.pane === "string" ? { pane: b.pane.slice(0, 10) } : {}), ...(typeof b.vault === "string" ? { vault: b.vault.slice(0, 200) } : {}), ...(typeof b.landed === "string" ? { landed: b.landed.slice(0, 600) } : {}), ...(b.data && typeof b.data === "object" && JSON.stringify(b.data).length < 120_000 ? { data: b.data } : {}), ...(typeof b.error === "string" ? { error: b.error.slice(0, 1200) } : {}), ...ackImage(b.image), ...ackImages(b.images) });
  return true;
}

/** A picture in an ack (the Screen tool's capture, server/screenTool.ts checks it): kept only when it is a string within ~6 MB. */
function ackImage(raw: unknown): { image?: { data: string; mimeType?: string } } {
  const im = (raw ?? {}) as Record<string, unknown>;
  if (typeof im.data !== "string" || !im.data || im.data.length > 8_000_000) return {};
  return { image: { data: im.data, ...(typeof im.mimeType === "string" ? { mimeType: im.mimeType.slice(0, 40) } : {}) } };
}

/** Several pictures in an ack (the Drive tool's shots, server/driveTool.ts checks each): at most 6, ~16 MB in all. */
function ackImages(raw: unknown): { images?: { data: string; mimeType?: string; name?: string }[] } {
  if (!Array.isArray(raw)) return {};
  const out: { data: string; mimeType?: string; name?: string }[] = [];
  let total = 0;
  for (const r of raw.slice(0, 6)) {
    const im = ackImage(r).image;
    if (!im || (total += im.data.length) > 16_000_000) break;
    const name = (r as Record<string, unknown>).name;
    out.push({ ...im, ...(typeof name === "string" ? { name: name.slice(0, 60) } : {}) });
  }
  return out.length ? { images: out } : {};
}

export function waitAck(id: string, ms: number): Promise<Ack | null> {
  return new Promise((res) => {
    const t = setTimeout(() => {
      waits.delete(id);
      res(null);
    }, ms);
    waits.set(id, (a) => {
      clearTimeout(t);
      res(a);
    });
  });
}

// ---------------------------------------------------------------- the tool

export type ShowDeps = {
  vault: string;
  /** Actual talking surface from this request, never inferred from network presence. */
  device?: Device | null;
  /** The phone app is switched off (server/surfaces.ts surfaceOff): its line, else null. */
  off?: (surface: "phone") => string | null;
  /** A vault-level signal on the feed (/poll). */
  emit: (ev: Record<string, unknown>) => void;
  /** How long a client has to ack (default: laptop 20 s — a sync and a PDF load can come first — others 10 s). */
  ackMs?: Partial<Record<Device, number>>;
  /** A dev server on the box (a loopback port a StartJob job of this vault listens on) → the origin Carl's devices
   *  reach it on (server/devProxy.ts), or why not. Absent: loopback addresses are refused. */
  dev?: (port: number) => Promise<{ origin: string } | { error: string }>;
  /** The registered vaults (name, box path): a `vault` argument or an absolute path names one. Absent: only `vault`. */
  vaults?: () => NamedVault[];
};

export type ShowResult = { ok: boolean; text: string; where?: Device };

const SHOW_KEYS = ["path", "vault", "url", "port", "where", "pane", "page", "line", "endLine", "heading", "text", "anchor", "cell"];

export const SHOW_DESCRIPTION =
  "Put something in front of Carl: open a vault file (or a web address) on one of his screens, at a place in it. " +
  'where: "laptop" (the laptop app\'s viewer/editor, scrolled to the place; an open file only scrolls — use this to scroll his laptop too), ' +
  '"phone" (the phone app: markdown and images shown, PDFs and pages opened in the phone\'s viewer), ' +
  'or "here"/omitted (the device he is on now, from the "you" layer) — the default: things appear where he is talking. ' +
  'The laptop has a split screen: two files side by side, a left pane and a right pane (the turn prefix and the "you" layer say which file is in which, and whether split is on). ' +
  'A file in another of Carl\'s registered vaults: path (vault-relative) plus vault (its name), or an absolute path inside it; the laptop opens that vault as its workspace first (laptop only). Left out: the vault of this conversation. ' +
  'pane: "left" or "right" (laptop only) puts the file in that pane, turning split on when another file is open; without pane it replaces the file in the active pane. ' +
  'To set up or rebuild a layout (two files side by side), call Show twice: one file with pane "left", the other with pane "right". The result says which pane holds what. Pick where from what he says ("I\'m not near my laptop"); only show what he asked to see, or work you made for him. ' +
  "The place, by file type (one of them): PDF: page (1-based, as PdfRead/PdfPages count) or text (the first page with that phrase). " +
  "Markdown: line (a source line, as read numbers them), heading (its text or slug) or text. Code/plain text: line, or line + endLine (the range is highlighted). " +
  "HTML: anchor (an element id), heading or text. Notebook (.ipynb): cell (1-based) or text. Image: none. " +
  'A dev server you started with StartJob (vite, a web app): url "http://localhost:5173" (or port: 5173) opens it live on his laptop or phone through the box (only ports a StartJob job listens on; hot reload works). ' +
  "The result is the confirmed outcome (the place it landed, or why not, with the valid range or nearest headings) — never assume it opened.";

export const SHOW_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "A file in the vault (vault-relative), or an absolute path inside any registered vault." },
    vault: { type: "string", description: "Laptop only: the registered vault the path is in, by name (e.g. \"vault-chat\"); the laptop switches its workspace to it. Left out: this conversation's vault (or the vault an absolute path is inside)." },
    url: { type: "string", description: "A web address (laptop: the browser; phone: a link). http://localhost:<port>/… is a dev server you started with StartJob, opened through the box." },
    port: { type: "number", description: "A dev server's port on the box (one a StartJob job listens on): the same as url http://localhost:<port>/." },
    where: { type: "string", enum: ["laptop", "phone", "here"] },
    pane: { type: "string", enum: ["left", "right"], description: 'Laptop only: the split-screen pane to open it in (split turns on). Omitted: the active pane, as before.' },
    page: { type: "number" },
    line: { type: "number" },
    endLine: { type: "number" },
    heading: { type: "string" },
    text: { type: "string" },
    anchor: { type: "string" },
    cell: { type: "number" },
  },
  additionalProperties: false,
} as const;

const fail = (text: string, where?: Device): ShowResult => ({ ok: false, text, ...(where ? { where } : {}) });

/** Show {path | url, where?, place…}. Never throws. */
export async function show(d: ShowDeps, args: Record<string, unknown>): Promise<ShowResult> {
  try {
    return await run(d, args ?? {});
  } catch (e) {
    return fail(`Show failed: ${(e as Error)?.message ?? String(e)}`);
  }
}

async function run(d: ShowDeps, a: Record<string, unknown>): Promise<ShowResult> {
  const unknownKeys = Object.keys(a).filter((k) => !SHOW_KEYS.includes(k));
  if (unknownKeys.length) return fail(`Error: Show does not take ${unknownKeys.join(", ")}.`);
  const target = targetOf(a);
  const rawPath = typeof a.path === "string" ? a.path.trim() : "";
  const url = typeof a.url === "string" ? a.url.trim() : "";
  if (rawPath && url) return fail("Error: give path or url, not both.");
  if (a.port !== undefined && (rawPath || url)) return fail("Error: port alone opens a dev server; with a url, put the port in it.");

  // Where: named, or the device he is on.
  const asked = typeof a.where === "string" ? a.where.trim().toLowerCase() : "here";
  let where: Device;
  let because = "";
  if (asked === "here" || asked === "") {
    if (!d.device) return fail('Error: I can\'t tell which device Carl is on (nothing recent says). Pass where: "laptop" or "phone".');
    where = d.device;
    because = ` (he is on his ${DEVICE_NAME[where]})`;
  } else if (DEVICES.includes(asked as Device)) where = asked as Device;
  else return fail(`Error: where is "laptop", "phone" or "here", not "${asked}".`);
  const off = where !== "laptop" ? d.off?.(where) : null;
  if (off) return fail(`Not shown on the ${DEVICE_NAME[where]}: ${off}`, where);

  // A pane of the laptop's split screen.
  let pane: "left" | "right" | undefined;
  if (a.pane !== undefined) {
    const p = typeof a.pane === "string" ? a.pane.trim().toLowerCase() : "";
    if (p !== "left" && p !== "right") return fail(`Error: pane is "left" or "right" (the laptop's split screen), not ${JSON.stringify(a.pane)}.`);
    if (where !== "laptop") return fail(`Error: pane is for the laptop's split screen; the ${DEVICE_NAME[where]}${because} has no panes. Leave pane out, or pass where: "laptop".`);
    if (url) return fail("Error: a web address opens in the browser, not in a pane; pane is for a vault file.");
    pane = p;
  }

  // A dev server on the box: through the box's proxy, on its own tailnet origin (server/devProxy.ts).
  const loop = url ? loopbackUrl(url) : a.port !== undefined ? { port: Number(a.port), path: "/" } : null;
  if (loop) {
    if (hasTarget(target)) return fail("Error: a web address takes no place in it (page, line, heading…); open it, then say where to look.");
    if (!d.dev) return fail("Error: dev servers on the box can't be opened on Carl's devices here (no proxy in this server).");
    const r = await d.dev(loop.port);
    if ("error" in r) return fail(`Not shown: ${r.error}`, where);
    const shown = r.origin + loop.path;
    const local = url || `http://localhost:${loop.port}/`;
    return toClient(d, where, { url: shown, local }, `${local} (as ${shown}, through the box)`, because);
  }

  if (!rawPath && !url) return fail("Error: Show needs a path (a vault file) or a url.");
  if (url) {
    if (!/^https?:\/\//i.test(url)) return fail("Error: url must start with http:// or https://.");
    if (hasTarget(target)) return fail("Error: a web address takes no place in it (page, line, heading…); open it, then say where to look.");
    return toClient(d, where, { url }, url, because);
  }

  // A vault file: in this conversation's vault, or (vault, or an absolute path) another registered one.
  const vf = vaultFor(d.vault, d.vaults?.(), a.vault, rawPath);
  if ("error" in vf) return fail(`Error: ${vf.error}. Nothing was shown.`);
  if (vf.name && where !== "laptop") return fail(`Error: a file of another vault (${vf.name}) opens on the laptop only (it switches its workspace there); the ${DEVICE_NAME[where]}${because} shows this conversation's vault. Pass where: "laptop".`);
  const f = await vaultFile(vf.vault, vf.path);
  if (typeof f === "string") return fail(`Error: ${f}${vf.name ? ` (vault ${vf.name})` : ""}`);
  const kind = fileKind(f.rel).kind;
  const name = basename(f.rel);
  const t: ViewTarget = { ...target };
  const bad = targetError(kind, t, name);
  if (bad) return fail(bad);
  // The laptop opens the box's copy whenever its own is missing or not this one (`sha`): a sync lag is never a failure.
  const sha = where === "laptop" ? createHash("sha256").update(readFileSync(f.abs)).digest("hex") : undefined;
  // The laptop has another vault open than the file's: name the file's vault, so the app opens it as its workspace
  // first (as Show {vault} does) instead of a same-named path in the wrong vault, or an "offline" that isn't true.
  let vname = vf.name;
  const open = where === "laptop" && !vname ? laptopElsewhere(vf.vault) : null;
  if (open) {
    vname = d.vaults?.().find((v) => resolve(v.path) === resolve(vf.vault))?.name ?? null;
    if (!vname) return fail(`The laptop has the vault ${vaultName(open)} open, and this file's vault (${vf.vault}) is not a registered vault it can switch to, so nothing was shown.`, where);
  }
  return toClient(d, where, { path: f.rel, ...(vname ? { vault: vname } : {}), ...(sha ? { sha } : {}), ...(hasTarget(t) ? { target: t } : {}), ...(pane ? { pane } : {}) }, `${name}${vname ? ` (vault ${vname})` : ""}${pane ? ` in the ${pane} pane` : ""}${hasTarget(t) ? ` at ${spotLabel(t)}` : ""}`, because);
}

/** A path (vault-relative or absolute) to an existing file inside the vault, by the same rule as every vault tool (server/vaultPath.ts: never .git), or why not. */
async function vaultFile(vault: string, p: string): Promise<{ abs: string; rel: string } | string> {
  let r: { abs: string; rel: string };
  try {
    r = (await import("./vaultPath")).vaultPath(vault, p, "read");
  } catch (e) {
    return String(e).replace(/^Refused: /, "");
  }
  try {
    if (!statSync(r.abs).isFile()) return `${r.rel} is not a file`;
  } catch {
    return `${r.rel} does not exist in the vault`;
  }
  return r;
}

// ---------------------------------------------------------------- laptop / phone: a signal, then the ack

async function toClient(d: ShowDeps, where: Device, payload: Record<string, unknown>, what: string, because: string): Promise<ShowResult> {
  const dev = DEVICE_NAME[where];
  // The laptop: its control link, whatever vault it has open (a file of another vault carries that vault's name).
  if (!(feedLive(d.vault, where) || (where === "laptop" && controlLive("laptop")))) {
    const alt = where === "laptop" ? "Put it in your reply instead (an image or a link shows in the chat)." : "Ask Carl: show it on the laptop instead?";
    return fail(`The ${dev} isn't online (the vault-chat app isn't open and connected on it), so nothing was shown${because}. ${alt}`, where);
  }
  if (where === "phone" && payload.target) {
    // The phone has no viewer that moves to a place: it shows the file whole.
    delete payload.target;
  }
  const id = `show-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const ms = d.ackMs?.[where] ?? (where === "laptop" ? 20_000 : 10_000);
  const t0 = Date.now();
  const got = waitAck(id, ms);
  d.emit({ type: "show", id, to: where, ...payload });
  const ack = await got;
  console.log(`[show] to=${where} ${ack ? (ack.ok ? "ok" : "refused") : "no-ack"} ${Date.now() - t0}ms`);
  if (!ack) return fail(`Sent ${what} to the ${dev}${because}, but it did not confirm within ${Math.round(ms / 1000)} s — it may not have opened. Don't tell Carl it's open; ask him to check (the image in your reply still shows in the chat).`, where);
  if (!ack.ok) return fail(`On the ${dev}${because}: ${ack.error ?? "it could not be shown"}`, where);
  const phoneNote = where === "phone" && what.includes(" at ") ? " (the phone shows it whole; it can't jump to a place)" : "";
  // An app from before panes opens it in the active pane and does not say a pane: say so, never claim the split.
  // Another vault: an app from before `vault` opens the path in whatever vault it has open; never claim the switch.
  if (payload.vault && ack.vault !== payload.vault) return fail(`The ${dev} app is older and cannot switch vaults from Show: it did not confirm opening ${payload.path} in the vault ${payload.vault} (it said: ${ack.landed ?? "nothing"}). Switch its workspace with PluginAct app/vaults open {name: "${payload.vault}"}, then Show the path without vault.`, where);
  const paneNote = payload.pane && ack.pane !== payload.pane ? ` (this laptop app is older and has no pane control: it opened in the active pane, not the ${payload.pane} pane — Carl can drag it to that side, or update the app)` : "";
  return { ok: true, where, text: `Shown on the ${dev}${because}: ${ack.landed ?? what}${phoneNote}${paneNote}.` };
}
