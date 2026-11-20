// The agent's Screen tool: see Carl's real laptop app. It rides Show's channel (server/show.ts) like Layout: a
// {type:"capture", id, to:"laptop", target, maxWidth} signal on the vault's feed; the laptop app (the device host that
// supplies the `capture` service) draws its own window (src/screenCapture.ts, a picture of the app's DOM, not the
// desktop) and acks over POST /api/v1/show/<id>/ack with {ok, image:{data, mimeType, width, height}}. The result is
// only ever that picture, or an honest "offline" / "didn't answer" / "couldn't draw it".
import { randomBytes } from "node:crypto";
import { waitAck } from "./show";
import { controlDown, noteAnswer, unansweredNote } from "./deviceLink";

export const SCREEN_TARGETS = ["window", "viewer", "chat"] as const;
export type ScreenTarget = (typeof SCREEN_TARGETS)[number];
/** The widest picture the agent gets (the laptop downscales to it; the box refuses anything wider). */
export const SCREEN_MAX_WIDTH = 1600;
export const SCREEN_MAX_HEIGHT = 4000;
/** base64 characters: ~6 MB of PNG. */
export const SCREEN_MAX_BASE64 = 8_000_000;

export const SCREEN_DESCRIPTION =
  "See Carl's real laptop app as it looks now: a picture of the vault-chat window (only the app's own window, never the rest of his desktop), downscaled to at most 1600 px wide. " +
  "target: \"window\" (default, the whole app), \"viewer\" (the file viewer column) or \"chat\" (the chat column). " +
  "Use it to check what he actually sees (after Show or Layout, when he says \"look at my screen\", \"what's wrong with this\", or to confirm a UI change on his laptop), instead of asking him for a screenshot. " +
  "Laptop only: when the app isn't open and connected it says so (don't guess what is on screen). A viewer HTML page draws itself into the picture (src/pageSnap.ts); other live frames (inline chat pages) are drawn as a labelled box.";

export const SCREEN_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string", enum: [...SCREEN_TARGETS], description: "window (default), viewer or chat." },
  },
  additionalProperties: false,
} as const;

export type ScreenDeps = {
  vault: string;
  emit: (ev: Record<string, unknown>) => void;
  /** How long the laptop has to answer (default 20 s: drawing a big window takes a moment). */
  ackMs?: number;
};

export type ScreenImage = { data: string; mimeType: string };
export type ScreenResult = { ok: boolean; text: string; images: ScreenImage[] };

/** A PNG's width and height from its IHDR, or null when it is not a PNG. */
export function pngSize(b64: string): { width: number; height: number } | null {
  try {
    const head = Buffer.from(b64.slice(0, 64), "base64");
    if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47 || head.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/** Checks the laptop's picture: a real PNG within the size cap. A string is why it was refused. */
export function checkScreenImage(raw: unknown): (ScreenImage & { width: number; height: number }) | string {
  const im = (raw ?? {}) as Record<string, unknown>;
  const data = typeof im.data === "string" ? im.data.replace(/^data:image\/png;base64,/, "") : "";
  if (!data) return "the laptop sent no picture";
  if (data.length > SCREEN_MAX_BASE64) return `the picture is too big (${Math.round((data.length * 3) / 4 / 1e6)} MB)`;
  const size = pngSize(data);
  if (!size) return "the laptop's picture is not a PNG";
  if (size.width > SCREEN_MAX_WIDTH || size.height > SCREEN_MAX_HEIGHT || size.width < 1 || size.height < 1) return `the picture is ${size.width}x${size.height}, outside the ${SCREEN_MAX_WIDTH} px cap`;
  return { data, mimeType: "image/png", ...size };
}

export async function screenTool(d: ScreenDeps, args: Record<string, unknown>): Promise<ScreenResult> {
  const target = args.target === undefined || args.target === "" ? "window" : String(args.target);
  if (!(SCREEN_TARGETS as readonly string[]).includes(target)) return { ok: false, text: `Unknown target "${target}". Use window, viewer or chat.`, images: [] };
  const down = controlDown("laptop");
  if (down) return { ok: false, text: `${down} So its screen can't be seen. Say so; don't guess what is on it.`, images: [] };
  const id = `capture-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const ms = d.ackMs ?? 20_000;
  const got = waitAck(id, ms);
  d.emit({ type: "capture", id, to: "laptop", target, maxWidth: SCREEN_MAX_WIDTH });
  const ack = await got;
  noteAnswer("laptop", "capture", !!ack);
  if (!ack) return { ok: false, text: `Asked the laptop for a picture of its screen, but it did not answer within ${Math.round(ms / 1000)} s (an older app without screen capture, or it is busy). Nothing was seen; don't describe the screen.${unansweredNote("laptop")}`, images: [] };
  if (!ack.ok) return { ok: false, text: `The laptop could not draw its screen: ${ack.error ?? "no reason given"}. Nothing was seen.`, images: [] };
  const im = checkScreenImage(ack.image);
  if (typeof im === "string") return { ok: false, text: `The laptop answered, but ${im}. Nothing was seen.`, images: [] };
  const text = [`Carl's laptop app now (${target}, ${im.width}x${im.height} px, drawn from the app's own window${ack.landed ? `; ${ack.landed}` : ""}).`].join("\n");
  return { ok: true, text, images: [{ data: im.data, mimeType: im.mimeType }] };
}
