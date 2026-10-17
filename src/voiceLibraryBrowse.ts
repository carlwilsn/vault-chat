// The ElevenLabs voice library (GET /v1/shared-voices), browsed from Settings →
// Voice: English voices for conversation, the most used lately first, and a
// short "Recommended" list on top. Picking one adds it to the account
// (POST /v1/voices/add/{public_owner_id}/{voice_id}) and selects it like any
// voice: the id lands in vault_chat_elevenlabs_voice, which the local agent's
// session override and the box's voice session (voiceBox.ts `voice` param) read.

const API = "https://api.elevenlabs.io";
export const VOICE_STORAGE = "vault_chat_elevenlabs_voice";

/** One voice as /v1/shared-voices lists it (the fields this picker reads). */
export type SharedVoice = {
  voice_id: string;
  public_owner_id: string;
  name: string;
  description?: string | null;
  gender?: string | null;
  age?: string | null;
  accent?: string | null;
  use_case?: string | null;
  preview_url?: string | null;
  featured?: boolean;
  is_added_by_user?: boolean | null;
};

export type LibraryQuery = {
  page?: number;
  search?: string;
  /** Every use case, not only conversational. */
  anyUse?: boolean;
  featured?: boolean;
  pageSize?: number;
};

export const PAGE_SIZE = 30;
export const RECOMMENDED = 8;

/** The list's URL. English, conversational unless `anyUse`, sorted by
 *  `trending` (ElevenLabs' sort on recent use; the documented sorts are
 *  created_date, usage_character_count_1y, trending, cloned_by_count). */
export function sharedVoicesUrl(q: LibraryQuery = {}): string {
  const p = new URLSearchParams();
  p.set("page_size", String(q.pageSize ?? PAGE_SIZE));
  p.set("page", String(q.page ?? 0));
  p.set("language", "en");
  if (!q.anyUse) p.set("use_cases", "conversational");
  p.set("sort", "trending");
  if (q.featured) p.set("featured", "true");
  const s = q.search?.trim();
  if (s) p.set("search", s);
  return `${API}/v1/shared-voices?${p}`;
}

export async function fetchSharedVoices(
  key: string,
  q: LibraryQuery = {},
  f: typeof fetch = fetch,
): Promise<{ voices: SharedVoice[]; hasMore: boolean }> {
  const res = await f(sharedVoicesUrl(q), { headers: { "xi-api-key": key } });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
  const j = (await res.json()) as { voices?: SharedVoice[]; has_more?: boolean };
  return { voices: Array.isArray(j.voices) ? j.voices : [], hasMore: !!j.has_more };
}

/** The "best ones": ElevenLabs' featured English conversational voices,
 *  most trending first; when it features fewer than RECOMMENDED, the top
 *  trending ones fill the rest. */
export async function recommendedVoices(key: string, f: typeof fetch = fetch): Promise<SharedVoice[]> {
  const featured = await fetchSharedVoices(key, { featured: true, pageSize: RECOMMENDED }, f).catch(() => ({ voices: [] as SharedVoice[] }));
  const out = featured.voices.slice(0, RECOMMENDED);
  if (out.length < RECOMMENDED) {
    const top = await fetchSharedVoices(key, { pageSize: RECOMMENDED * 2 }, f);
    for (const v of top.voices) {
      if (out.length >= RECOMMENDED) break;
      if (!out.some((o) => o.voice_id === v.voice_id)) out.push(v);
    }
  }
  return out;
}

/** gender · age · accent, as one quiet line. */
export const describeShared = (v: SharedVoice) =>
  [v.gender, v.age?.replace(/_/g, " "), v.accent].filter(Boolean).join(" · ");

/** The plain line for a refused add: the plan's voice limit, or the error. */
export function addErrorLine(status: number, body: string): string {
  let detail: unknown = body;
  try {
    detail = (JSON.parse(body) as { detail?: unknown }).detail ?? body;
  } catch {
    /* not JSON */
  }
  const d = detail as { status?: string; message?: string } | string;
  const code = typeof d === "object" && d ? String(d.status ?? "") : "";
  const msg = typeof d === "string" ? d : String(d?.message ?? "");
  if (/limit/i.test(code) || /voice.*(limit|maximum)|(limit|maximum).*voice/i.test(msg)) {
    // "…maximum amount of custom voices (10 / 10)…" → 10
    const n = /\(\s*\d+\s*\/\s*(\d+)\s*\)/.exec(msg)?.[1] ?? /(\d+)\s+(?:custom|library)?\s*voices/i.exec(msg)?.[1];
    return n
      ? `Your ElevenLabs plan holds ${n} library voices — remove one on elevenlabs.io`
      : "Your ElevenLabs plan's library voices are full — remove one on elevenlabs.io";
  }
  return `ElevenLabs ${status}${msg ? `: ${msg}` : ""}`;
}

/** Select a voice: the one place its id is stored (the session override and
 *  the box's `voice` param read it). */
export function selectVoice(id: string): void {
  localStorage.setItem(VOICE_STORAGE, id);
}

/** Pick a library voice: already in the account → just selected; else added,
 *  then selected. A refusal, or a voice the agent can't speak with
 *  (checkVoiceFits), selects nothing and comes back as one line. */
export async function pickLibraryVoice(
  key: string,
  v: SharedVoice,
  owned: ReadonlySet<string>,
  f: typeof fetch = fetch,
): Promise<{ voiceId: string; added: boolean } | { error: string }> {
  if (owned.has(v.voice_id) || v.is_added_by_user) {
    // A voice the agent can't speak with is not selected (one plain line why).
    const unfit = await checkVoiceFits(key, v.voice_id, f);
    if (unfit) return { error: unfit };
    unhideVoice(v.voice_id);
    selectVoice(v.voice_id);
    return { voiceId: v.voice_id, added: false };
  }
  let res: Response;
  try {
    res = await f(`${API}/v1/voices/add/${encodeURIComponent(v.public_owner_id)}/${encodeURIComponent(v.voice_id)}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ new_name: v.name }),
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { error: addErrorLine(res.status, await res.text().catch(() => "")) };
  const j = (await res.json().catch(() => ({}))) as { voice_id?: string };
  const id = typeof j.voice_id === "string" && j.voice_id ? j.voice_id : v.voice_id;
  // A voice added from the library shows by default.
  unhideVoice(id);
  // Added, but the agent can't speak with it: in the account, not selected.
  const unfit = await checkVoiceFits(key, id, f);
  if (unfit) return { error: unfit };
  selectVoice(id);
  return { voiceId: id, added: true };
}

// ---- Hidden voices -----------------------------------------------------------
// Carl's request: the dropdown shows only the voice he has selected (his Brian;
// the account holds two, so everything is by voice_id, never by name) plus any
// voice added later. No UI for it: the first time the account's list loads
// with this version, the ids of every voice but the selected one are stored as
// hidden, once (an install that already has the list is left alone). A voice
// id not in that snapshot shows; the selected voice always shows. Premade
// ElevenLabs voices can't be deleted from an account, hence a local list.

export const HIDDEN_STORAGE = "vault_chat_elevenlabs_hidden_voices";

export function readHidden(): Set<string> {
  try {
    const a = JSON.parse(localStorage.getItem(HIDDEN_STORAGE) ?? "[]");
    return new Set(Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeHidden(s: Set<string>): Set<string> {
  localStorage.setItem(HIDDEN_STORAGE, JSON.stringify([...s].sort()));
  return s;
}

/** The one-time snapshot: with no hidden list yet, hide every account voice
 *  but the selected one. Returns the hidden set (unchanged when it existed). */
export function snapshotHidden(accountIds: readonly string[], selected: string): Set<string> {
  if (localStorage.getItem(HIDDEN_STORAGE) !== null) return readHidden();
  return writeHidden(new Set(accountIds.filter((id) => id !== selected)));
}

/** A voice picked from the library shows, even one hidden by the snapshot. */
export function unhideVoice(id: string): Set<string> {
  const s = readHidden();
  if (!s.delete(id)) return s;
  return writeHidden(s);
}

/** The voices the dropdown shows: not hidden, and always the selected one. */
export function visibleVoices<T extends { voice_id: string }>(voices: readonly T[], hidden: ReadonlySet<string>, selected: string): T[] {
  return voices.filter((v) => v.voice_id === selected || !hidden.has(v.voice_id));
}

type Labeled = { voice_id: string; name: string; labels?: Record<string, string> };

/** A row's hint: accent, gender, description; when two shown voices share a
 *  name and those still match, the id's head tells them apart. */
export function voiceHints<T extends Labeled>(voices: readonly T[]): Map<string, string> {
  const base = (v: T) =>
    [v.labels?.accent, v.labels?.gender, v.labels?.description ?? v.labels?.descriptive].filter(Boolean).join(", ");
  const out = new Map<string, string>();
  for (const v of voices) {
    const twins = voices.filter((o) => o.voice_id !== v.voice_id && o.name === v.name);
    const h = base(v);
    out.set(v.voice_id, twins.some((o) => base(o) === h) ? [h, v.voice_id.slice(0, 6)].filter(Boolean).join(" · ") : h);
  }
  return out;
}

// ---- Does a voice work with the voice agent? --------------------------------
// The agent speaks English with eleven_flash_v2 (an English agent must use
// flash or turbo v2: buildAgentCreateBody). Premade, cloned and designed v2
// voices run on any model; a professional clone runs only on the models it was
// trained for (high_quality_base_model_ids / fine_tuning.state), and a voice
// made for Eleven v3 runs only there. A voice verified only in other languages
// is not the English agent's. Fields from GET /v1/voices and /v1/voices/{id}.

/** The agent's TTS model (src/voice-elevenlabs buildAgentCreateBody). */
export const AGENT_TTS_MODEL = "eleven_flash_v2";
/** The ids ElevenLabs uses for the models an English agent may run. */
const AGENT_MODELS = new Set(["eleven_flash_v2", "eleven_v2_flash", "eleven_turbo_v2", "eleven_v2_turbo"]);

export type VoiceDetail = {
  voice_id: string;
  name?: string;
  category?: string | null;
  high_quality_base_model_ids?: string[] | null;
  fine_tuning?: { state?: Record<string, string> | null } | null;
  verified_languages?: { language?: string | null; model_id?: string | null }[] | null;
};

const LANG: Record<string, string> = { es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", pl: "Polish", hi: "Hindi", ja: "Japanese", zh: "Chinese", ko: "Korean", nl: "Dutch", ru: "Russian", ar: "Arabic", tr: "Turkish", sv: "Swedish" };

/** Why this voice can't be the voice agent's, in one plain line — or null (it can). */
export function voiceUnfitReason(v: VoiceDetail): string | null {
  const langs = (v.verified_languages ?? []).map((l) => String(l?.language ?? "").toLowerCase()).filter(Boolean);
  if (langs.length && !langs.some((l) => l === "en" || l.startsWith("en-") || l === "english")) {
    const names = [...new Set(langs.map((l) => LANG[l.slice(0, 2)] ?? l))].join(", ");
    return `Speaks ${names} only — the voice agent speaks English`;
  }
  const hq = Array.isArray(v.high_quality_base_model_ids) ? v.high_quality_base_model_ids : [];
  const ft = v.fine_tuning?.state ?? {};
  const trained = hq.some((m) => AGENT_MODELS.has(m)) || Object.entries(ft).some(([m, s]) => AGENT_MODELS.has(m) && s === "fine_tuned");
  if (trained) return null;
  const cat = String(v.category ?? "");
  const v3Only = hq.length > 0 && hq.every((m) => /v3/.test(m));
  if (v3Only) return "Made for Eleven v3 only — the voice agent runs Flash v2";
  // A professional clone says which models it was trained for; one that names
  // others (and not Flash v2) can't be the agent's. One that says nothing is let through.
  if ((cat === "professional" || cat === "famous") && (hq.length > 0 || Object.keys(ft).length > 0)) return "Not trained for the voice agent's model (Flash v2) yet";
  return null;
}

/** GET /v1/voices/{id} and say whether it can be the agent's voice. A failed
 *  lookup does not block (null): the agent's own update says why at start. */
export async function checkVoiceFits(key: string, id: string, f: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await f(`${API}/v1/voices/${encodeURIComponent(id)}`, { headers: { "xi-api-key": key } });
    if (!res.ok) return null;
    return voiceUnfitReason((await res.json()) as VoiceDetail);
  } catch {
    return null;
  }
}
