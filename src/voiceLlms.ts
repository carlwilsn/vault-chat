// The voice agent's models, as ElevenLabs runs them. What each can take (an
// image, a document) and how it reasons come from ElevenLabs' own list
// (GET /v1/convai/llm/list), fetched once and cached a day — never guessed
// from the name (the old rule was "only Gemini sees PDFs").

/** The voice model when Carl has not picked one (ElevenLabs' recommended start). */
export const DEFAULT_VOICE_LLM = "gpt-6-luna";

/** The voice models Settings offers (ElevenLabs Agents ids). */
export const VOICE_LLMS: { id: string; label: string }[] = [
  { id: "gpt-6-luna", label: "GPT-6 Luna" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "glm-52", label: "GLM-5.2" },
];

/** Ids stored by older versions → the nearest current one (an explicit choice is kept). */
const OLD_IDS: Record<string, string> = {
  // The old default, never a real pick: it becomes the new default.
  "gemini-2.5-flash": DEFAULT_VOICE_LLM,
  "claude-sonnet-4-5@20250929": "claude-sonnet-4-6",
  "claude-sonnet-4@20250514": "claude-sonnet-4-6",
  "claude-3-7-sonnet": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
};

const KNOWN = new Set(VOICE_LLMS.map((m) => m.id));

/** A stored voice model as one ElevenLabs runs now: kept, mapped from an old id, else the default. */
export function normalizeVoiceLlm(stored: string | null | undefined): string {
  if (!stored) return DEFAULT_VOICE_LLM;
  if (KNOWN.has(stored)) return stored;
  return OLD_IDS[stored] ?? DEFAULT_VOICE_LLM;
}

/** Whether a value names a voice model (current or old). */
export function isVoiceLlm(v: string): boolean {
  return KNOWN.has(v) || v in OLD_IDS;
}

/** One model in ElevenLabs' list. */
export type VoiceLlmInfo = {
  id: string;
  images: boolean | null;
  documents: boolean | null;
  reasoningEfforts: string[];
};

/** The list's rows, whatever the envelope ({llms: [...]}, {models: [...]}, or an array). */
export function parseLlmList(body: unknown): VoiceLlmInfo[] {
  const b = body as Record<string, unknown> | unknown[] | null;
  const rows: unknown[] = Array.isArray(b) ? b : Array.isArray((b as any)?.llms) ? (b as any).llms : Array.isArray((b as any)?.models) ? (b as any).models : [];
  const out: VoiceLlmInfo[] = [];
  for (const r of rows) {
    const o = r as Record<string, unknown>;
    const id = [o.llm, o.id, o.model_id, o.name].find((x) => typeof x === "string") as string | undefined;
    if (!id) continue;
    const flag = (k: string) => (typeof o[k] === "boolean" ? (o[k] as boolean) : null);
    out.push({
      id,
      images: flag("supports_image_input"),
      documents: flag("supports_document_input"),
      reasoningEfforts: Array.isArray(o.available_reasoning_efforts) ? (o.available_reasoning_efforts as unknown[]).filter((x): x is string => typeof x === "string") : [],
    });
  }
  return out;
}

const CACHE_KEY = "vault_chat_elevenlabs_llm_list";
const DAY = 24 * 3600_000;

/** ElevenLabs' model list (cached a day). Null when it can't be had (no key, offline). */
export async function voiceLlmList(apiKey: string | null | undefined, f: typeof fetch = fetch, now = Date.now()): Promise<VoiceLlmInfo[] | null> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw) as { at: number; list: VoiceLlmInfo[] };
      if (now - c.at < DAY && Array.isArray(c.list) && c.list.length) return c.list;
    }
  } catch {
    /* refetch */
  }
  if (!apiKey) return null;
  try {
    const r = await f("https://api.elevenlabs.io/v1/convai/llm/list", { headers: { "xi-api-key": apiKey } });
    if (!r.ok) return null;
    const list = parseLlmList(await r.json());
    if (!list.length) return null;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, list }));
    } catch {
      /* no storage */
    }
    return list;
  } catch {
    return null;
  }
}

/** The model's row, or null. */
export function llmInfo(list: VoiceLlmInfo[] | null, id: string): VoiceLlmInfo | null {
  return list?.find((m) => m.id === id) ?? null;
}

/** The least reasoning a voice reply needs: "none" when offered, else the lowest offered; null when the model takes none. */
export function reasoningEffortFor(info: VoiceLlmInfo | null): string | null {
  const offered = info?.reasoningEfforts ?? [];
  if (!offered.length) return null;
  for (const e of ["none", "minimal", "low", "medium", "high"]) if (offered.includes(e)) return e;
  return offered[0]!;
}
