// One-shot model calls (Ctrl+K / Ctrl+L, a note's title and summary, spoken
// math as notation): no tools, no memory — one request, one text. They run on
// the box with its key (POST /api/v1/complete); the box itself runs them in
// process (server/main.ts sets that). With no box, or the box unreachable,
// they fail with the same words the chat shows.
export type CompleteRequest = {
  /** The system prompt. */
  instructions: string;
  /** The one user message. */
  text: string;
  /** Images (data: URLs) the request is about. */
  images?: string[];
  /** The box's cheap fast model, not its agent model. */
  fast?: boolean;
  maxOutputTokens?: number;
};

export type Complete = (req: CompleteRequest) => Promise<string>;

let impl: Complete | null = null;

/** Where one-shot calls run (the server sets its own; the app goes to its box). */
export function setComplete(fn: Complete): void {
  impl = fn;
}

export async function complete(req: CompleteRequest): Promise<string> {
  if (impl) return impl(req);
  return (await import("./boxChat")).boxComplete(req);
}
