# vault-chat — rules for the agent that builds it

vault-chat is Carl's own Claude Code / Codex: a UI over a real agent engine (pi) that runs on his home server (the box,
`thinkbox`), with a laptop app (Tauri), a phone web app, an iPad whiteboard and voice. This project folder is a clone of
github.com/carlwilsn/vault-chat; you work on your own branch. The installed service's **SubmitChange** runs pinned baseline/candidate gates and real UI proof before accepting main; agents never merge or push main.

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
- **Installed service acceptance, not review.** SubmitChange is the default; no mandatory Keep wait. Acceptance is not Shipped: laptop sync → CI → actual box and authenticated Tauri health must verify first. Source rollback reverts the specific accepted range and passes the same proof path. Historical Keep cards remain readable. Carl explicitly approved ONE final old-service handoff for A plus the voice-mic fixture fix after full candidate checks and real UI proof; this bootstrap is not self-A proof against broken `6fcc7f6` and does not authorize manual main merges/pushes or candidate sidecars. B uses installed A thereafter.
- **Push, then rollback.** Proven work is pushed without asking; Carl asks for a rollback if he dislikes it. Still ask
  before anything a git revert can't undo: deleting his data, spending money, anything public.
- **Finish the batch, test once, push.** Answer "is it pushed?" with yes or no plus one line on what's left.
- **Say what is half-baked.** One honest route beats three. Staged is not done.
- **Don't re-ask settled scope.** A clear ask means do it; ask only at real forks (spend, irreversible, taste).
- **Tests never use his speakers.** Every test browser is muted (`--mute-audio`) or captures audio in-page.
- **Secrets stay secret.** Never print or commit keys or tokens. The agent may use the keys Carl added to vault-chat
  (they reach your commands as environment variables).
- **Decisions that stand:** the engine is pi (Codex dropped). The voice talker is Haiku with thinking off — Gemini was
  rejected for sycophancy. No forced filler line before a tool ("One sec", "On it" are banned). Projects are Carl's:
  never create or assign one yourself. Carl rarely live-edits PDFs; his edit flows are LaTeX and HTML.

## How the pieces fit (read before changing them)

- **Box server** (`server/`, Node): one pi engine per vault; the conversation log; `/poll` feed; voice routes
  (`server/voiceBrain.ts`); proof-gated projects (an agent works on `agent/<name>` in its own clone;
  SubmitChange accepts on the box with a live host proof permit; laptop sync pushes main to GitHub — the box has no GitHub credentials).
- **Voice (New):** `voice-pipeline/bot.py` (Pipecat: Silero VAD, Smart Turn, ElevenLabs Scribe/Flash) is ears and mouth
  only; pi is the one brain (`server/voiceBrain.ts`); the device client is `src/voiceBrainClient.ts`; the waiting line
  is `src/voiceWaitLine.ts`.
- **Laptop app** (`src/`, React + Tauri); **phone** (`phone/`); **whiteboard** (`board/`).
- **Preview harness** (`preview/`): the real frontend against a fake backend, or against a real server (`realbox`).
- **Release:** pushing main → CI builds and tags; the box self-updates (`vault-chat-update` timer).

## Memory: read before you start

`memory/` holds what earlier agents learned building vault-chat — each rule with its why. `memory/INDEX.md` maps
it. Read `carl.md` once per project; then, before the work at hand: UI or any claim of "done" → `proof.md`; phone →
`phone.md`; voice → `voice.md`; sync, git or anything written to disk → `data.md`; prompts, agent behaviour or a
second layer → `agent.md`; the box, a release or an update → `box.md`; "why don't we have X?" → `history.md`.
Personal notes about Carl are in `.vault-chat/memory.md` (not in git). When you learn something durable, add it to
the right file in the same change. The code wins over a memory that contradicts it; fix the memory.

Older reports (decisions, measurements, failures) are in Carl's AgentOS repo under `reports/`.
