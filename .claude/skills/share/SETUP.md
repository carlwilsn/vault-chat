# /share — one-time setup

The `/share` skill posts to Bluesky and Reddit on your behalf. Both need credentials. Credentials live **outside the repo** at:

```
~/.config/vault-chat-share/credentials.env
```

This file is never committed (it's outside the working tree). Don't put it anywhere else — the posting scripts only look at that path.

## 1. Create the credentials file

```sh
mkdir -p ~/.config/vault-chat-share
touch ~/.config/vault-chat-share/credentials.env
chmod 600 ~/.config/vault-chat-share/credentials.env
```

Open it in your editor of choice and add the variables below as you set each platform up.

## 2. Bluesky

1. Create the account you want to post from (e.g. `vault-chat.bsky.social`). Either a dedicated handle for the project or your personal handle — both work.
2. In Bluesky: **Settings → Privacy and security → App passwords → Add app password**. Name it `vault-chat-share`. Copy the generated password (looks like `xxxx-xxxx-xxxx-xxxx`).
3. Add to `credentials.env`:

```
BSKY_HANDLE=your-handle.bsky.social
BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

App passwords can be revoked anytime from the same settings page. Use a dedicated one for this skill — don't reuse your main login.

## 3. Reddit

Reddit uses OAuth with the "script" app type. You need: client ID, client secret, your Reddit username, and your Reddit password.

1. Go to https://www.reddit.com/prefs/apps and click **Create another app...** at the bottom.
2. Fill in:
   - **name**: `vault-chat-share`
   - **type**: `script` (this is critical — `script` is the only type that supports password-grant flow)
   - **redirect uri**: `http://localhost:8080` (unused for script apps, but the field is required)
   - leave **about url** and **description** blank
3. After creating, you'll see two strings under the app name:
   - The string directly under "personal use script" → that's your **client ID**
   - The string next to "secret" → that's your **client secret**
4. Add to `credentials.env`:

```
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USERNAME=your_reddit_username
REDDIT_PASSWORD=your_reddit_password
REDDIT_USER_AGENT=vault-chat-share/0.1 by your_reddit_username
```

Notes:
- `REDDIT_USER_AGENT` must be unique and descriptive. Reddit rate-limits generic UAs aggressively. Include your username so they can contact you if the script misbehaves.
- The Reddit account needs some history. Brand new accounts get auto-filtered in most subs. If you're starting fresh, comment on a few threads first.
- 2FA-enabled accounts can't use password grant directly — you'd need to disable 2FA on this account or use a dedicated account without 2FA for posting.

## 4. Sanity check

Once both blocks are in `credentials.env`, you can sanity-check from the repo root:

```sh
node .claude/skills/share/post_bluesky.mjs --dry-run --text "test"
node .claude/skills/share/post_reddit.mjs --dry-run --subreddit test --title "test" --body "test"
```

`--dry-run` just authenticates and prints the auth result; it does not post.

## 5. You're set

From here, run `/share` in Claude Code whenever there's something worth shipping. The skill drafts the copy, asks for your approval, then posts. Each post is logged to `devlog/posts.jsonl` in the repo so there's a running record.
