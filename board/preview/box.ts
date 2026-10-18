// A preview box for the board's WebKit checks: the built server (dist-server, `node server/build.mjs`) on a
// throwaway vault, its inbox seeded through the real send (seed-inbox.ts: a PDF's pages, math, an image, a
// widget). Runs until killed; prints the box's URL and the vault.
//
//   npx tsx board/preview/box.ts [port=7432]
//   VC_BOX=http://127.0.0.1:7432 npm run dev:board      (then the board/preview/*.mjs checks)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Encrypter } from "age-encryption";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = Number(process.argv[2] ?? 7432);
const home = mkdtempSync(join(tmpdir(), "vc-board-box-"));
const vault = join(home, "vault");

const git = (...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=Preview", "-c", "user.email=preview@example.com", ...args], { cwd: vault, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};
mkdirSync(join(vault, "notes"), { recursive: true });
writeFileSync(join(vault, "README.md"), "# Preview vault\n");
writeFileSync(join(vault, ".gitattributes"), "* text=auto eol=lf\n*.jsonl merge=union\n");
git("init", "-q", "-b", "box");
git("add", "-A");
git("commit", "-q", "-m", "init");

// The server boots on a key store; a placeholder value, never a key.
const secrets = join(home, "secrets");
mkdirSync(secrets, { recursive: true });
const pass = "preview-passphrase-not-a-secret";
const e = new Encrypter();
e.setPassphrase(pass);
e.setScryptWorkFactor(10);
writeFileSync(join(secrets, "fallback.key"), pass);
writeFileSync(join(secrets, "secrets.age"), Buffer.from(await e.encrypt(JSON.stringify({ "api.openrouter": "preview-placeholder" }))).toString("base64"));

const bundle = join(ROOT, "dist-server", "vault-chat-server.mjs");
const proc = spawn(process.execPath, [bundle], {
  cwd: dirname(bundle),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    VC_HOST: "127.0.0.1",
    VC_PORT: String(port),
    VC_VAULT: vault,
    VC_BARE_REPO: join(home, "none.git"),
    VC_SECRETS_DIR: secrets,
    VC_LOCALSTORAGE: join(home, "ls.json"),
    VC_PUSH_SUBS: join(home, "subs.json"),
    VC_TOKEN_FILE: join(home, "phone-token"),
    VC_STATE_DIR: join(home, "state"),
    VC_SYNC: "0",
    VC_ENGINE: "0",
  },
});
let out = "";
proc.stdout!.on("data", (d) => (out += d));
proc.stderr!.on("data", (d) => (out += d));
const t0 = Date.now();
while (!out.includes("listening on")) {
  if (proc.exitCode !== null || Date.now() - t0 > 60_000) throw new Error(`the box did not start:\n${out}`);
  await new Promise((r) => setTimeout(r, 100));
}
const base = `http://127.0.0.1:${port}`;
const seed = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "board", "preview", "seed-inbox.ts"), vault, base], { cwd: ROOT, encoding: "utf8" });
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  proc.kill();
  process.exit(1);
}
console.log(JSON.stringify({ box: base, vault, state: join(home, "state"), entries: seed.stdout.trim().split("\n") }));
const stop = () => {
  proc.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
proc.on("exit", () => process.exit(1));
