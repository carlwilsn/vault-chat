// Live pages, step 2: the voice lab. A page holding a `tool:voice-lab.*` grant reaches the lab service (127.0.0.1:8871,
// plain HTTP, started outside the app: ~/agent-work/voice-lab) only through the live gateway (server/liveProxy.ts), as
//   /api/v2/lab/<op>   op ∈ engines | tts | stt | voices      (tool names voice-lab.<op>)
// This is a fixed allow-list, not a proxy: one host and port, four operations with their methods, a few query
// parameters, bounded bodies/replies, and only the reply headers the page's UI shows.
import { request as httpRequest } from "node:http";
import { LIVE_LIMITS, toolAllowed } from "../src/liveBridge";

export const LAB_PORT = 8871;
/** Test knob only: the port the fixed host 127.0.0.1 is reached on. Never 8848/8857 (the live app). */
export const labTarget = { port: LAB_PORT };

type Op = { method: "GET" | "POST"; path: string; query: Record<string, RegExp>; bodyBytes: number };
const OPS: Record<string, Op> = {
  engines: { method: "GET", path: "/engines", query: {}, bodyBytes: 0 },
  tts: { method: "POST", path: "/tts", query: { fmt: /^(wav|mp3)$/ }, bodyBytes: 64 * 1024 },
  stt: { method: "POST", path: "/stt", query: { engine: /^[A-Za-z0-9_.-]{1,60}$/ }, bodyBytes: LIVE_LIMITS.requestBytes },
  voices: { method: "GET", path: "/voices", query: {}, bodyBytes: 0 },
};
const LAB_REPLY_HEADERS = ["content-type", "x-time-to-first-audio-ms", "x-total-ms", "x-audio-seconds", "x-rtf"];
const LAB_TIMEOUT_MS = 300_000;
const MAX_CONCURRENT = 2;
let active = 0;

export type LabReply = { status: number; headers: Record<string, string>; body: Buffer };
const err = (status: number, message: string): LabReply => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: message })) });

/** A lab call for `path` (/api/v2/lab/<op>[?query]) from a token holding `caps`; null when the path is not a lab path. */
export async function labCall(caps: readonly string[], method: string, path: string, headers: Record<string, string>, body: Buffer | null): Promise<LabReply | null> {
  const m = /^\/api\/v2\/lab\/([a-z]{1,12})(?:\?(.*))?$/.exec(path);
  if (!m) return null;
  const opName = m[1]!;
  const op = Object.hasOwn(OPS, opName) ? OPS[opName]! : null;
  if (!op) return err(404, "no such lab operation");
  if (!toolAllowed(caps, `voice-lab.${opName}`)) return err(403, `this page was not allowed to use the tool voice-lab.${opName}`);
  // voices is GET (list) or POST (save a clone reference clip); the rest have one method.
  const okMethod = opName === "voices" ? method === "GET" || method === "POST" : method === op.method;
  if (!okMethod) return err(405, `${opName}: ${op.method} only`);
  const bytesMax = opName === "voices" && method === "POST" ? LIVE_LIMITS.requestBytes : op.bodyBytes;
  if ((body?.length ?? 0) > bytesMax) return err(413, "request body too large");
  const q = new URLSearchParams(m[2] ?? "");
  const outQ = new URLSearchParams();
  for (const [k, v] of q) {
    const rule = op.query[k];
    if (!rule || !rule.test(v)) return err(400, `bad or unknown query parameter ${k}`);
    outQ.set(k, v);
  }
  if (opName === "stt" && !outQ.get("engine")) return err(400, "stt needs ?engine=");
  const h: Record<string, string> = {};
  if (headers["content-type"]) h["content-type"] = headers["content-type"];
  if (body) h["content-length"] = String(body.length);
  if (active >= MAX_CONCURRENT) return err(429, "the voice lab is busy; try again in a moment");
  active++;
  const target = `${op.path}${outQ.size ? `?${outQ}` : ""}`;
  try {
    return await new Promise<LabReply>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port: labTarget.port, path: target, method, headers: h, timeout: LAB_TIMEOUT_MS }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > LIVE_LIMITS.responseBytes) {
            req.destroy();
            resolve(err(502, "the voice lab's reply was too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const out: Record<string, string> = {};
          for (const k of LAB_REPLY_HEADERS) if (typeof res.headers[k] === "string") out[k] = res.headers[k] as string;
          resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
        });
        res.on("error", (e) => resolve(err(502, String(e.message))));
      });
      req.on("timeout", () => req.destroy(new Error("the voice lab did not answer in time")));
      req.on("error", (e) => resolve(err(502, `the voice lab is not reachable (${e.message})`)));
      req.end(body ?? undefined);
    });
  } finally {
    active--;
  }
}
