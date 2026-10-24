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

/** Whether Carl is looking at the iPad (server/pushGate.ts: his phone stays quiet while he is). */
export const postAttention = (b: { device: "board"; looking: boolean; convId: string | null }) => call<{ ok: true }>("/api/v1/attention", { method: "POST", body: JSON.stringify(b), keepalive: true });
export const listBoards = () => call<{ boards: BoardSummary[] }>("/api/v1/boards").then((r) => r.boards);
export const createBoard = (name: string) => call<{ slug: string; board: Board }>("/api/v1/boards", { method: "POST", body: JSON.stringify({ name }) });
export const getBoard = (slug: string) => call<Board>(`/api/v1/boards/${enc(slug)}`);
/** This vault's key for things kept on the device per board (unsaved work: board/src/local.ts). */
export const vaultKey = () => VAULT;

export type SaveOut = { ok: true; rev: number; updated: number; already?: boolean };
/** A save stalls when nothing moves for this long: no upload progress, or no answer once the body is sent. */
export const SAVE_STALL_MS = 20_000;

/**
 * Save the board (`boardJson`: the board, already serialized), with overview.png (the whole board) and view.png
 * (the part in view) for the agent. `writer`/`gen`: this page's id and how far its edits had got, so a save resent
 * after its answer was lost is not taken for a change made elsewhere (server/boards.ts).
 *
 * It never hangs: an XMLHttpRequest that makes no progress for SAVE_STALL_MS (nothing uploaded, or no answer once
 * the body is up) is aborted and fails like any network error (status 0), so the caller retries. A slow upload that
 * keeps moving is not cut off, however big the board.
 */
export function saveBoard(
  slug: string,
  boardJson: string,
  base: number,
  o: { overview?: string; history?: BoardHistory; view?: string; writer?: string; gen?: number } = {},
  stallMs = SAVE_STALL_MS,
): Promise<SaveOut> {
  const rest = JSON.stringify({ base, overview: o.overview, history: o.history, view: o.view, writer: o.writer, gen: o.gen });
  const body = `{"board":${boardJson},${rest.slice(1)}`;
  return new Promise<SaveOut>((resolve, reject) => {
    const x = new XMLHttpRequest();
    let timer = 0;
    let done = false;
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      f();
    };
    const arm = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        x.abort();
        finish(() => reject(new HttpError(0, `no progress for ${Math.round(stallMs / 1000)} s`)));
      }, stallMs);
    };
    x.open("POST", inVault(`/api/v1/boards/${enc(slug)}`));
    x.setRequestHeader("Content-Type", "application/json");
    if (TOKEN) x.setRequestHeader("X-Vault-Token", TOKEN);
    x.upload.onprogress = arm;
    x.upload.onload = arm;
    x.onprogress = arm;
    x.onerror = () => finish(() => reject(new HttpError(0, "network error")));
    x.onabort = () => finish(() => reject(new HttpError(0, "aborted")));
    x.ontimeout = x.onerror;
    x.onload = () =>
      finish(() => {
        let j: any = null;
        try {
          j = JSON.parse(x.responseText);
        } catch {
          /* not JSON */
        }
        if (x.status >= 200 && x.status < 300 && j && typeof j.rev === "number") resolve(j as SaveOut);
        else reject(new HttpError(x.status, j?.error || `HTTP ${x.status}`, j));
      });
    arm();
    x.send(body);
  });
}
/** The undo and redo saved with the board (rev -1 when there are none). */
export const getHistory = (slug: string) => call<BoardHistory>(`/api/v1/boards/${enc(slug)}/history`);
/** Copy another board's files into this one (items pasted from it keep their names). */
export const copyAssets = (slug: string, from: string, srcs: string[]) =>
  call<{ ok: true; copied: number }>(`/api/v1/boards/${enc(slug)}/assets/copy`, { method: "POST", body: JSON.stringify({ from, srcs }) });
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

/**
 * The box's event ring (/poll): `fn` gets this vault's records (an inbox change arrives wrapped as
 * {type:"signal", signal:{type:"inbox", …}}); `resync` is called whenever events may have been missed (the first
 * answer, a reconnect, a reset after the box restarted), so the caller re-reads its state. Resolves never.
 *
 * A long poll is cut off after 35 s (the box answers within 25 s; a request iPadOS froze in the background never
 * settles on its own), and coming back to the foreground reconnects at once.
 */
export function watch(fn: (ev: any) => void, resync: () => void = () => {}): void {
  let cursor: number | null = null, epoch: string | null = null;
  let ctl: AbortController | null = null;
  let wake: (() => void) | null = null;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    ctl?.abort();
    wake?.();
  });
  void (async () => {
    for (;;) {
      ctl = new AbortController();
      const timer = setTimeout(() => ctl?.abort(), 35_000);
      try {
        const q = cursor === null ? "latest" : `${cursor}${epoch ? `&epoch=${enc(epoch)}` : ""}`;
        // client=board: the box knows a board app is following (server/show.ts sends it Show's signals).
        const r: { next: number; events: any[]; epoch?: string; reset?: boolean } = await call(`/poll?after=${q}&client=board`, { signal: ctl.signal });
        if (cursor === null || r.reset) resync();
        else for (const e of r.events) fn(e);
        cursor = r.next;
        epoch = r.epoch ?? null;
      } catch {
        // Offline, the box restarting, or cut off: start again from the head and re-read (nothing is lost).
        const aborted = ctl.signal.aborted;
        cursor = null;
        if (!aborted || document.visibilityState === "hidden") await new Promise<void>((res) => ((wake = res), setTimeout(res, 3000)));
        wake = null;
      } finally {
        clearTimeout(timer);
      }
    }
  })();
}

/** Show (server/show.ts): what happened to a {type:"show"} signal on this iPad. */
export const ackShow = (id: string, ack: { ok: boolean; landed?: string; error?: string }) =>
  call<{ ok: true; waiting: boolean }>(`/api/v1/show/${enc(id)}/ack`, { method: "POST", body: JSON.stringify(ack) });

// ---- voice (server/voice.ts): the box's own voice path, the one the phone uses
/** Carl's conversations, most recently active first (the phone's list: GET /conversations). */
/** `kind`: main | project | separate, "" for an older chat (src/threads.ts). */
export type ChatRow = { id: string; title: string; lastActivityAt: number; source: string; kind?: string };
export const listChats = () => call<{ conversations: ChatRow[] }>("/conversations").then((r) => r.conversations ?? []);
/** A signed ElevenLabs session for the box's board voice agent, its prompt built from `convId`'s pi session (server/voice.ts). */
export type VoiceConfig = { signedUrl: string | null; conversationToken?: string | null; voiceId?: string; systemPrompt?: string; dynamicVariables?: Record<string, string>; toolNames?: string[]; convId?: string | null; cursor?: string | null; images?: { mime: string; dataBase64: string }[]; sessionId?: string | null; handoff?: { from: string; convId: string | null } | null };
export const voiceSession = (convId: string | null) => call<VoiceConfig>(`/api/v1/voice/session?device=board${convId ? `&convId=${enc(convId)}` : ""}`);
/** Voice's one tool that acts (Ask: a request to the conversation's agent), run on the box. */
export const voiceTool = (body: { name: string; args: unknown; convId: string | null; device: "board" }) =>
  call<{ result?: string; error?: string; convId?: string | null }>("/api/v1/voice/tool", { method: "POST", body: JSON.stringify(body) });
/** One line of the call, saved on the box into its conversation (the first makes a new one when there is none). */
export const voiceTranscript = (body: { convId: string | null; role: string; text: string; system?: boolean; ended?: boolean; device: "board" }) =>
  call<{ convId?: string | null }>("/api/v1/voice/transcript", { method: "POST", body: JSON.stringify(body) });
/** The box's voice engine (Settings → Voice engine on the laptop): "new" = the voice is the conversation's agent. */
export const brainEngine = () => call<{ engine: "classic" | "new"; pipeline: boolean }>("/api/v1/brain/engine");
/** The New voice's calls (src/voiceBrainClient.ts): start, offer, end. */
/** What the voice waits on (the waiting line under the pill's waves): server/voiceBrain.ts GET /api/v1/brain/wait. */
export const brainWait = (convId: string) => call<{ works: any[]; plan: any; calib: any; now: number }>(`/api/v1/brain/wait/${enc(convId)}`);
export const brainPost = (path: string, body: Record<string, unknown>) => call<any>(path, { method: "POST", body: JSON.stringify(body) });
/** One long poll of the live call's updates: the agent's answers, what Carl did elsewhere. */
export const voiceUpdates = (convId: string, cursor: string | null, session?: string | null) =>
  call<{ updates: { id: string; kind: string; text: string; speak: boolean }[]; cursor: string; moved?: { to: string; line: string } | null }>(
    `/api/v1/voice/updates?convId=${enc(convId)}&wait=20000${cursor ? `&cursor=${enc(cursor)}` : ""}${session ? `&session=${enc(session)}` : ""}`,
  );
