#!/usr/bin/env node
// Post a text + auto-linkified URL to Bluesky.
// Usage:
//   node post_bluesky.mjs --text "Hello https://example.com"
//   node post_bluesky.mjs --dry-run --text "..."   (auth only, no post)
//
// On success, prints one JSON line to stdout: {platform, url, ts, uri, cid}.
// On failure, exits non-zero with a stderr message.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CREDS_PATH = path.join(os.homedir(), ".config", "vault-chat-share", "credentials.env");
const PDS = "https://bsky.social";

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
  const out = { dryRun: false, text: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--text") out.text = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!out.text) throw new Error("--text is required");
  return out;
}

async function createSession(handle, password) {
  const r = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });
  if (!r.ok) throw new Error(`Bluesky auth failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Build facets so URLs in the text become clickable. Byte offsets, not char offsets — UTF-8.
function buildFacets(text) {
  const facets = [];
  const urlRe = /https?:\/\/[^\s)]+/g;
  const enc = new TextEncoder();
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    const uri = m[0];
    const byteStart = enc.encode(text.slice(0, m.index)).length;
    const byteEnd = byteStart + enc.encode(uri).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri }],
    });
  }
  return facets;
}

async function createPost(accessJwt, did, text) {
  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
  };
  const facets = buildFacets(text);
  if (facets.length) record.facets = facets;

  const r = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessJwt}`,
    },
    body: JSON.stringify({
      repo: did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });
  if (!r.ok) throw new Error(`Bluesky post failed: ${r.status} ${await r.text()}`);
  return r.json();
}

function postUrlFromUri(uri, handle) {
  // uri looks like: at://did:plc:xxxx/app.bsky.feed.post/3kabc...
  const rkey = uri.split("/").pop();
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();

  const handle = process.env.BSKY_HANDLE;
  const pw = process.env.BSKY_APP_PASSWORD;
  if (!handle || !pw) {
    throw new Error("BSKY_HANDLE and BSKY_APP_PASSWORD must be set in credentials.env");
  }

  // Grapheme-ish length check. Bluesky's real limit is 300 graphemes; this is a JS char approximation.
  if ([...args.text].length > 300) {
    throw new Error(`Text is ${[...args.text].length} chars; Bluesky limit is 300.`);
  }

  const session = await createSession(handle, pw);
  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, did: session.did, handle: session.handle }));
    return;
  }

  const res = await createPost(session.accessJwt, session.did, args.text);
  const url = postUrlFromUri(res.uri, session.handle);
  console.log(
    JSON.stringify({
      platform: "bluesky",
      ts: new Date().toISOString(),
      url,
      uri: res.uri,
      cid: res.cid,
    }),
  );
}

main().catch((e) => {
  console.error(e.message || String(e));
  process.exit(1);
});
