#!/usr/bin/env node
// Submit a post to a subreddit via the Reddit API.
// Usage:
//   node post_reddit.mjs --subreddit ObsidianMD --title "..." --body "..."
//   node post_reddit.mjs --subreddit ObsidianMD --title "..." --url "https://..."
//   node post_reddit.mjs --dry-run --subreddit X --title "..." --body "..."  (auth only)
//
// On success, prints one JSON line to stdout: {platform, subreddit, url, ts}.
// On failure, exits non-zero with a stderr message.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CREDS_PATH = path.join(os.homedir(), ".config", "vault-chat-share", "credentials.env");

function loadEnv() {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error(
      `Credentials not found at ${CREDS_PATH}. See .claude/skills/share/SETUP.md`,
    );
  }
  for (const line of fs.readFileSync(CREDS_PATH, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}

function parseArgs(argv) {
  const out = { dryRun: false, subreddit: null, title: null, body: null, url: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--subreddit") out.subreddit = argv[++i];
    else if (a === "--title") out.title = argv[++i];
    else if (a === "--body") out.body = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!out.subreddit) throw new Error("--subreddit is required");
  if (!out.title) throw new Error("--title is required");
  if (!out.body && !out.url && !out.dryRun) {
    throw new Error("Either --body or --url is required");
  }
  if (out.body && out.url) {
    throw new Error("--body and --url are mutually exclusive");
  }
  if (out.title.length > 300) {
    throw new Error(`Title is ${out.title.length} chars; Reddit limit is 300.`);
  }
  return out;
}

async function getAccessToken() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  const user = process.env.REDDIT_USERNAME;
  const pw = process.env.REDDIT_PASSWORD;
  const ua = process.env.REDDIT_USER_AGENT;
  if (!id || !secret || !user || !pw || !ua) {
    throw new Error(
      "REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD, REDDIT_USER_AGENT must all be set",
    );
  }

  const body = new URLSearchParams({
    grant_type: "password",
    username: user,
    password: pw,
  });

  const r = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "user-agent": ua,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!r.ok) throw new Error(`Reddit auth failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  if (!j.access_token) throw new Error(`Reddit auth returned no token: ${JSON.stringify(j)}`);
  return { token: j.access_token, ua };
}

async function submit({ token, ua }, { subreddit, title, body, url }) {
  const form = new URLSearchParams({
    api_type: "json",
    sr: subreddit,
    title,
    kind: url ? "link" : "self",
    resubmit: "false",
    sendreplies: "true",
  });
  if (url) form.set("url", url);
  else form.set("text", body);

  const r = await fetch("https://oauth.reddit.com/api/submit", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": ua,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!r.ok) throw new Error(`Reddit submit failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const errors = j?.json?.errors;
  if (errors && errors.length) {
    throw new Error(`Reddit submit returned errors: ${JSON.stringify(errors)}`);
  }
  const postUrl = j?.json?.data?.url;
  if (!postUrl) throw new Error(`Reddit submit returned no URL: ${JSON.stringify(j)}`);
  return postUrl;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();
  const auth = await getAccessToken();

  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, ua: auth.ua }));
    return;
  }

  const url = await submit(auth, args);
  console.log(
    JSON.stringify({
      platform: "reddit",
      ts: new Date().toISOString(),
      subreddit: args.subreddit,
      url,
    }),
  );
}

main().catch((e) => {
  console.error(e.message || String(e));
  process.exit(1);
});
