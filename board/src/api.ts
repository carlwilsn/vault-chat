// The box, as the board sees it: the phone's auth model. The page is served
// token-free and provisions the vc_token cookie; a tailnet login or that cookie
// authorizes the data calls. A ?token= (an old phone link) is remembered like the
// phone remembers it (same origin, same key).
import type { Board, BoardSummary } from "../../src/boardFormat";

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

export const listBoards = () => call<{ boards: BoardSummary[] }>("/api/v1/boards").then((r) => r.boards);
export const createBoard = (name: string) => call<{ slug: string; board: Board }>("/api/v1/boards", { method: "POST", body: JSON.stringify({ name }) });
export const getBoard = (slug: string) => call<Board>(`/api/v1/boards/${enc(slug)}`);
export const saveBoard = (slug: string, board: Board, base: number, png: Record<string, string>) =>
  call<{ ok: true; rev: number; updated: number }>(`/api/v1/boards/${enc(slug)}`, { method: "POST", body: JSON.stringify({ board, base, png }) });

/** A page snapshot for an <img> (the cookie or the token authorizes it). */
export function pageUrl(slug: string, n: number, v: number): string {
  const u = inVault(`/api/v1/boards/${enc(slug)}/page-${n}.png?v=${v}`);
  return TOKEN ? `${u}&token=${enc(TOKEN)}` : u;
}
