// Does the model picked for a role do everything that role needs? Settings →
// Models runs this the moment a model is picked and shows one quiet line under
// the picker: passed, or what's missing.
//
// Free first: OpenRouter's public catalog says whether a model takes tools,
// images and files. Only a model the catalog doesn't know gets a short real
// test (one tiny request with an image and a tool — a fraction of a cent), and
// the result is remembered, so it runs once per model.

export type Need = "tools" | "images" | "pdf";
export type Caps = Partial<Record<Need, boolean>>;
export type Check =
  | { state: "checking" }
  | { state: "passed" }
  | { state: "missing"; missing: Need[] }
  | { state: "unknown"; why: string };

/** What each role needs. Chat sees images itself (PDFs it reads with its PDF
 *  tool); Background only runs tools; Voice must see both the PDF on screen
 *  and the images the user shows it. */
export const ROLE_NEEDS: Record<"chat" | "background" | "voice", Need[]> = {
  chat: ["tools", "images"],
  background: ["tools"],
  voice: ["images", "pdf"],
};

export const NEED_LABEL: Record<Need, string> = { tools: "use tools", images: "see images", pdf: "see PDFs" };

const CATALOG_CACHE = "vault_chat_model_caps";
const TESTED = "vault_chat_model_caps_learned";
const TTL_MS = 24 * 60 * 60 * 1000;

type OrModel = { id: string; architecture?: { input_modalities?: string[] }; supported_parameters?: string[] };

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
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
      for (const m of json.data) {
        const inMods = m.architecture?.input_modalities ?? [];
        models[m.id] = {
          tools: (m.supported_parameters ?? []).includes("tools"),
          images: inMods.includes("image"),
          pdf: inMods.includes("file"),
        };
      }
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

function verdict(caps: Caps, needs: Need[]): Check {
  const missing = needs.filter((n) => caps[n] !== true);
  return missing.length ? { state: "missing", missing } : { state: "passed" };
}

// A 1×1 PNG: enough to tell whether the model accepts an image at all.
const DOT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The short real test: one request with an image and one tool the model must
 *  call. A rejected image or no tool call is a "no". */
async function probe(id: string, key: string): Promise<Caps> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "vault-chat model check" },
    body: JSON.stringify({
      model: id,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Call the ok tool with the main colour of this image." },
            { type: "image_url", image_url: { url: DOT_PNG } },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "ok", description: "Report the colour.", parameters: { type: "object", properties: { colour: { type: "string" } } } },
        },
      ],
      tool_choice: "required",
    }),
  });
  if (res.ok) {
    const j = (await res.json()) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
    return { images: true, tools: !!j.choices?.[0]?.message?.tool_calls?.length };
  }
  // An image complaint means no images; a tool complaint, no tools (OpenRouter
  // says "No endpoints found that support image input" / "… tool use").
  const text = (await res.text()).toLowerCase();
  const noImages = /image|vision|modalit/.test(text);
  const noTools = /tool/.test(text);
  if (!noImages && !noTools) throw new Error(res.status === 404 ? "OpenRouter doesn't run this model" : `test failed (${res.status})`);
  if (noImages && !noTools) {
    // It refused the image before the tool was tried: test tools alone.
    const again = await probeTools(id, key);
    return { images: false, tools: again };
  }
  return { images: !noImages, tools: !noTools };
}

async function probeTools(id: string, key: string): Promise<boolean> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "vault-chat model check" },
    body: JSON.stringify({
      model: id,
      max_tokens: 64,
      messages: [{ role: "user", content: "Call the ok tool with the colour red." }],
      tools: [{ type: "function", function: { name: "ok", description: "Report the colour.", parameters: { type: "object", properties: { colour: { type: "string" } } } } }],
      tool_choice: "required",
    }),
  });
  if (!res.ok) return false;
  const j = (await res.json()) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
  return !!j.choices?.[0]?.message?.tool_calls?.length;
}

/** Check an OpenRouter model for a role. `key` allows the short test for a
 *  model the catalog doesn't know. */
export async function checkModel(role: "chat" | "background", id: string, key?: string): Promise<Check> {
  const needs = ROLE_NEEDS[role];
  const tested = readJson<Record<string, Caps>>(TESTED) ?? {};
  const t = lookup(tested, id);
  if (t && needs.every((n) => t[n] !== undefined)) return verdict(t, needs);
  const c = lookup(await catalogCaps(), id);
  if (c) return verdict(c, needs);
  if (!key) return { state: "unknown", why: "add an OpenRouter key to test it" };
  try {
    const caps = { ...t, ...(await probe(id, key)) };
    try {
      localStorage.setItem(TESTED, JSON.stringify({ ...tested, [id]: caps }));
    } catch {
      /* tested again next time */
    }
    return verdict(caps, needs);
  } catch (e) {
    return { state: "unknown", why: e instanceof Error ? e.message : String(e) };
  }
}

/** The voice agent runs on ElevenLabs, not OpenRouter, so its check is what
 *  vault-chat's voice code can hand that model: only Gemini gets the open PDF
 *  itself (every page, diagrams included); the others get only its text,
 *  through a tool. All of them take the images the user marks on screen. */
export function checkVoiceModel(llm: string): Check {
  return verdict({ images: true, pdf: llm.toLowerCase().startsWith("gemini") }, ROLE_NEEDS.voice);
}
