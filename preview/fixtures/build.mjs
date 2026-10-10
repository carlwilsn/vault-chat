// Build a private fixture base from a real vault — strictly read-only on the
// vault (it only ever reads; it never writes, stages or locks anything there).
//
//   node preview/fixtures/build.mjs --vault C:\Users\wada2\github\school2 [--name school2] [--max-convs 8]
//
// What is copied is an ALLOWLIST (below): notes and text files in the course
// folders, the agent prompts/skills/goals, and a handful of recent
// conversations. Everything else is excluded with a reason. Every copied file
// goes through a secret scanner; hits are replaced with «REDACTED» and listed
// (masked) in preview/fixtures/REDACTION-REPORT.md.
//
// Output: preview/fixtures/private/<name>/vault/  — gitignored. It is usable
// in the harness right away (pick it in the "data" menu), and must not be
// committed until Carl has read and approved the report.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const VAULT = resolve(opt("vault", "C:/Users/wada2/github/school2"));
const NAME = opt("name", VAULT.split(/[\\/]/).pop());
const MAX_CONVS = Number(opt("max-convs", 8));
const MAX_CONV_BYTES = Number(opt("max-conv-bytes", 450_000));
const OUT = join(HERE, "private", NAME, "vault");
const REPORT = join(HERE, "REDACTION-REPORT.md");

// ---- the allowlist ----------------------------------------------------------
const TEXT = new Set([".md", ".txt", ".csv", ".tex", ".py", ".bib"]);
const ALWAYS_EXCLUDE = [
  [/(^|\/)\.git(\/|$)/, "git internals"],
  [/^\.vault-chat\/keys\.enc$/, "encrypted key store"],
  [/^\.vault-chat\/app-log\.txt$/, "app debug log"],
  [/^\.vault-chat\/client-events\.jsonl$/, "client event log"],
  [/^\.vault-chat\/sync-log\.jsonl$/, "sync log (host names, git stderr)"],
  [/^\.vault-chat\/run-heartbeat\.json$/, "runtime state"],
  [/^\.vault-chat\/vault-id$/, "vault identity (replaced with a synthetic id)"],
  [/^\.vault-chat\/voices\.json$/, "voice ids"],
  [/^\.vault-chat\/sync\.json$/, "box address (the sync scenarios use a fake one)"],
  [/telegram-images\//, "telegram images"],
  [/(^|\/)photos\//, "personal photos"],
  [/(^|\/)\.tmp-/, "temp file"],
];
const VAULT_CHAT_ALLOW = [
  /^\.vault-chat\/agent\/[^/]+\.md$/,
  /^\.vault-chat\/skills\/.+\.md$/,
  /^\.vault-chat\/supervisor\/.+\.md$/,
  /^\.vault-chat\/notifications\.jsonl$/,
  /^\.vault-chat\/schedules(-deleted)?\.jsonl$/,
  /^\.vault-chat\/notes\.jsonl$/,
];

// ---- the secret scanner -------------------------------------------------------
const PATTERNS = [
  ["openrouter key", /sk-or-(?:v\d-)?[A-Za-z0-9_-]{16,}/g],
  ["anthropic key", /sk-ant-[A-Za-z0-9_-]{16,}/g],
  ["openai-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ["github token", /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g],
  ["elevenlabs key", /\b(?:xi-|sk_)[A-Za-z0-9]{24,}/g],
  ["tavily key", /\btvly-[A-Za-z0-9_-]{16,}/g],
  ["aws key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google api key", /\bAIza[0-9A-Za-z_-]{30,}/g],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["vapid/jwk private", /"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/g],
  ["key=value secret", /\b(?:api[_-]?key|secret|token|passphrase|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/gi],
  ["token in URL", /[?&](?:token|key|access_token|auth)=[A-Za-z0-9_\-.%]{8,}/gi],
  ["bearer token", /\bBearer\s+[A-Za-z0-9_\-.=]{16,}/g],
  ["tailscale host", /\b[a-z0-9-]+\.(?:tail[0-9a-f]+\.)?ts\.net\b/gi],
  ["email address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["ip address", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ["phone number", /(?<![\w.])\+?1?[ (.-]*\d{3}[ ).-]+\d{3}[ .-]+\d{4}(?![\w.])/g],
  ["long hex secret", /\b[0-9a-f]{40,}\b/gi],
  ["long base64 blob", /\b[A-Za-z0-9+/]{60,}={0,2}/g],
];
// Values that look like a hit but are known-safe (version numbers, the
// preview's own fake keys, image data URLs are excluded wholesale below).
const SAFE = [/^127\.0\.0\.1$/, /^0\.0\.0\.0$/, /PREVIEW/];

function mask(s) {
  return s.length <= 8 ? "•".repeat(s.length) : `${s.slice(0, 3)}…(${s.length} chars)…${s.slice(-2)}`;
}

function scan(rel, text) {
  const hits = [];
  // Embedded images (data URLs) are dropped, not scanned: they can hold anything.
  let out = text.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, () => {
    hits.push({ pattern: "embedded image (data URL)", line: 0, masked: "image removed" });
    return "data:image/png;base64,REMOVED";
  });
  for (const [name, re] of PATTERNS) {
    out = out.replace(re, (m, ...rest) => {
      if (SAFE.some((s) => s instanceof RegExp && s.test(m))) return m;
      if (name === "ip address" && m.split(".").some((p) => Number(p) > 255)) return m;
      const offset = rest[rest.length - 2];
      const line = typeof offset === "number" ? out.slice(0, offset).split("\n").length : 0;
      hits.push({ pattern: name, line, masked: mask(m) });
      return "«REDACTED»";
    });
  }
  return { out, hits };
}

// ---- walk ---------------------------------------------------------------------
function walk(dir, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (n === ".git") continue;
      walk(p, acc);
    } else acc.push({ p, rel: relative(VAULT, p).replace(/\\/g, "/"), size: st.size, mtime: st.mtimeMs });
  }
  return acc;
}

if (!existsSync(VAULT)) throw new Error(`no vault at ${VAULT}`);
const files = walk(VAULT);
const included = [];
const excluded = [];
const convs = files.filter((f) => /^\.vault-chat\/conversations\/[^/]+\.jsonl$/.test(f.rel));
const pickedConvs = new Set(
  convs
    .filter((f) => f.size <= MAX_CONV_BYTES)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_CONVS)
    .map((f) => f.rel),
);

for (const f of files) {
  const always = ALWAYS_EXCLUDE.find(([re]) => re.test(f.rel));
  if (always) {
    excluded.push({ ...f, why: always[1] });
    continue;
  }
  if (f.rel.startsWith(".vault-chat/conversations/")) {
    if (pickedConvs.has(f.rel)) included.push(f);
    else excluded.push({ ...f, why: f.size > MAX_CONV_BYTES ? `conversation over ${MAX_CONV_BYTES / 1000} kB` : `not among the ${MAX_CONVS} most recent` });
    continue;
  }
  if (f.rel.startsWith(".vault-chat/")) {
    if (VAULT_CHAT_ALLOW.some((re) => re.test(f.rel))) included.push(f);
    else excluded.push({ ...f, why: "app state not on the allowlist" });
    continue;
  }
  if (f.rel.startsWith(".")) {
    excluded.push({ ...f, why: "dotfile" });
    continue;
  }
  const ext = extname(f.rel).toLowerCase();
  if (!TEXT.has(ext)) {
    excluded.push({ ...f, why: ext === ".pdf" ? "PDF (binary; may be copyrighted)" : `binary (${ext || "no extension"})` });
    continue;
  }
  if (f.size > 1_000_000) {
    excluded.push({ ...f, why: "text over 1 MB" });
    continue;
  }
  included.push(f);
}

const allHits = [];
for (const f of included) {
  const raw = readFileSync(f.p, "utf8");
  const { out, hits } = scan(f.rel, raw);
  for (const h of hits) allHits.push({ file: f.rel, ...h });
  const dest = join(OUT, f.rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);
}
mkdirSync(join(OUT, ".vault-chat"), { recursive: true });
writeFileSync(join(OUT, ".vault-chat", "vault-id"), "preview-0000-0000-0000-000000000000\n");

// ---- the report ---------------------------------------------------------------
const byPattern = new Map();
for (const h of allHits) byPattern.set(h.pattern, (byPattern.get(h.pattern) ?? 0) + 1);
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
const report = `# Redaction report — preview fixture "${NAME}"

Generated ${new Date().toISOString()} by \`preview/fixtures/build.mjs\` from \`${VAULT}\` (read-only).

**Status: NOT APPROVED.** The fixture at \`preview/fixtures/private/${NAME}/\` is gitignored and must not be committed until Carl has read this report and approved it.

## Summary

- Files in the vault: ${files.length}
- Copied (allowlisted text): ${included.length} (${kb(included.reduce((a, f) => a + f.size, 0))})
- Excluded: ${excluded.length}
- Redactions: ${allHits.length} — ${[...byPattern.entries()].map(([k, n]) => `${k}: ${n}`).join(", ") || "none"}

Hits are replaced by \`«REDACTED»\` in the copy. Values below are masked (first 3 and last 2 characters and the length) — the report never contains a secret.

## Redactions

| file | line | pattern | masked value |
|---|---|---|---|
${allHits.map((h) => `| ${h.file} | ${h.line || ""} | ${h.pattern} | \`${h.masked}\` |`).join("\n") || "| (none) | | | |"}

## Copied

| file | size |
|---|---|
${included.map((f) => `| ${f.rel} | ${kb(f.size)} |`).join("\n")}

## Excluded

| file | size | why |
|---|---|---|
${excluded.map((f) => `| ${f.rel} | ${kb(f.size)} | ${f.why} |`).join("\n")}

## Not covered by the scanner

- Personal content in prose (names of classmates, grades, health notes) is not detectable by pattern. The copied list above is what to skim for that.
- Conversations are copied whole (minus embedded images). They are the most likely place for something personal.
`;
writeFileSync(REPORT, report);
console.log(`copied ${included.length}, excluded ${excluded.length}, redactions ${allHits.length}`);
console.log(`fixture: ${OUT}`);
console.log(`report:  ${REPORT}  (read it; nothing here is committed until approved)`);
