// A plugin's `converse` service (change 1.3 of the plugin refactor): a page starts real conversations in Carl's chat
// list, sends messages to them, lists his chats and reads one. All pages are fully trusted, so a page reaches every
// chat, as Carl does; what it may NOT do is anything but start and send (no delete, rename, stop, project changes).
//
//   POST /api/v2/intent {type: "start", text}            → {ok, convId}   a new chat, its first message `text`
//   POST /api/v2/intent {type: "send", convId, text}     → {ok, convId}   a message into a chat that exists
//   GET  /api/v2/conversations                            → {rows, …}      the chat list (the box's own route)
//   GET  /api/v2/conversations/<id>/events?after=N        → {events, next} one chat's records (the box's own route)
//
// What the page sends becomes an ordinary `send` intent of the box's own, under an id the box chooses, marked as the
// page's (`via: "page"`, a record in the one log) with the page named in the turn's context (who is acting).
// Shared by the box (server/liveProxy.ts) and the preview harness's fake box: no imports.

export const CONVERSE_LIMITS = {
  /** The most characters one message from a page carries. */
  textChars: 20_000,
} as const;

/** A conversation id a page may name (the box's own ids: uuids, `main`, `project-<slug>`). */
export const CONVERSE_ID = /^[A-Za-z0-9_-]{1,120}$/;

/** How a page's message shows in the log (its item's `via`). */
export const CONVERSE_VIA = "page";

/** What the agent is told about a message a page sent (the turn's context, not shown as the message). */
export function converseContext(page: string): string {
  return `<live-page path=${JSON.stringify(page)}>This message was sent by an interactive page in Carl's vault (through the page's own UI), not typed in a chat.</live-page>`;
}

type Bad = { status: number; error: string };
export type ConverseIntent = { kind: "start" | "send"; intent: { type: "send"; convId: string; clientId: string; text: string; via: string; context: string } };

/** The box intent a page's POST becomes, or why not. `newId()`: a fresh id (the new chat's, the message's). */
export function converseIntent(page: string, body: string, newId: () => string): ConverseIntent | Bad {
  let b: unknown;
  try {
    b = JSON.parse(body || "null");
  } catch {
    return { status: 400, error: "bad JSON" };
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return { status: 400, error: "send {type: start|send, text}" };
  const o = b as { type?: unknown; convId?: unknown; text?: unknown };
  if (o.type !== "start" && o.type !== "send") return { status: 403, error: "a page may start a conversation or send to one, nothing else" };
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text) return { status: 400, error: "missing text" };
  if (text.length > CONVERSE_LIMITS.textChars) return { status: 413, error: `a message is at most ${CONVERSE_LIMITS.textChars} characters` };
  let convId: string;
  if (o.type === "send") {
    if (typeof o.convId !== "string" || !CONVERSE_ID.test(o.convId)) return { status: 400, error: "name the conversation (convId); start makes a new one" };
    convId = o.convId;
  } else convId = newId();
  return { kind: o.type, intent: { type: "send", convId, clientId: `page-${newId()}`, text, via: CONVERSE_VIA, context: converseContext(page) } };
}

/** The read side's `after` (`?after=N`): a whole number, 0 when absent or bad. */
export function converseAfter(query: string): number {
  const n = Number(new URLSearchParams(query).get("after"));
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}
