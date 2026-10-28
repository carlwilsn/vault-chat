# How Carl works

AGENTS.md has the short rules. This file is the reasons behind them and the taste calls that keep coming back.

## Momentum
- **A clear ask is a mandate.** Build → prove → push. Ask only for a real ambiguity in the words themselves or an
  irreversible fork with no sensible default. *Why:* on one build the agent fired three approval questions; two
  re-litigated scope he had set ("I thought the scope was clear"). The size of a job is yours to manage, not his to
  re-approve. *Apply:* surface risks as one-line notes he can veto, never as gates that stop the work.
- **He is a user, not a reviewer.** He never reviews PRs ("what's the value?"). The review moment is the in-app
  update and, for projects, the Keep card. Don't design flows that need him to merge or approve code.
- **Push, then rollback; finish the batch.** See AGENTS.md. He got annoyed by repeated "ships in vX soon" and asked
  "is it pushed yet?" several times; he stopped one partial push with "no, let everything finish".
- **Commit after each coherent unit**, without being asked (he asked for this; frequent commits are his safety net).
- **You overestimate how long things take for him.** Scope shorter. Quote time in what doesn't compress (GPU or
  wall-clock runs, debugging-to-match) separately from build time, which compresses hard.

## Honesty
- **Staged is not done.** One night the agent said "all 9 notes closed" when two overhauls were only briefed. He
  checks the files, not the chat. *Apply:* say exactly what shipped (with SHAs), what isn't built, what waits on him.
- **Put what he should read where he reads it** — the vault (a `.md` he opens in the app), not commit messages or
  your memory.
- **Trust his model names.** He named "Sonnet 5" and was told twice it didn't exist from a stale catalog; it did.
  New models ship after your cutoff. Verify the exact id from a live source (the provider's model list,
  OpenRouter's catalog) before editing; never dismiss.

## Taste (his calls, repeated often enough to be rules)
- **Real, not mocked.** Show a proposed UI as the real component on real data, recorded with real input. He called
  a mockup "horrible" and asked for "honest fidelity". He reacts well to seeing the real thing before a design ships.
- **Minimal and nested.** Few options on screen, one level at a time. No explainer text where a greeting will do.
- **Near-monochrome.** "Too much color": neutral grey for done states, colour only for the one thing that needs
  attention, red only for failure. He dislikes warm colours (a warn amber became a calm blue at his request).
- **No per-turn cost, no system markers in chat.** No "started 2m ago · 2 files in context" strips above messages —
  "don't have it now, don't want it later". Metadata belongs in the list or settings, never the message stream.
- **No tool-call labels on bubbles.** Humanized actions inside a timeline are fine; raw tool names are not.
- **Reviewing:** he prefers navigating the real thing himself; demos should be slow and narrated, before then after,
  not side by side.
- **Everything per-vault** under `<vault>/.vault-chat/` and synced by git; never a provider-branded path like
  `.claude/` in a vault.

## Where he works
Laptop (Windows) app + phone + iPad board, all clients of the box. His live vault is `school2`. Projects (this one
included) are his: never create or assign one. Other agents and sessions may be live in the same repos at the same
time — see `proof.md` (shared working copies).
