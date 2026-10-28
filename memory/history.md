# What was built, then removed, and why

Read this before proposing something that sounds new; it may be something he already rejected. Code may still hold
traces of these (e.g. `missionState` in the conversation reader, `src-tauri/assets/phone.html`, the harness-loop skill
under `.claude/skills/`) — legacy, not the design.

- **Missions / supervisor / workers / completion auditor (Jun–Jul 2026).** A multi-day mission harness for GPU
  research runs: supervisors spawning workers, self-scheduled wakes, an LLM auditor gating "done", a phone cockpit
  with Activity and Alerts, ask cards. It worked in places (a deterministic cost guard really killed idle GPU boxes)
  but cost months of reliability work. Dropped in Oct 2026 (no missions system: one agent, run on the box). Lessons
  kept in `agent.md` (four truths, gates, evidence before judges) and `data.md`.
- **Telegram bot** — removed Jun 2026; the phone app is the remote surface.
- **Global "meta vault"** — removed; everything is per-vault so a fresh vault on any machine has it.
- **Codex as engine** — dropped for pi (Oct 2026: Claude caching works, model-neutral, clean edits; "I believe in pi").
- **Separate Rust engine on the box / os-bridge / AgentOS desktop** — AgentOS (Carl's agent-native desktop) is
  paused; the box is a plain server running `server/`. Don't revive a full vault-chat app on the box.
- **ElevenLabs Agents as the brain** — replaced by pi as the one brain (New voice); Classic is kept only as rollback.
  Gemini as the voice model was rejected for sycophancy.
- **Laptop-only mode (a second engine when the box is away)** — removed: two engines meant two sets of bugs. The
  app shows "box unreachable" instead.
- **History view / Ctrl+H, separate chats, the memory UI, the desktop notification bell** — removed in favour of one
  main conversation (plus projects), compaction and written memories. Notifications are phone-only.
- **Clear** — once planned as "blank the view, tell the agent, save memory, compact". Today it only clears the view
  on that device; the conversation and agent keep everything; `/compact` shrinks context.
- **Local voice stack (Kokoro/Piper + local VAD)** — researched, parked: cheaper but not faster; the glitches he hears
  are streaming artifacts, not cloud-specific. New voice uses Pipecat for VAD/turn-taking with cloud STT/TTS.
- **Per-turn cost display, brain icon, status chips in chat** — removed at his request.
- **"One writer" vault sync** (the laptop pull-only) — stranded his laptop edits; replaced by a branch per machine.
- **Built and over-built extras cut from the Oct 2026 release:** task queue/workers, worktrees, tiering, metrics,
  done-check gates, budgets. Keep the harness thin.
