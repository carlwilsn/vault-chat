// Network commands: fetch-a-URL, Tavily search, raw Web Push POST.
import type { CommandFn } from "./registry";

/** lib.rs:2275 html_to_text. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    throw (e as Error).name === "AbortError" ? `request timed out after ${ms / 1000}s` : (e as Error).message;
  } finally {
    clearTimeout(t);
  }
}

export const netCommands: Record<string, CommandFn> = {
  // lib.rs:2299
  http_fetch: async ({ url, maxChars }) => {
    const limit = maxChars ?? 120_000;
    const resp = await fetchWithTimeout(String(url), { headers: { "user-agent": "vault-chat/0.1" }, redirect: "follow" }, 30_000);
    const ct = resp.headers.get("content-type") ?? "";
    const body = await resp.text();
    if (!resp.ok) throw `HTTP ${resp.status} ${resp.statusText}: ${[...body].slice(0, 200).join("")}`;
    const t = body.trimStart();
    const text = ct.includes("html") || t.startsWith("<!") || t.startsWith("<html") ? htmlToText(body) : body;
    const chars = [...text];
    if (chars.length > limit) return `${chars.slice(0, limit).join("")}\n…[truncated; full length ${chars.length} chars]`;
    return text;
  },

  // lib.rs:2339
  tavily_search: async ({ query, apiKey, maxResults, includeAnswer }) => {
    const max = Math.min(maxResults ?? 5, 10);
    const resp = await fetchWithTimeout(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "vault-chat/0.1" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: max,
          include_answer: includeAnswer ?? true,
          search_depth: "basic",
        }),
      },
      30_000,
    );
    const text = await resp.text();
    if (!resp.ok) throw `Tavily HTTP ${resp.status}: ${[...text].slice(0, 400).join("")}`;
    const parsed = JSON.parse(text);
    let out = "";
    if (typeof parsed.answer === "string" && parsed.answer) out += `Answer: ${parsed.answer}\n\n`;
    if (Array.isArray(parsed.results)) {
      parsed.results.forEach((r: any, i: number) => {
        out += `[${i + 1}] ${r.title ?? ""}\n${r.url ?? ""}\n${r.content ?? ""}\n\n`;
      });
    }
    return out ? out.trimEnd() : `(no results)\n${[...text].slice(0, 500).join("")}`;
  },

  // lib.rs:6845 — POST the already-encrypted body, return the status.
  push_post: async ({ endpoint, headers, bodyB64 }) => {
    const h: Record<string, string> = {};
    for (const [k, v] of (headers ?? []) as [string, string][]) h[k] = v;
    const resp = await fetchWithTimeout(String(endpoint), { method: "POST", headers: h, body: Buffer.from(String(bodyB64), "base64") }, 20_000);
    const why = await resp.text().catch(() => "");
    // The push service's reason (Apple: {"reason":"BadJwtToken"} …), never the endpoint (it names the device).
    if (resp.status >= 400) console.warn(`[phone-push] ${new URL(String(endpoint)).origin} answered ${resp.status}${why ? `: ${why.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
    return resp.status;
  },
};
