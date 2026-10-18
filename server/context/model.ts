// A small OpenRouter Responses-API client (non-streaming) for the recap and the
// verifier, plus the model catalog. Stateless: callers pass the whole input.
import { ctxConfig } from "./config";

export type ResponsesInputItem = Record<string, unknown>;

export type ResponsesResult = {
  id: string;
  output: any[];
  /** Concatenated output_text of the message items. */
  text: string;
  functionCalls: { callId: string; name: string; arguments: string }[];
  /** OpenRouter's usage.cost; null when absent. */
  costUsd: number | null;
};

export async function callResponses(req: {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[] | string;
  tools?: { type: "function"; name: string; description: string; parameters: Record<string, unknown> }[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): Promise<ResponsesResult> {
  const cfg = ctxConfig();
  const key = cfg.apiKey();
  if (!key) throw new Error("no OpenRouter key (api.openrouter) in the key store");
  const res = await cfg.fetch(`${cfg.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: req.model,
      instructions: req.instructions,
      input: req.input,
      tools: req.tools,
      max_output_tokens: req.maxOutputTokens ?? 4_000,
      stream: false,
    }),
    signal: req.signal,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }
  const j: any = await res.json();
  const output: any[] = Array.isArray(j.output) ? j.output : [];
  let text = "";
  const functionCalls: ResponsesResult["functionCalls"] = [];
  for (const it of output) {
    if (it?.type === "message" && Array.isArray(it.content)) {
      for (const c of it.content) if (c?.type === "output_text" && typeof c.text === "string") text += c.text;
    } else if (it?.type === "function_call") {
      functionCalls.push({ callId: String(it.call_id ?? it.id ?? ""), name: String(it.name), arguments: String(it.arguments ?? "{}") });
    }
  }
  if (!text && typeof j.output_text === "string") text = j.output_text;
  const cost = j.usage?.cost;
  return { id: String(j.id ?? ""), output, text, functionCalls, costUsd: typeof cost === "number" ? cost : null };
}

/** A one-shot call (src/complete.ts): one user message with its images, the agent's
 * model or (fast) the recap model. No tools, no memory. */
export async function completeOnce(req: { instructions: string; text: string; images?: string[]; fast?: boolean; maxOutputTokens?: number }): Promise<string> {
  const cfg = ctxConfig();
  const content: Record<string, unknown>[] = [{ type: "input_text", text: String(req.text ?? "") }];
  for (const u of (req.images ?? []).slice(0, 8)) if (typeof u === "string" && u.startsWith("data:image/")) content.push({ type: "input_image", image_url: u, detail: "auto" });
  const r = await callResponses({
    model: req.fast ? cfg.recapModel : cfg.agentModel,
    instructions: String(req.instructions ?? ""),
    input: [{ role: "user", content }],
    maxOutputTokens: Math.max(64, Math.min(Number(req.maxOutputTokens) || 8_000, 16_000)),
  });
  return r.text;
}

// ---- catalog (context windows) ----

const windows = new Map<string, number>();
export const FALLBACK_WINDOW = 258_400; // a conservative default window

/** Fetch OpenRouter's model list once and remember each model's context_length. */
export async function loadCatalog(): Promise<Map<string, number>> {
  const cfg = ctxConfig();
  const res = await cfg.fetch(`${cfg.baseUrl}/models`);
  if (!res.ok) throw new Error(`OpenRouter /models ${res.status}`);
  const j: any = await res.json();
  for (const m of Array.isArray(j?.data) ? j.data : []) {
    const n = Number(m?.context_length ?? m?.top_provider?.context_length);
    if (typeof m?.id === "string" && n > 0) windows.set(m.id, n);
  }
  return windows;
}

/** Remember a window ENGINE already knows (e.g. from its own catalog read). */
export function setModelWindow(model: string, tokens: number): void {
  windows.set(model, tokens);
}

export function modelWindow(model: string): number {
  return windows.get(model) ?? FALLBACK_WINDOW;
}

/** "openai/gpt-6.1-sol" → "openai". */
export function familyOf(model: string): string {
  return (model.split("/")[0] ?? "").toLowerCase();
}
