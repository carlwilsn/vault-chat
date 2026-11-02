# vault-chat — rules for the agent that builds it

vault-chat is Carl's own Claude Code / Codex: a UI over a real agent engine (pi) that runs on his home server (the box,
`thinkbox`), with a laptop app (Tauri), a phone web app, an iPad whiteboard and voice. This project folder is a clone of
github.com/carlwilsn/vault-chat; you work on your own branch.

## Carl's rules

- **Thin layer over pi.** vault-chat is a UI/UX surface. Agent abilities come from pi (sessions, compaction, steer and
  follow-up, skills, AGENTS.md, subagents) and from mature libraries. Before building anything, check whether pi or a
  library already does it. A bug in a layer that duplicates pi (state, streaming, tool events, a second brain) is fixed
  by removing that duplicate, one piece at a time — never by adding rules to keep copies in sync. Say plainly when a
  change is a patch to a duplicated layer.
- **Prove, never claim.** "Done" means: the gates pass (`npx tsc --noEmit -p .`, `npm run typecheck:phone`,
  `typecheck:board`, `typecheck:server`, `npm run test:harness`, `npm run test:server`, `npm run build:server`) **and**
  the change is shown working in the real UI — screenshots or a recording of the real app on real data, never a mockup.
  A check that can't run is a failure, not a pass.
- **Real UI, minimal UI.** Few options on screen at a time, nested one level at a time. No per-turn cost in the chat.
- Shipping: push agent/<branch> to `publish`, write ship-requests/<name>.req, read ship-results/<name>.result. The script decides; a failed release only rolls back to the last good binary. No source recovery, no proof cards, no Keep, no owner units or chains. Shipped means the box and Carl's laptop run it.
- **Fix forward.** Never source-revert or roll back accepted work. Fix a bad release with the next small change. Ask before deleting data, spending money or making anything public.
- **One change at a time: fix, request, read result, next.** No systemd-run units, continuations, owners, handoffs, receipts or waiting chains. Answer "is it pushed?" with yes or no plus one line on what's left.
- **Say what is half-baked.** One honest route beats three. Staged is not done.
- **Don't re-ask settled scope.** A clear ask means do it; ask only at real forks (spend, irreversible, taste).
- **Tests never use his speakers.** Every test browser is muted (`--mute-audio`) or captures audio in-page.
- **Secrets stay secret.** Never print or commit keys or tokens. The agent may use the keys Carl added to vault-chat
  (they reach your commands as environment variables).
- **Decisions that stand:** the engine is pi (Codex dropped). The voice talker is Haiku with thinking off — Gemini was
  rejected for sycophancy. No forced filler line before a tool ("One sec", "On it" are banned). Projects are Carl's:
  never create or assign one yourself. Carl rarely live-edits PDFs; his edit flows are LaTeX and HTML.

## How the pieces fit (read before changing them)

- **Box server** (`server/`, Node): one pi engine per vault; the conversation log; `/poll` feed; voice routes (`server/voiceBrain.ts`).
- Shipping: push agent/<branch> to `publish`, write ship-requests/<name>.req, read ship-results/<name>.result. The script decides; a failed release only rolls back to the last good binary. No source recovery, no proof cards, no Keep, no owner units or chains. Shipped means the box and Carl's laptop run it.
- **Voice (New):** `voice-pipeline/bot.py` (Pipecat: Silero VAD, Smart Turn, ElevenLabs Scribe/Flash) is ears and mouth
  only; pi is the one brain (`server/voiceBrain.ts`); the device client is `src/voiceBrainClient.ts`; the waiting line
  is `src/voiceWaitLine.ts`.
- **Laptop app** (`src/`, React + Tauri); **phone** (`phone/`); **whiteboard** (`board/`).
- **Preview harness** (`preview/`): the real frontend against a fake backend, or against a real server (`realbox`).
- **Release:** after acceptance, publish main to GitHub using the box deploy key once Carl enables it; CI builds and tags. Verify the installed release on the box and Carl's laptop.

## Memory: read before you start

`memory/` holds what earlier agents learned building vault-chat — each rule with its why. `memory/INDEX.md` maps
it. Read `carl.md` once per project; then, before the work at hand: UI or any claim of "done" → `proof.md`; phone →
`phone.md`; voice → `voice.md`; sync, git or anything written to disk → `data.md`; prompts, agent behaviour or a
second layer → `agent.md`; the box, a release or an update → `box.md`; "why don't we have X?" → `history.md`.
Personal notes about Carl are in `.vault-chat/memory.md` (not in git). When you learn something durable, add it to
the right file in the same change. The code wins over a memory that contradicts it; fix the memory.

Older reports (decisions, measurements, failures) are in Carl's AgentOS repo under `reports/`.
