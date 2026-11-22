import { join } from "node:path";
import { RotatingLog } from "./boxLogs";
import { validPerfBatch } from "../src/laptopPerfProtocol";
import { foldPerfBatch } from "./perfLog";

// One fixed log, no caller-controlled file names or device/session registries.
const log = (stateDir: string) => new RotatingLog(join(stateDir, "logs", "laptop-perf.jsonl"), { maxBytes: 256 * 1024, keep: 1 });
let lastWrite = -Infinity;
export function recordLaptopPerf(stateDir: string, body: unknown, nativeTransport: boolean, now = Date.now()) {
  if (!validPerfBatch(body)) return { status: 400, body: { error: "Invalid performance batch" } };
  if (body.surface !== "browser" && !nativeTransport) return { status: 403, body: { error: "Paired native transport required" } };
  if (now - lastWrite < 1000) return { status: 429, body: { error: "Performance batch rate exceeded" } };
  lastWrite = now;
  const at = new Date(now).toISOString();
  log(stateDir).append({ ...body, at, nativeTransport });
  // The raw log rotates within hours; speed per build is kept apart (server/perfLog.ts, read as box:perf).
  foldPerfBatch(stateDir, body, at);
  return { status: 200, body: { ok: true } };
}
export function readLaptopPerf(stateDir: string) {
  return log(stateDir).since(0, 100);
}
