/** Installed RecordUI worker, called only inside changeHost's private network/sandbox.
 * Starts the pinned built server, not a supplied URL. Candidate stdout never shares this worker's receipts.
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPage } from "./headless";
import { record, type RecordArgs } from "./recordUI";
import type { ProofSource, UIReceipt } from "./changeProof";
import { killTree } from "./commands/proc";
import { ensureMain } from "./engine/convs";

/** Decode two positions of the actual video. A file suffix, magic bytes or recorder's own JSON is not proof
 * of a playable retained artifact. Chromium is the same existing muted recorder, not another proof engine. */
export async function decodeChangeVideo(artifact: string): Promise<void> {
  const page = await openPage(320, 240);
  try {
    const mime = artifact.endsWith(".mp4") ? "video/mp4" : "video/webm";
    const data = `data:${mime};base64,${readFileSync(artifact).toString("base64")}`;
    const expression = `(async () => {
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
      const loaded = new Promise((resolve, reject) => { v.onloadedmetadata = resolve; v.onerror = () => reject(Error('video decode failed')); });
      v.src = ${JSON.stringify(data)}; await loaded;
      if (!(v.duration > 0) || !v.videoWidth || !v.videoHeight) throw Error('empty recording');
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
      for (const t of [Math.min(.1, v.duration / 4), v.duration * .75]) {
        await new Promise((resolve, reject) => { v.onseeked = resolve; v.onerror = reject; v.currentTime = t; });
        canvas.getContext('2d').drawImage(v, 0, 0, 16, 16); canvas.getContext('2d').getImageData(0, 0, 1, 1);
      }
      return true;
    })()`;
    const r = await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 45_000);
    if (r.exceptionDetails || r.result?.value !== true) throw new Error("Retained video does not decode");
  } finally { await page.close(); }
}

type UIRequest = { source: ProofSource; buildHash: string; snapshot: string; evidence: string; hostDir: string; bwrap: string; surface: "phone" | "board" | "desktop"; ui: Omit<RecordArgs, "url" | "out">; node: string };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, alive: () => boolean): Promise<T> {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error("Candidate process exited before UI readiness");
    try { return await fn(); } catch (e) { last = e; }
    await sleep(200);
  }
  throw new Error(`Candidate readiness timed out: ${String(last)}`);
}

export async function recordChangeUI(requestPath: string): Promise<UIReceipt> {
  const o = JSON.parse(readFileSync(requestPath, "utf8")) as UIRequest;
  const scratch = mkdtempSync(join(tmpdir(), "change-ui-"));
  const candidateData = join(scratch, "candidate");
  mkdirSync(candidateData);
  const vault = join(candidateData, "vault"), state = join(candidateData, "state");
  for (const d of [vault, state]) mkdirSync(d);
  // Real isolated data, never preview fixtures or a model-authored response. UI steps may operate on this
  // dedicated vault via the real app. No live conversation, credentials, main repo or speakers are touched.
  await ensureMain(vault);
  writeFileSync(join(vault, "Proof.md"), "# Change proof\n\nThis isolated vault is served by the pinned candidate.\n");
  const serverEntry = join(o.snapshot, "dist-server", "vault-chat-server.mjs");
  if (!existsSync(serverEntry)) throw new Error("Candidate build:server gate did not produce its server");
  const assertBuild = () => { if (createHash("sha256").update(readFileSync(serverEntry)).digest("hex") !== o.buildHash) throw new Error("Pinned candidate build changed during recording"); };
  assertBuild();
  const children: ChildProcess[] = [];
  const childLogs: string[] = [];
  const start = (argv: string[], env: NodeJS.ProcessEnv): ChildProcess => {
    // Child code gets neither recorder files/evidence nor the worker's pid namespace. It shares only the
    // private network, its own snapshot, its temporary vault and logs captured by this installed worker.
    const wrap = ["--ro-bind", "/", "/", "--unshare-pid", "--die-with-parent", "--proc", "/proc",
      "--tmpfs", o.evidence, "--tmpfs", o.hostDir, "--tmpfs", "/tmp", "--bind", candidateData, candidateData,
      "--ro-bind", o.snapshot, o.snapshot];
    for (const cache of [".vite", ".vite-temp", ".vite-preview-before"]) wrap.push("--tmpfs", join(o.snapshot, "node_modules", cache));
    // Keep pinned tracked files immutable in the nested candidate namespace as in the outer runner.
    const child = spawn(o.bwrap, [...wrap, "--", ...argv], { cwd: o.snapshot, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", d => childLogs.push(String(d)));
    child.stderr!.on("data", d => childLogs.push(String(d)));
    child.on("error", e => childLogs.push(String(e)));
    children.push(child);
    return child;
  };
  const env = { ...process.env, HOME: candidateData, TMPDIR: "/tmp", VC_HOST: "127.0.0.1", VC_PORT: "19001", VC_VOICE_PIPELINE: "off", VC_VOICE_PIPELINE_PORT: "19101",
    VC_VAULT: vault, VC_VAULT_NAME: "proof", VC_STATE_DIR: state, VC_SECRETS_DIR: join(state, "secrets"),
    VC_TOKEN_FILE: join(state, "unused-phone-token"), VC_PUSH_SUBS: join(state, "push.json"), VC_LOCALSTORAGE: join(state, "storage.json"),
    VC_BARE_REPO: join(state, "unused.git"), VC_SYNC: "0", VC_ENGINE: "0", VC_MASTER: "", VC_INIT: "0",
    // The installed reporter node shim is hidden from the candidate; use system toolchain only.
    PATH: (process.env.PATH ?? "").split(":").filter(p => !p.startsWith(o.hostDir)).join(":"),
  };
  try {
    const server = start([o.node, serverEntry], env);
    const health = async () => {
      const r = await fetch("http://127.0.0.1:19001/api/v1/health", { signal: AbortSignal.timeout(2_000) });
      const h = await r.json() as { rev?: string; app?: string; vault?: string };
      if (!r.ok || h.app !== "vault-chat-server" || h.rev !== o.source.head || h.vault !== "proof") throw new Error("Candidate server source/vault provenance does not match");
      return h;
    };
    await waitFor(health, () => server.exitCode === null && server.signalCode === null);
    let url = `http://127.0.0.1:19001/${o.surface === "board" ? "board" : "phone"}`;
    if (o.surface === "desktop") {
      // Existing realbox preview: real candidate frontend + real candidate box. This proves the desktop web
      // surface, NOT actual post-update Tauri health. That remains the paired laptop's release report.
      const preview = start([o.node, join(o.snapshot, "preview", "vite-child.mjs"), "--tree", o.snapshot, "--port", "19002", "--side", "before", "--base", "/before/"], { ...env, VC_REALBOX: "http://127.0.0.1:19001" });
      url = "http://127.0.0.1:19002/before/?scenario=realbox&vault=proof";
      await waitFor(async () => { const r = await fetch(url, { signal: AbortSignal.timeout(2_000) }); if (!r.ok) throw new Error("Candidate preview not ready"); return true; }, () => preview.exitCode === null && preview.signalCode === null);
    }
    // Recorder's Chromium needs writable XDG scratch, not the real read-only home.
    process.env.XDG_CONFIG_HOME = join(scratch, "chromium-config");
    process.env.XDG_CACHE_HOME = join(scratch, "chromium-cache");
    const r = await record(o.snapshot, { ...o.ui, url, out: join(o.evidence, "recording") }, o.evidence, true);
    if (!r.ok) throw new Error(r.error);
    if (r.failed || r.errors.length) throw new Error(`Candidate UI steps failed: ${r.log.join("; ")} ${r.errors.join("; ")}`);
    await health();
    assertBuild();
    await decodeChangeVideo(r.path);
    writeFileSync(join(o.evidence, "recording-meta.json"), JSON.stringify({ source: o.source, buildHash: o.buildHash, surface: o.surface, url, result: r }, null, 2));
    return { head: o.source.head, tree: o.source.tree, artifact: r.path, artifactHash: createHash("sha256").update(readFileSync(r.path)).digest("hex"),
      recorder: "RecordUI", realServer: true, sourceVerified: true, stepsPassed: true, assertions: o.ui.steps?.filter(s => "waitFor" in s).length ?? 0,
      frames: r.frames, bytes: r.bytes, pageErrors: r.errors };
  } catch (e) {
    throw new Error(`${String(e)}\nCandidate output:\n${childLogs.join("").slice(-4000)}`);
  } finally {
    for (const c of children) killTree(c.pid);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Internal installed entry points. No listener, token, public API or serialized acceptance authority. */
export async function changeUICli(mode: string, path: string): Promise<void> {
  try {
    if (mode === "prove-change-ui") process.stdout.write(JSON.stringify(await recordChangeUI(path)));
    else { await decodeChangeVideo(path); process.stdout.write("decoded\n"); }
    process.exit(0);
  } catch (e) { process.stderr.write(String(e) + "\n"); process.exit(1); }
}
