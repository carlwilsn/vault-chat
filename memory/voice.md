# Voice

Today: **New** (Pipecat ears and mouth on the box, `voice-pipeline/bot.py`; pi the one brain via
`server/voiceBrain.ts`, talker Haiku with thinking off) and **Classic** (an ElevenLabs agent handing requests to pi,
`src/voice-elevenlabs.ts`), switchable in Settings; Classic is the one-click rollback.

## Carl's rules
- **No glazing — this is an epistemic bug, not tone.** He uses voice to test his own understanding: he restates a
  concept to check he owns it. A confirmer that praises makes the check worthless. He told an agent twice in one
  session to stop ("I can't tell if I'm truly understanding this or if you're just glazing me") and it drifted back
  within minutes. *Apply:* when he restates something, lead with what is wrong or missing; never praise the question.
  Gemini was rejected as the voice brain for sycophancy; model choice is a legitimate lever here.
- **General fixes, not niche scaffolding.** "I want the clothes to fit, not be fashionable." Rounds of
  workflow-specific prompt blocks (lecture mode, walkthrough pacing) were reverted within hours. Classify each fix as
  general or niche; niche needs his confirmation. Prefer deleting scaffolding to adding it.
- **How he actually uses it:** he sits on one page or slide for a long time and discusses it. Walkthroughs are a
  correctness test, not the target. He is sensitive to over-proactive scrolling, narration pacing, "let's move on".
  He also works by hand on the iPad with voice idle and unmutes to ask ("office hours").
- **No forced filler before a tool** ("One sec", "On it" are banned) — AGENTS.md.
- **"Voice session ended" in a transcript is usually him** ending the call to type or walk away, not a drop. Ask
  before building reconnect logic.

## Engineering lessons
- **Read the SDK before tuning knobs.** Four "fixes" for text running ahead of speech each tuned a different constant
  (mode flag, amplitude poll, silence window, queue); reading `node_modules/@elevenlabs/client/dist` showed the gate
  itself was wrong. When a timing bug returns after a fix on the same path, stop and read the library's source.
- **ElevenLabs client facts** (Classic): the speaking/listening mode is driven by *audio* reaching and draining the
  worklet, not by the LLM; output-amplitude reads are unreliable (buffered audio reads silent); `onMessage` fires once
  per agent turn with the full text; client tool calls in one turn run one after another. `turn_timeout` (1–30 s)
  can't be disabled — a prompt rule "don't check in" lost to it; giving the agent the `skip_turn` tool fixed it
  (tools beat prompt instructions for "stay quiet"). System tools belong in `built_in_tools`.
- **Classic's agent is cached per device**; changing its config requires bumping `AGENT_CONFIG_VERSION` in
  `src/voice-elevenlabs.ts` to re-provision. ASR and turn models are pinned (`scribe_realtime`, `turn_v3`); a newer
  ElevenLabs model won't apply until you change them.
- **Fast talker, one brain.** Voice may keep a fast model for latency only as pi's front of house: it reads pi's
  session, writes into it, and delegates every action. No separate memory, no tools that act on their own. Earlier
  bugs (double answers, dropped actions, mental arithmetic, `[skip_turn]` leaking into the transcript, guessing at an
  empty attachment) came from voice being a second brain.
- Only Gemini receives a PDF natively; other voice models need extracted text.
- **Only the reply is spoken, never progress commentary (2026-10-29).** GPT-6.1 Sol writes "I'll find and open Chan
  work.md…" as plain text beside its tool calls (OpenAI's `phase: "commentary"` is lost through OpenRouter's chat
  completions); the voice read it aloud and the chat showed it as a reply. The rule for every model is
  `src/convlog/commentary.ts`: text in a message that calls a tool is commentary. The chat folds it under "Thought";
  `server/voiceBrain.ts` holds a message's sentences until its end and says them only if it called no tool (first audio
  waits for the message to finish: a short spoken reply streams in well under a second).
