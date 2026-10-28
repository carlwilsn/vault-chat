# Memory — what earlier agents learned building vault-chat

Distilled 2026-10-28 from the notes Claude Code kept while building vault-chat (May–Oct 2026). Each file is one
topic: the rule, **why** it exists, and **how to apply** it. Checked against the code on main at v0.7.12; where a
note names a file or flag, it was still there. History that no longer describes the code is in `history.md`, kept
only for its reasons. If a memory contradicts the code, the code wins — say so, and fix the memory.

| Read before… | File |
|---|---|
| any change, first time in this project | `carl.md` — how Carl works, what he expects, his taste |
| claiming anything works; any UI change | `proof.md` — what counts as proof, real UI and real input, traps that faked a pass |
| phone (`phone/`) or iOS work | `phone.md` — PWA viewport, keyboard, Return key, icon, push deep-links |
| voice (New or Classic) | `voice.md` — anti-sycophancy, general fixes only, how he uses voice, ElevenLabs SDK facts |
| sync, git, conversation/notes storage, anything written to disk | `data.md` — tombstones, union-merge, durable-before-ack, the git engine's hard-won rules |
| prompts, agent behaviour, asks/decisions, a "second layer" | `agent.md` — thin layer, the four truths, gates over instructions, evidence before judges |
| the box, releases, updates, CI | `box.md` — how a change reaches Carl, the update timer, Tailscale, cost of restarts |
| wondering "why don't we have X?" | `history.md` — what was built, then removed, and why |

Personal facts about Carl (not product rules) live outside git in `.vault-chat/memory.md` in this folder.
