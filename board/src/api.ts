// The box, as the board sees it: the phone's auth model. The page is served
// token-free and provisions the vc_token cookie; a tailnet login or that cookie
// authorizes the data calls. A ?token= (an old phone link) is remembered like the
// phone remembers it (same origin, same key).
import type { Board, BoardHistory, BoardSummary } from "../../src/boardFormat";
import type { Entry, EntrySummary } from "../../src/inboxFormat";

const qs = new URLSearchParams(location.search);
let TOKEN = qs.get("token") || "";
let VAULT = qs.get("vault") || "";
try {
  if (TOKEN) localStorage.setItem("vc_phone_token", TOKEN);
  else TOKEN = localStorage.getItem("vc_phone_token") || "";
  if (qs.has("vault")) {
    if (VAULT) localStorage.setItem("vc_board_vault", VAULT);
    else localStorage.removeItem("vc_board_vault");
  } else VAULT = localStorage.getItem("vc_board_vault") || "";
} catch {
  /* storage blocked: cookie only */
}

const inVault = (path: string) => (VAULT ? path + (path.includes("?") ? "&" : "?") + "vault=" + encodeURIComponent(VAULT) : path);

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: any = null,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
  if (TOKEN) headers["X-Vault-Token"] = TOKEN;
  if (init.body) headers["Content-Type"] = "application/json";
  const r = await fetch(inVault(path), { ...init, headers });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new HttpError(r.status, body?.error || `HTTP ${r.status}`, body);
  return body as T;
}

const enc = encodeURIComponent;

/** The board's log batch (board/src/log.ts → the box's board.jsonl). `keepalive`: sent as the page hides. */
export const postBoardLog = (b: { session: string; v?: string; touch?: number; standalone?: boolean; events: unknown[] }, keepalive = false) =>
  call<{ ok: true; n: number }>("/api/v1/board/log", { method: "POST", body: JSON.stringify(b), ...(keepalive ? { keepalive: true } : {}) });

export const listBoards = () => call<{ boards: BoardSummary[] }>("/api/v1/boards").then((r) => r.boards);
export const createBoard = (name: string) => call<{ slug: string; board: Board }>("/api/v1/boards", { method: "POST", body: JSON.stringify({ name }) });
export const getBoard = (slug: string) => call<Board>(`/api/v1/boards/${enc(slug)}`);
export const saveBoard = (slug: string, board: Board, base: number, overview?: string, history?: BoardHistory) =>
  call<{ ok: true; rev: number; updated: number }>(`/api/v1/boards/${enc(slug)}`, { method: "POST", body: JSON.stringify({ board, base, overview, history }) });
/** The undo and redo saved with the board (rev -1 when there are none). */
export const getHistory = (slug: string) => call<BoardHistory>(`/api/v1/boards/${enc(slug)}/history`);
/** Store an image (base64 PNG/JPEG) in the board folder, for an item. */
export const addAsset = (slug: string, data: string) => call<{ src: string; w: number; h: number }>(`/api/v1/boards/${enc(slug)}/assets`, { method: "POST", body: JSON.stringify({ data }) });

const withToken = (u: string) => (TOKEN ? `${u}${u.includes("?") ? "&" : "?"}token=${enc(TOKEN)}` : u);

/** The board's overview snapshot for an <img> (the cookie or the token authorizes it). */
export const overviewUrl = (slug: string, v: number) => withToken(inVault(`/api/v1/boards/${enc(slug)}/overview.png?v=${v}`));

/** An item's file (`assets/<name>`) for an <img>. */
export const assetUrl = (slug: string, src: string) => withToken(inVault(`/api/v1/boards/${enc(slug)}/${src.split("/").map(enc).join("/")}`));

export const renameBoard = (slug: string, name: string) => call<{ ok: true; name: string }>(`/api/v1/boards/${enc(slug)}/rename`, { method: "POST", body: JSON.stringify({ name }) });
/** Moves the board to boards/.trash on the box (nothing is removed). */
export const deleteBoard = (slug: string) => call<{ ok: true }>(`/api/v1/boards/${enc(slug)}/delete`, { method: "POST", body: "{}" });

// ---- the inbox (board/INBOX.md, server/inbox.ts)
export const listInbox = () => call<{ entries: EntrySummary[]; unread: number }>("/api/v1/inbox");
export const getEntry = (id: string) => call<Entry>(`/api/v1/inbox/${enc(id)}`);
export const markRead = (id: string) => call<{ ok: true }>(`/api/v1/inbox/${enc(id)}/read`, { method: "POST", body: "{}" });
export const markAdded = (id: string, part: number, board: string, items: string[]) =>
  call<{ ok: true }>(`/api/v1/inbox/${enc(id)}/added`, { method: "POST", body: JSON.stringify({ part, board, items }) });
/** A part's files for the viewer: the PDF or image itself, `html` (math), `bundle` (widget). */
export const partUrl = (id: string, n: number, what?: "html" | "bundle" | "snapshot") => withToken(inVault(`/api/v1/inbox/${enc(id)}/part/${n}${what ? `/${what}` : ""}`));
/** Copy a part (or every part) into the board; the items to place come back. */
export const fromInbox = (slug: string, id: string, part?: number) =>
  call<{ items: ItemTemplate[] }>(`/api/v1/boards/${enc(slug)}/from-inbox`, { method: "POST", body: JSON.stringify(part === undefined ? { id } : { id, part }) });
export type ItemTemplate = Record<string, unknown> & { kind: string; src: string; lw: number; lh: number; label?: string; width?: number; inbox: { id: string; part: number } };

/** Text (typeset math, a widget's bundle) from a URL above. */
export async function text(url: string): Promise<string> {
  const headers: Record<string, string> = TOKEN ? { "X-Vault-Token": TOKEN } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) throw new HttpError(r.status, `HTTP ${r.status}`);
  return r.text();
}

/** The box's event ring (/poll): `fn` gets this vault's events; resolves never. */
export async function watch(fn: (ev: any) => void): Promise<void> {
  let cursor: number | null = null;
  for (;;) {
    try {
      const r: { next: number; events: any[] } = await call(`/poll?after=${cursor ?? "latest"}`);
      if (cursor !== null) for (const e of r.events) fn(e);
      cursor = r.next;
    } catch {
      await new Promise((res) => setTimeout(res, 4000));
    }
  }
}

// ---- voice (server/voice.ts): the box's own voice path, the one the phone uses
/** Carl's conversations, most recently active first (the phone's list: GET /conversations). */
export type ChatRow = { id: string; title: string; lastActivityAt: number; source: string };
export const listChats = () => call<{ conversations: ChatRow[] }>("/conversations").then((r) => r.conversations ?? []);
/** A signed ElevenLabs session for the box's board voice agent, its prompt built from `convId`'s pi session (server/voice.ts). */
export type VoiceConfig = { signedUrl: string | null; conversationToken?: string | null; voiceId?: string; systemPrompt?: string; dynamicVariables?: Record<string, string>; toolNames?: string[]; convId?: string | null; cursor?: string | null; images?: { mime: string; dataBase64: string }[] };
export const voiceSession = (convId: string | null) => call<VoiceConfig>(`/api/v1/voice/session?device=board${convId ? `&convId=${enc(convId)}` : ""}`);
/** Voice's one tool that acts (Ask: a request to the conversation's agent), run on the box. */
export const voiceTool = (body: { name: string; args: unknown; convId: string | null; device: "board" }) =>
  call<{ result?: string; error?: string; convId?: string | null }>("/api/v1/voice/tool", { method: "POST", body: JSON.stringify(body) });
/** One line of the call, saved on the box into its conversation (the first makes a new one when there is none). */
export const voiceTranscript = (body: { convId: string | null; role: string; text: string; system?: boolean; ended?: boolean; device: "board" }) =>
  call<{ convId?: string | null }>("/api/v1/voice/transcript", { method: "POST", body: JSON.stringify(body) });
/** One long poll of the live call's updates: the agent's answers, what Carl did elsewhere. */
export const voiceUpdates = (convId: string, cursor: string | null) =>
  call<{ updates: { id: string; kind: string; text: string; speak: boolean }[]; cursor: string }>(`/api/v1/voice/updates?convId=${enc(convId)}&wait=20000${cursor ? `&cursor=${enc(cursor)}` : ""}`);
