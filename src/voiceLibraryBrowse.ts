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
 *  then selected. A refusal selects nothing and comes back as one line. */
export async function pickLibraryVoice(
  key: string,
  v: SharedVoice,
  owned: ReadonlySet<string>,
  f: typeof fetch = fetch,
): Promise<{ voiceId: string; added: boolean } | { error: string }> {
  if (owned.has(v.voice_id) || v.is_added_by_user) {
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
