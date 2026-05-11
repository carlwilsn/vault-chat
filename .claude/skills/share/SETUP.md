# /share — one-time setup

The `/share` skill posts to Bluesky on your behalf. Credentials live **outside the repo** at:

```
~/.config/vault-chat-share/credentials.env
```

This file is never committed (it's outside the working tree). Don't put it anywhere else — the posting script only looks at that path.

## 1. Create the credentials file

```sh
mkdir -p ~/.config/vault-chat-share
touch ~/.config/vault-chat-share/credentials.env
chmod 600 ~/.config/vault-chat-share/credentials.env
```

## 2. Bluesky

1. Create the account you want to post from (e.g. `vault-chat.bsky.social`). Either a dedicated handle for the project or your personal handle — both work.
2. In Bluesky: **Settings → Privacy and security → App passwords → Add app password**. Name it `vault-chat-share`. Copy the generated password immediately (looks like `xxxx-xxxx-xxxx-xxxx`) — Bluesky shows it once.
3. Add to `credentials.env`:

```
BSKY_HANDLE=your-handle.bsky.social
BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

App passwords can be revoked anytime from the same settings page. Use a dedicated one for this skill — don't reuse your main login.

## 3. Sanity check

From the repo root:

```sh
node .claude/skills/share/post_bluesky.mjs --dry-run --text "test"
```

`--dry-run` just authenticates and prints the result; it does not post. You should see `{"ok":true,"dryRun":true,"did":"did:plc:...","handle":"your-handle.bsky.social"}`.

## 4. You're set

From here, run `/share` in Claude Code whenever there's something worth shipping. The skill drafts the post, asks for your approval, then posts. Each post is logged to `devlog/posts.jsonl` so there's a running record of what went out.

## Why no Reddit?

Reddit's cadence is one big post every few months, and the culture is hostile to anything that reads as automated. Build-in-public drip-feed doesn't fit. If you ever want a Reddit milestone post, write it manually — `/share` deliberately doesn't help.
