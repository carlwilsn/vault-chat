// Voice in box mode: when the vault runs on a box, voice is the box's — one
// agent, one key place. The box mints the session (GET /api/v1/voice/session:
// its agent, its prompt with its vault index), the vault tools run there
// (POST /api/v1/voice/tool — the box's working copy, its sandbox, its agent),
// and the session's transcript is saved there as a conversation of its own
// (POST /api/v1/voice/transcript). Paths the agent builds from this laptop's
// vault root are sent vault-relative, so they mean the same file on the box.
// Tools that move the user's screen never go there (LOCAL_VOICE_TOOLS).
import { boxGet, boxLinkFor, boxPost, boxOutgoingLine, boxRekey, newClientId, type Link } from "./boxChat";
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

/** The remote runner for one link. */
export function voiceToolVia(link: Link, vault: string, post: Post = boxPost) {
  return async (name: string, args: unknown): Promise<string> => {
    const r = await post(link, "/api/v1/voice/tool", { name, args: relativeArgs(args, vault) });
    if (!r.ok) return `Error: the box did not run ${name} (${r.error ?? "unreachable"}).`;
    return typeof r.data?.result === "string" ? r.data.result : JSON.stringify(r.data ?? {});
  };
}

/** The box `vault` runs on, or null (voice runs here). */
export async function boxVoice(vault: string | null, post: Post = boxPost): Promise<BoxVoice | null> {
  if (!vault) return null;
  const link = await boxLinkFor(vault).catch(() => null);
  if (!link) return null;
  return { link, vault, tool: voiceToolVia(link, vault, post) };
}

/** The remote runner when `vault` runs on a box, else null (tools run here). */
export async function boxVoiceTool(vault: string | null): Promise<((name: string, args: unknown) => Promise<string>) | null> {
  return (await boxVoice(vault))?.tool ?? null;
}

export type BoxVoiceSession = {
  signedUrl: string;
  systemPrompt: string;
  voiceId?: string;
  toolNames: string[];
  vaultRoot?: string;
  dynamicVariables?: Record<string, string>;
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
    if (!s || typeof s.signedUrl !== "string") return { error: "the box sent no signed URL" };
    return { session: { ...s, toolNames: Array.isArray(s.toolNames) ? s.toolNames : [] } };
  } catch (e) {
    const status = (e as { status?: number }).status;
    const msg = String((e as Error)?.message ?? e);
    if (!status) return { unreachable: true, error: msg };
    if (status === 404) return { unsupported: true, error: msg };
    return { error: msg };
  }
}

/** Save a voice session's lines on the box, in order. The first line names
 * the local thread (`localId`); the box answers with its conversation's id and
 * the local thread moves to it (rekeyConversation), so the list shows the
 * box's copy like any box chat. */
export function voiceTranscriptMirror(b: BoxVoice, localId: string, fromConvId: string | null, post: Post = boxPost) {
  let id = localId;
  let chain: Promise<unknown> = Promise.resolve();
  const push = (m: ChatMessage): Promise<unknown> => {
    const text = String(m.content ?? "").trim();
    if (!text) return chain;
    // The line shows at once under the id the box writes it with (the box is its only writer).
    const clientId = newClientId();
    if (!m.system) boxOutgoingLine(id, clientId, text, m.role === "user" ? "user" : "assistant");
    chain = chain.then(async () => {
      // Images Carl sent in the chat while voice was on: saved with his line on the box.
      const images = (m.attachments ?? [])
        .map((a) => /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(a.imageDataUrl ?? ""))
        .filter((x): x is RegExpExecArray => !!x)
        .slice(0, 5)
        .map((x) => ({ mime: x[1]!, dataBase64: x[2]! }));
      const r = await post(b.link, "/api/v1/voice/transcript", {
        convId: id,
        ...(fromConvId && fromConvId !== id ? { fromConvId } : {}),
        role: m.role === "user" ? "user" : "assistant",
        text,
        clientId,
        ...(m.system ? { system: true } : {}),
        ...(images.length ? { images } : {}),
      });
      const next = typeof r.data?.convId === "string" ? r.data.convId : null;
      if (r.ok && next && next !== id) {
        useStore.getState().rekeyConversation(id, next);
        boxRekey(id, next);
        id = next;
      }
    });
    return chain;
  };
  return { push, id: () => id, done: () => chain };
}
