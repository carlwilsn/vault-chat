# Meta vault

This folder is your agent's internals — the system prompt, the skills it knows, and any custom tools you've built for it. You can edit any of it as regular files. The agent can too.

## What's here

- **`system.md`** — the system prompt delivered on every agent turn. Edit it to change how the agent behaves, what rules it follows, what tools it should prefer. Takes effect on the next turn.
- **`skills/`** — slash-command skills. Each subfolder is a skill: `skills/my-skill/SKILL.md` with YAML front-matter (`name`, `description`) + a body of prose / examples. Invoke with `/my-skill` in the chat. Same format as vault-level skills.
- **`tools/`** — custom tools exposed to the agent. Each subfolder is one tool: `tools/my-tool/TOOL.md` (description + input schema as YAML front-matter) + `run.py` / `run.js` / `run.sh` (the executable). The app loads these at each agent turn and adds them to the tool roster.

## Git

This folder is a git repo. Every change the agent makes to itself is auto-committed, so you can `git log` your agent's evolution and revert anything.

## Resetting

If you break something, you can restore the bundled defaults from the "Restore defaults" button in Settings (coming soon) — or just `git reset --hard` to any earlier commit.
