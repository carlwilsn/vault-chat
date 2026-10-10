// `npm run preview` → http://localhost:1500
//
//   node preview/serve.mjs [--before <dir|git-ref>] [--after <dir|git-ref>] [--port 1500]
//
// Before defaults to this tree. After is optional: a directory (another
// worktree/checkout of vault-chat) or a git ref of this repo, which is
// exported (git archive) into preview/.cache/trees/<ref>/ — read-only, never a
// worktree. Each tree gets its own Vite dev server as a child process with
// cwd = the tree (:1520 before, :1521 after); the harness shell is served here.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, mkdirSync, symlinkSync, statSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const PORT = Number(opt("port", process.env.PREVIEW_PORT ?? 1500));
const PORTS = { before: Number(opt("before-port", 1520)), after: Number(opt("after-port", 1521)) };

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A directory as-is, or a git ref exported into the cache. */
function materialize(spec, label) {
  if (!spec || spec === ".") return { dir: ROOT, label: label === "before" ? `this tree (${sh("git", ["rev-parse", "--short", "HEAD"], ROOT)})` : "this tree" };
  const asDir = resolve(spec);
  if (existsSync(join(asDir, "package.json"))) {
    let rev = "";
    try {
      rev = ` @ ${sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], asDir)} ${sh("git", ["rev-parse", "--short", "HEAD"], asDir)}`;
    } catch {
      /* not a git checkout */
    }
    return { dir: asDir, label: `${asDir}${rev}` };
  }
  // A git ref of this repository.
  const sha = sh("git", ["rev-parse", "--verify", `${spec}^{commit}`], ROOT);
  const dir = join(HERE, ".cache", "trees", `${spec.replace(/[^\w.-]+/g, "_")}-${sha.slice(0, 8)}`);
  if (!existsSync(join(dir, "package.json"))) {
    mkdirSync(dir, { recursive: true });
    console.log(`[preview] exporting ${spec} (${sha.slice(0, 8)}) → ${dir}`);
    execFileSync("sh", ["-c", `git archive ${sha} | tar -x -C "${dir.replace(/\\/g, "/")}"`], { cwd: ROOT, stdio: "inherit" });
  }
  ensureDeps(dir);
  return { dir, label: `${spec} @ ${sha.slice(0, 8)}` };
}

/** node_modules for an exported tree: share this tree's when the lockfiles match. */
function ensureDeps(dir) {
  if (existsSync(join(dir, "node_modules"))) return;
  const same = readFileSync(join(dir, "package-lock.json"), "utf8") === readFileSync(join(ROOT, "package-lock.json"), "utf8");
  if (same) {
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
    console.log(`[preview] ${dir}: lockfile matches, sharing node_modules`);
  } else {
    console.log(`[preview] ${dir}: lockfile differs, running npm ci (one time)…`);
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  }
}

// The big PDF fixture is generated, not committed.
if (!existsSync(join(HERE, "fixtures", "synthetic", "vault", "papers", "attention-survey.pdf")))
  execFileSync(process.execPath, [join(HERE, "fixtures", "synthetic", "make-big-pdf.mjs")], { stdio: "inherit" });

const sides = { before: materialize(opt("before", "."), "before") };
const afterSpec = opt("after", null);
if (afterSpec) sides.after = materialize(afterSpec, "after");

const children = [];
for (const [side, t] of Object.entries(sides)) {
  const child = spawn(process.execPath, [join(HERE, "vite-child.mjs"), "--tree", t.dir, "--port", String(PORTS[side]), "--side", side, "--label", t.label], {
    cwd: t.dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pre = (s) => s.toString().split(/\r?\n/).filter(Boolean).map((l) => `[${side}] ${l}`).join("\n");
  child.stdout.on("data", (d) => console.log(pre(d)));
  child.stderr.on("data", (d) => console.error(pre(d)));
  child.on("exit", (code) => console.error(`[preview] ${side} dev server exited (${code})`));
  children.push(child);
}
const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const config = () => ({
  sides: Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, { url: `http://127.0.0.1:${PORTS[k]}`, label: v.label, tree: v.dir }])),
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/api/config") {
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify(config()));
    }
    if (url.pathname === "/api/scenarios") {
      const r = await fetch(`http://127.0.0.1:${PORTS.before}/__preview/scenarios.json`);
      res.setHeader("content-type", "application/json");
      return void res.end(await r.text());
    }
    if (url.pathname === "/api/bases") {
      const r = await fetch(`http://127.0.0.1:${PORTS.before}/__preview/info`);
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify((await r.json()).bases));
    }
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = resolve(HERE, "shell", "." + p);
    if (!file.startsWith(resolve(HERE, "shell")) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      return void res.end("not found");
    }
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.end(readFileSync(file));
  } catch (e) {
    res.statusCode = 502;
    res.end(String(e?.message ?? e));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`\n  vault-chat preview  →  http://localhost:${PORT}\n`);
  for (const [k, v] of Object.entries(config().sides)) console.log(`  ${k.padEnd(6)} ${v.url}  ${v.label}`);
  console.log("");
});
