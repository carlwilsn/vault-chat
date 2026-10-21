// Voice in box mode: voice is the box's — one agent, one key place — and the
// front of house of the conversation that is open (D3). The box mints the
// session (GET /api/v1/voice/session: its agent for this laptop, its prompt from
// the conversation's pi session), runs voice's one tool that acts (POST
// /api/v1/voice/tool: Ask, a request to the conversation's agent), saves every
// line into that conversation (POST /api/v1/voice/transcript), and hands the
// live call its updates (GET /api/v1/voice/updates). Paths the voice builds
// from this laptop's vault root are sent vault-relative. Tools that read or
// move the screen never go there (LOCAL_VOICE_TOOLS).
import { boxGet, boxLinkFor, boxPost, boxOutgoingLine, newClientId, type Link } from "./boxChat";
import { useStore, type ChatMessage } from "./store";

const PATH_KEYS = ["path", "cwd", "source_path"];

/** Args with paths under `vault` made vault-relative (other paths are left for the box to refuse). */
export function relativeArgs(args: unknown, vault: string): Record<string, unknown> {
  const a = args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {};
  const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const k of PATH_KEYS) {
    const v = a[k];
    if (typeof v !== "string") continue;
    const p = v.replace(/\\/g, "/");
    const low = (x: string) => (/^[a-z]:\//i.test(nv) ? x.toLowerCase() : x);
    if (low(p) === low(nv)) a[k] = ".";
    else if (low(p).startsWith(low(nv) + "/")) a[k] = p.slice(nv.length + 1);
  }
  return a;
}

type Post = (link: Link, path: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; data?: Record<string, unknown>; network?: boolean }>;

/** This vault's box (the link carries the vault's name there: every request
 * runs in that vault's working copy and engine) and the tool runner. */
export type BoxVoice = { link: Link; vault: string; tool: (name: string, args: unknown) => Promise<string> };

/** The remote runner for one link (its tools run in the conversation `convId()` names). */
export function voiceToolVia(link: Link, vault: string, post: Post = boxPost, convId: () => string | null = () => null, sessionId: () => string | null = () => null) {
  return async (name: string, args: unknown): Promise<string> => {
    const sid = sessionId();
    const r = await post(link, "/api/v1/voice/tool", { name, args: relativeArgs(args, vault), convId: convId(), device: "laptop", ...(sid ? { sessionId: sid } : {}) });
    if (!r.ok) return `Error: the box did not run ${name} (${r.error ?? "unreachable"}).`;
    return typeof r.data?.result === "string" ? r.data.result : JSON.stringify(r.data ?? {});
  };
}

/** The box `vault` runs on, or null (voice runs here). */
export async function boxVoice(vault: string | null, post: Post = boxPost, convId: () => string | null = () => useStore.getState().activeConversationId): Promise<BoxVoice | null> {
  if (!vault) return null;
  const link = await boxLinkFor(vault).catch(() => null);
  if (!link) return null;
  return { link, vault, tool: voiceToolVia(link, vault, post, convId) };
}

/** One long poll of the call's updates (server/voice.ts voiceUpdates): the agent's answers and what Carl did elsewhere. */
export async function boxVoiceUpdates(
  link: Link,
  convId: string,
  cursor: string | null,
  get: (link: Link, path: string, timeoutMs?: number) => Promise<any> = boxGet,
  sessionId: string | null = null,
): Promise<{ updates: { id: string; kind: string; text: string; speak: boolean }[]; cursor: string; moved?: { to: string; line: string } | null }> {
  const q = new URLSearchParams({ convId, wait: "20000" });
  if (cursor) q.set("cursor", cursor);
  if (sessionId) q.set("session", sessionId);
  const r = await get(link, `/api/v1/voice/updates?${q}`, 30_000);
  const moved = r?.moved && typeof r.moved.line === "string" ? { to: String(r.moved.to ?? ""), line: r.moved.line as string } : null;
  return { updates: Array.isArray(r?.updates) ? r.updates : [], cursor: typeof r?.cursor === "string" ? r.cursor : (cursor ?? ""), moved };
}

/** The remote runner when `vault` runs on a box, else null (tools run here). */
export async function boxVoiceTool(vault: string | null): Promise<((name: string, args: unknown) => Promise<string>) | null> {
  return (await boxVoice(vault))?.tool ?? null;
}

export type BoxVoiceSession = {
  /** WebSocket credential (null when the box minted only a token). */
  signedUrl: string | null;
  /** WebRTC credential (ElevenLabs' recommended transport); absent from boxes before it. */
  conversationToken?: string | null;
  systemPrompt: string;
  voiceId?: string;
  toolNames: string[];
  vaultRoot?: string;
  dynamicVariables?: Record<string, string>;
  /** Where the call's updates start (GET /api/v1/voice/updates). */
  cursor?: string | null;
  /** This call's id on the box (one voice at a time: its lines, tools and polls carry it). */
  sessionId?: string | null;
  /** The conversation the box attached the call to (a hand-off: the one voice was live in on another device). */
  convId?: string | null;
  handoff?: { from: string; convId: string | null } | null;
};

/** The box's session for this vault. `unreachable`: the box did not answer
 * (the caller may fall back to its own agent); `unsupported`: the box doesn't
 * have this vault, or is from before voice (voice runs here, as without a box). */
export async function boxVoiceSession(
  b: BoxVoice,
  convId: string | null,
  get: (link: Link, path: string, timeoutMs?: number) => Promise<any> = boxGet,
): Promise<{ session?: BoxVoiceSession; error?: string; unreachable?: boolean; unsupported?: boolean }> {
  const q = new URLSearchParams();
  if (convId) q.set("convId", convId);
  q.set("device", "laptop");
  // This laptop's Settings → voice model and voice: the box's agent uses them.
  try {
    const llm = localStorage.getItem("vault_chat_elevenlabs_llm");
    const voice = localStorage.getItem("vault_chat_elevenlabs_voice");
    if (llm) q.set("llm", llm);
    if (voice) q.set("voice", voice);
  } catch {
    /* no storage */
  }
  const qs = q.toString();
  try {
    const s = await get(b.link, `/api/v1/voice/session${qs ? `?${qs}` : ""}`, 20_000);
    if (!s || (typeof s.signedUrl !== "string" && typeof s.conversationToken !== "string")) return { error: "the box sent no signed URL or conversation token" };
    return { session: { ...s, toolNames: Array.isArray(s.toolNames) ? s.toolNames : [] } };
  } catch (e) {
    const status = (e as { status?: number }).status;
    const msg = String((e as Error)?.message ?? e);
    if (!status) return { unreachable: true, error: msg };
    if (status === 404) return { unsupported: true, error: msg };
    return { error: msg };
  }
}

/** Save a call's lines on the box, in order, into the conversation voice is attached to (`convId`: the box makes
 * it under this id when it is a new chat). `done()` resolves once every line so far is saved (Ask waits on it, so
 * the agent reads Carl's words before his request). */
export function voiceTranscriptMirror(b: BoxVoice, convId: string, post: Post = boxPost, sessionId: string | null = null) {
  const id = convId;
  let chain: Promise<unknown> = Promise.resolve();
  const push = (m: ChatMessage): Promise<unknown> => {
    const call = m.toolCalls?.[0];
    // A tool call's text is only its marker (for an older box, which shows it as a notice).
    const text = String(m.content ?? "").trim() || (call ? call.name : "");
    if (!text) return chain;
    // Carl's line shows at once under the id the box writes it with (the box is its only writer). The voice's own
    // lines come with the log: the box may keep one out of the thread (an Ask's "on it"), so none is shown early.
    const clientId = newClientId();
    if (!m.system && !call && m.role === "user") boxOutgoingLine(id, clientId, text, "user");
    chain = chain.then(async () => {
      // Images Carl sent in the chat while voice was on: saved with his line on the box.
      const images = (m.attachments ?? [])
        .map((a) => /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(a.imageDataUrl ?? ""))
        .filter((x): x is RegExpExecArray => !!x)
        .slice(0, 5)
        .map((x) => ({ mime: x[1]!, dataBase64: x[2]! }));
      await post(b.link, "/api/v1/voice/transcript", {
        convId: id,
        device: "laptop",
        ...(sessionId ? { sessionId } : {}),
        role: m.role === "user" ? "user" : "assistant",
        text,
        clientId,
        ...(m.system || call ? { system: true } : {}),
        ...(call ? { tool: { name: call.name, args: call.input ?? {}, result: call.result ?? "" } } : {}),
        ...(images.length ? { images } : {}),
      });
    });
    return chain;
  };
  return { push, id: () => id, done: () => chain };
}
