// The app's model requests, all in pi on the box (server/engine/pi/side.ts):
//
//  - side(): Ctrl+K / Ctrl+L — a side thread of the open conversation (pi forks
//    its session: the same agent, the same context) with pi's read-only tools.
//    The answer streams (`onText`); a popover's next request continues the
//    same side thread (`side`).
//  - complete(): a one-shot (a note's title and summary, spoken math as
//    notation) — pi with no session and no tools, on the box's fast model.
//
// The box itself runs one-shots in process (server/main.ts sets that). With no
// box, or the box unreachable, they fail with the same words the chat shows.
export type CompleteRequest = {
  /** The system prompt. */
  instructions: string;
  /** The one user message. */
  text: string;
  /** Images (data: URLs) the request is about. */
  images?: string[];
  /** The box's cheap fast model, not its agent model. */
  fast?: boolean;
};

export type Complete = (req: CompleteRequest) => Promise<string>;

export type SideRequest = {
  kind: "edit" | "ask";
  text: string;
  /** data: URLs. */
  images?: string[];
  /** The conversation whose pi session the side thread forks (none: a fresh session). */
  convId?: string | null;
  /** Continue this side thread (the popover's earlier requests). */
  side?: string | null;
};

export type SideResult = { text: string; side: string };
export type SideOpts = { onText?: (text: string) => void; signal?: AbortSignal };

let impl: Complete | null = null;

/** Where one-shots run (the server sets its own; the app goes to its box). */
export function setComplete(fn: Complete): void {
  impl = fn;
}

export async function complete(req: CompleteRequest): Promise<string> {
  if (impl) return impl(req);
  const r = await (await import("./boxChat")).boxSide({ kind: "once", system: req.instructions, text: req.text, images: req.images, fast: !!req.fast });
  return r.text;
}

/** Ctrl+K / Ctrl+L on the box: the final text and the side thread's id. */
export async function side(req: SideRequest, opts: SideOpts = {}): Promise<SideResult> {
  return (await import("./boxChat")).boxSide(req, opts);
}
