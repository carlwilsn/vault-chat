// Does the model picked for a role do everything that role needs? Settings →
// Models runs this the moment a model is picked and shows one quiet line under
// the picker: passed, or what's missing.
//
// Free first: OpenRouter's public catalog says whether a model takes tools and
// a tool_choice, images and files, how long its context is and whether it
// reasons. What the catalog can't say — does it call two tools at once, does
// its thinking actually come back, does the reply carry usage and cost — is one
// short real request (a fraction of a cent), made once per model and
// remembered for good.

export type Need = "tools" | "toolChoice" | "images" | "pdf" | "context" | "parallel" | "usage";
export type Caps = Partial<Record<Need | "reasoning", boolean>> & { contextLength?: number; reasoningReturned?: boolean };
export type Check =
  | { state: "checking" }
  | { state: "passed" }
  | { state: "missing"; missing: Need[] }
  | { state: "unknown"; why: string };

/** Below this a long chat or a background run's tool output doesn't fit. */
export const CONTEXT_FLOOR = 64_000;

/** What each role needs. Chat sees images itself (PDFs it reads with its PDF
 *  tool); Background only runs tools; both run long tool loops (context, a
 *  tool_choice, parallel calls) and are costed (usage). Voice must see both the
 *  PDF on screen and the images the user shows it. */
export const ROLE_NEEDS: Record<"chat" | "background" | "voice", Need[]> = {
  chat: ["tools", "toolChoice", "parallel", "images", "context", "usage"],
  background: ["tools", "toolChoice", "parallel", "context", "usage"],
  voice: ["images", "pdf"],
};

export const NEED_LABEL: Record<Need, string> = {
  tools: "use tools",
  toolChoice: "take a tool choice",
  parallel: "call tools in parallel",
  images: "see images",
  pdf: "see PDFs",
  context: `hold a long chat (under ${CONTEXT_FLOOR / 1000}k context)`,
  usage: "report its usage and cost",
};

const CATALOG_CACHE = "vault_chat_model_caps_v2";
const TESTED = "vault_chat_model_caps_probed";
const TTL_MS = 24 * 60 * 60 * 1000;

type OrModel = { id: string; context_length?: number; architecture?: { input_modalities?: string[] }; supported_parameters?: string[] };

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** One catalog row → what it confirms. Parallel calls and usage are never in it. */
export function catalogRowCaps(m: OrModel): Caps {
  const params = m.supported_parameters ?? [];
  const inMods = m.architecture?.input_modalities ?? [];
  const ctx = Number(m.context_length) || 0;
  return {
    tools: params.includes("tools"),
    toolChoice: params.includes("tool_choice"),
    images: inMods.includes("image"),
    pdf: inMods.includes("file"),
    reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
    ...(ctx > 0 ? { contextLength: ctx, context: ctx >= CONTEXT_FLOOR } : {}),
  };
}

let catalogPromise: Promise<Record<string, Caps>> | null = null;
function catalogCaps(): Promise<Record<string, Caps>> {
  const cached = readJson<{ fetchedAt: number; models: Record<string, Caps> }>(CATALOG_CACHE);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return Promise.resolve(cached.models);
  catalogPromise ??= (async () => {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models");
      if (!res.ok) throw new Error(`openrouter ${res.status}`);
      const json = (await res.json()) as { data: OrModel[] };
      const models: Record<string, Caps> = {};
      for (const m of json.data) models[m.id] = catalogRowCaps(m);
      try {
        localStorage.setItem(CATALOG_CACHE, JSON.stringify({ fetchedAt: Date.now(), models }));
      } catch {
        /* a cache */
      }
      return models;
    } catch {
      return cached?.models ?? {};
    } finally {
      catalogPromise = null;
    }
  })();
  return catalogPromise;
}

/** OpenRouter's "vendor/model", or a bare id, which matches "<any>/<id>". */
function lookup<T>(map: Record<string, T>, id: string): T | undefined {
  if (map[id]) return map[id];
  const k = Object.keys(map).find((x) => x.endsWith("/" + id));
  return k ? map[k] : undefined;
}

export function verdict(caps: Caps, needs: Need[]): Check {
  const missing = needs.filter((n) => caps[n] === false);
  if (missing.length) return { state: "missing", missing };
  const open = needs.filter((n) => caps[n] === undefined);
  if (open.length) return { state: "unknown", why: `couldn't confirm it can ${open.map((n) => NEED_LABEL[n]).join(" or ")}` };
  return { state: "passed" };
}

// A 1×1 PNG: enough to tell whether the model accepts an image at all.
const DOT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const PROBE_TOOLS = ["vc_check_a", "vc_check_b"] as const;

/** The one real request: two tools the model is asked to call together
 *  (tool_choice "auto" with a plain instruction — "required" is refused by
 *  some reasoning models, which then read as "no tools"), with usage
 *  accounting on, and an image only when the catalog doesn't know the model. */
async function probe(id: string, key: string, known: Caps | undefined): Promise<Caps> {
  const withImage = !known;
  const tool = (name: string) => ({
    type: "function",
    function: { name, description: `Report check ${name.slice(-1).toUpperCase()}.`, parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
  });
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "vault-chat model check" },
    body: JSON.stringify({
      model: id,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "This is an automated capability check. Call BOTH tools, vc_check_a and vc_check_b, each with ok=true, in this one reply (two tool calls at once). Do not write any text." },
            ...(withImage ? [{ type: "image_url", image_url: { url: DOT_PNG } }] : []),
          ],
        },
      ],
      tools: PROBE_TOOLS.map(tool),
      tool_choice: "auto",
      usage: { include: true },
      ...(known?.reasoning ? { reasoning: { effort: "low" } } : {}),
    }),
  });
  if (!res.ok) {
    // OpenRouter says "No endpoints found that support image input" / "… tool use".
    const text = (await res.text()).toLowerCase();
    if (res.status === 404 && !/image|tool/.test(text)) throw new Error("OpenRouter doesn't run this model");
    const out: Caps = {};
    if (withImage && /image|vision|modalit/.test(text)) out.images = false;
    if (/tool/.test(text)) out.tools = false;
    if (out.images === undefined && out.tools === undefined) throw new Error(`test failed (${res.status})`);
    return out;
  }
  const j = (await res.json()) as {
    choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string } }>; reasoning?: unknown; reasoning_details?: unknown[] } }>;
    usage?: { total_tokens?: number; cost?: number };
  };
  const msg = j.choices?.[0]?.message;
  const names = new Set((msg?.tool_calls ?? []).map((t) => t.function?.name));
  const reasoningReturned = (typeof msg?.reasoning === "string" && !!msg.reasoning.trim()) || (Array.isArray(msg?.reasoning_details) && msg!.reasoning_details!.length > 0);
  return {
    ...(withImage ? { images: true } : {}),
    tools: names.size > 0,
    parallel: PROBE_TOOLS.every((n) => names.has(n)),
    usage: typeof j.usage?.cost === "number" && (j.usage?.total_tokens ?? 0) > 0,
    reasoningReturned,
  };
}

/** Everything known about a model: the catalog, then the remembered probe. */
export async function modelCaps(id: string, key?: string): Promise<{ caps: Caps; why?: string }> {
  const tested = readJson<Record<string, Caps>>(TESTED) ?? {};
  const cat = lookup(await catalogCaps(), id);
  const t = lookup(tested, id);
  if (t) return { caps: { ...cat, ...t } };
  if (!key) return { caps: { ...cat }, why: "add an OpenRouter key to test it" };
  try {
    const p = await probe(id, key, cat);
    try {
      localStorage.setItem(TESTED, JSON.stringify({ ...tested, [id]: p }));
    } catch {
      /* tested again next time */
    }
    return { caps: { ...cat, ...p } };
  } catch (e) {
    return { caps: { ...cat }, why: e instanceof Error ? e.message : String(e) };
  }
}

/** Check an OpenRouter model for a role. `key` allows the one real request. */
export async function checkModel(role: "chat" | "background", id: string, key?: string): Promise<Check> {
  const { caps, why } = await modelCaps(id, key);
  const v = verdict(caps, ROLE_NEEDS[role]);
  return v.state === "unknown" && why ? { state: "unknown", why } : v;
}

/** The voice agent runs on ElevenLabs, not OpenRouter, so its check is what
 *  vault-chat's voice code can hand that model: only Gemini gets the open PDF
 *  itself (every page, diagrams included); the others get only its text,
 *  through a tool. All of them take the images the user marks on screen. */
export function checkVoiceModel(llm: string): Check {
  return verdict({ images: true, pdf: llm.toLowerCase().startsWith("gemini") }, ROLE_NEEDS.voice);
}
