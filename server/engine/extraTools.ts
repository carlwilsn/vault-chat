// Tool bodies that are not about the conversation itself: PdfRead (page
// ranges, never the whole document by default), WebSearch (OpenRouter's web
// plugin on a cheap model) and detached jobs (StartJob / JobStatus).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// ---- PdfRead ----
const PDF_DEFAULT_PAGES = "1-3";
const PDF_DEFAULT_CHARS = 12_000;
const PDF_MAX_CHARS = 40_000;

export async function pdfRead(vault: string, a: { path?: string; pages?: string; maxChars?: number }): Promise<string> {
  const raw = String(a?.path ?? "").trim();
  if (!raw) return "PdfRead needs a path.";
  const path = isAbsolute(raw) ? raw : resolve(vault, raw);
  if (!existsSync(path)) return `No such file: ${path}`;
  const { extractPdfText } = await import("../../src/tools");
  const pages = String(a?.pages ?? "").trim() || PDF_DEFAULT_PAGES;
  const cap = Math.max(500, Math.min(Number(a?.maxChars) || PDF_DEFAULT_CHARS, PDF_MAX_CHARS));
  let text: string;
  try {
    text = await extractPdfText(path, pages);
  } catch (e) {
    return `PDF extraction failed: ${(e as Error).message}`;
  }
  const m = /\] (\d+) page\(s\)/.exec(text);
  const total = m ? Number(m[1]) : null;
  let out = text.length > cap ? text.slice(0, cap) + `\n…[cut at ${cap} chars of ${text.length}; ask for fewer pages or a larger maxChars]` : text;
  if (!a?.pages && total && total > 3) out += `\n\n(${total} pages in total; this shows pages ${PDF_DEFAULT_PAGES}. Pass pages, e.g. "4-8", for more.)`;
  return out;
}

// ---- WebSearch ----
export async function webSearch(query: string, apiKey: string | null, model: string): Promise<string> {
  const q = String(query ?? "").trim();
  if (!q) return "WebSearch needs a query.";
  if (!apiKey) return "WebSearch unavailable: no OpenRouter key.";
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        plugins: [{ id: "web", max_results: 5 }],
        messages: [
          { role: "system", content: "Answer the query from the web results. Be concise and factual. End with a Sources list of the URLs you used." },
          { role: "user", content: q },
        ],
        max_tokens: 1200,
      }),
    });
    if (!r.ok) return `WebSearch failed: HTTP ${r.status}`;
    const j: any = await r.json();
    const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
    const ann: any[] = j?.choices?.[0]?.message?.annotations ?? [];
    const urls = ann.map((x) => x?.url_citation?.url).filter((u: unknown) => typeof u === "string");
    const extra = urls.length && !urls.every((u: string) => text.includes(u)) ? `\n\nSources:\n${[...new Set(urls)].map((u) => `- ${u}`).join("\n")}` : "";
    return (text || "(no answer)") + extra;
  } catch (e) {
    return `WebSearch failed: ${(e as Error).message}`;
  }
}

// ---- Detached jobs ----
// A plain `&`, setsid or tmux inside the agent's shell dies with the turn
// (bubblewrap --die-with-parent), and the user's systemd bus is denied to the
// agent (it would escape the sandbox). So the SERVER starts the job:
// `systemd-run --user` (survives turns and server restarts) wrapping
// `codex sandbox` under the same `vc` permission profile (still no key store).
export type JobEnv = { codexBin: string; jobsHome: string; logDir: string };

const unitOf = (id: string) => `vc-job-${id}`;

export function startJob(env: JobEnv, cwd: string, a: { command?: string; name?: string }): string {
  const cmd = String(a?.command ?? "").trim();
  if (!cmd) return "StartJob needs a command.";
  if (process.platform !== "linux") return "StartJob needs Linux (systemd + bubblewrap).";
  const id = `${String(a?.name ?? "job").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "job"}-${Date.now().toString(36)}`;
  mkdirSync(env.logDir, { recursive: true });
  const log = join(env.logDir, `${id}.log`);
  const shell = `(${cmd}) > ${JSON.stringify(log)} 2>&1; echo "[exit $?]" >> ${JSON.stringify(log)}`;
  const r = spawnSync(
    "systemd-run",
    ["--user", "--quiet", "--collect", `--unit=${unitOf(id)}`, `--working-directory=${cwd}`, "-E", `CODEX_HOME=${env.jobsHome}`, env.codexBin, "sandbox", "--", "sh", "-c", shell],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (r.status !== 0) return `StartJob failed: ${(r.stderr || r.stdout || r.error?.message || "").trim().slice(0, 400)}`;
  return `Started job ${id} (survives this turn and restarts). Output: ${log}. Check it with JobStatus{id:"${id}"}; schedule a wake to come back to it.`;
}

export function jobStatus(env: JobEnv, a: { id?: string; tail?: number }): string {
  const id = String(a?.id ?? "").trim();
  if (!/^[a-z0-9-]+$/.test(id)) return "JobStatus needs the job id StartJob returned.";
  const r = spawnSync("systemctl", ["--user", "is-active", unitOf(id)], { encoding: "utf8", timeout: 10_000 });
  const active = (r.stdout || "").trim() || "unknown";
  let tail = "";
  try {
    const lines = readFileSync(join(env.logDir, `${id}.log`), "utf8").split("\n");
    tail = lines.slice(-Math.max(5, Math.min(Number(a?.tail) || 40, 400))).join("\n");
  } catch {
    tail = "(no output yet)";
  }
  const exit = /\[exit (\d+)\]\s*$/.exec(tail.trim());
  const state = exit ? `finished (exit ${exit[1]})` : active === "active" ? "running" : active;
  return `Job ${id}: ${state}\n--- last output ---\n${tail}`;
}
