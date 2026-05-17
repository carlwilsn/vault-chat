// Generate user-facing release notes for ship.yml. Reads the git log
// between two refs, asks Claude Haiku to turn it into a short bullet
// list, prints to stdout. The in-app UpdateBanner displays whatever
// lands here verbatim, so the model is told to keep it tight and
// user-facing rather than literal commit subjects.
//
// Falls back to raw `- subject` lines if ANTHROPIC_API_KEY is missing
// or the API call fails — better to ship something than nothing.
//
// Run:  node scripts/release-notes.mjs <git-range>
//   e.g. node scripts/release-notes.mjs v0.1.38..HEAD
import { execSync } from "node:child_process";

const range = process.argv[2];
if (!range) {
  console.error("usage: release-notes.mjs <git-range>");
  process.exit(1);
}

function gitLog(format) {
  return execSync(`git log --no-merges --pretty=format:${JSON.stringify(format)} ${range}`, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function rawSubjects() {
  return gitLog("- %s")
    .split("\n")
    .filter((l) => l.trim() && !l.includes("[skip ci]"))
    .slice(0, 20)
    .join("\n");
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.log(rawSubjects());
  process.exit(0);
}

// Subject + body for each commit, separated by a sentinel the model
// can use to count entries. Bodies often contain the *why* the subject
// alone misses.
const log = gitLog("=== %s%n%b").trim();

const prompt = `You are writing release notes for vault-chat, a personal note-taking app with an AI chat sidebar. Below is the git log of commits in this release. Turn them into a short bullet list of user-facing changes.

Rules:
- Output ONLY bullets starting with "- ", no preamble or heading.
- Group related commits into a single bullet when they describe one user-visible change.
- Skip CI, build, workflow, scripts, version bumps, and other plumbing the user doesn't see.
- Each bullet under 80 characters, plain English, no commit prefixes like "fix:" or "feat:".
- If a commit fixes a bug the user reported, lead with "Fixed" or "Fix".
- 6 bullets max. If there's truly nothing user-facing, output a single bullet "- Internal improvements".

Commits:

${log}`;

try {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.content?.[0]?.text?.trim();
  if (!text || !text.startsWith("-")) {
    throw new Error(`Unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  console.log(text);
} catch (e) {
  console.error(`[release-notes] LLM failed, falling back to raw subjects: ${e.message}`);
  console.log(rawSubjects());
}
