// Voice is the conversation's front of house (D3, "one brain"): a fast talker
// model that speaks for the conversation it is attached to. Its context is that
// conversation's pi session (what was typed and said, its compaction summary)
// plus the "you" layer; every line it hears or says goes into that session; and
// every action is the conversation's agent's (pi): voice has ONE delegation tool
// (Ask) and, on a device with a screen, the tools that must run on that screen.
// No files, notes, board, projects, web, shell or arithmetic of its own — so the
// tool set is the same on every surface by construction, and voice can only
// relay what pi confirmed.
//
// Pure: the box builds the session's prompt (server/voice.ts), the ElevenLabs
// agent is provisioned with voiceToolDefs(device) (src/voice-elevenlabs.ts), and
// the three clients (laptop, phone, board) filter control lines with
// isControlLine.

export type VoiceDevice = "laptop" | "phone" | "board";
export const VOICE_DEVICES: readonly VoiceDevice[] = ["laptop", "phone", "board"];
/** A device name from a client; anything else is the phone's (the most limited: no screen tools, an honest prompt). */
export const voiceDevice = (x: unknown): VoiceDevice => (VOICE_DEVICES.includes(x as VoiceDevice) ? (x as VoiceDevice) : "phone");

/** The voice's one tool that acts: a request to the conversation's agent. */
export const ASK = "Ask";
/** Tools that read or move the screen in front of Carl: they run on that device, never on the box. */
export const SCREEN_TOOLS = new Set(["LookAtScreen", "ShowFile", "ScrollTo"]);

type Param = { type: string; description: string };
export type VoiceToolDef = { name: string; description: string; parameters: { type: "object"; properties: Record<string, Param>; required: string[] } };

// ElevenLabs' validator wants a description on every property (else HTTP 422 on agent-create).
const ASK_DEF: VoiceToolDef = {
  name: ASK,
  description:
    "Hand a request to the agent of this conversation — the same agent as Carl's typed chat, with every tool: files (read, write, edit), notes, his whiteboard inbox, his own vault tools (calendar …), conversations, the web, Python and the shell. Use it for ANY action and for anything you would otherwise have to work out or guess: arithmetic and math (it runs Python), facts in files, what's on the board inbox, searches. Pass Carl's request in his own words (short). It runs in the background as a side request (it never interrupts the agent's own work in the chat) and returns at once with a request id; the answer comes to you later as a message starting [vc:result]. Never say it is done before that.",
  parameters: {
    type: "object",
    properties: {
      request: { type: "string", description: "Carl's request in his own words, with what he pointed at (a file, a page). Short: one or two sentences." },
      act: { type: "boolean", description: "true only when he asked for a change: write or edit a file, save a note, send something. Leave it out for a question or a lookup." },
    },
    required: ["request"],
  },
};
const LOOK_DEF: VoiceToolDef = {
  name: "LookAtScreen",
  description:
    "See Carl's screen right now, on the device in front of him — call it for 'what's this?', 'look at this', 'can you see it?', and whenever he says he pasted, wrote or changed something. Returns what is in view as text and attaches the picture. Earlier looks may be out of date; look again after a change. If it says nothing is there, say you saw nothing.",
  parameters: { type: "object", properties: {}, required: [] },
};
const SHOW_DEF: VoiceToolDef = {
  name: "ShowFile",
  description: "Open a file in Carl's viewer on his laptop ('pull up the diagram'). Images are attached so you can see them. Returns what was opened.",
  parameters: { type: "object", properties: { path: { type: "string", description: "The file: a path from the file index (vault-relative or absolute)." } }, required: ["path"] },
};
const SCROLL_DEF: VoiceToolDef = {
  name: "ScrollTo",
  description:
    "Move Carl's laptop viewer to a page or section of the open file (PDF, markdown, HTML), for read-along: 'go to page 6', 'back to the bubble diagram'. One ScrollTo per move, then talk about that page. Returns where it moved, or the nearest headings when nothing matched.",
  parameters: {
    type: "object",
    properties: {
      page: { type: "number", description: "1-based PDF page number (PDFs only)." },
      anchor: { type: "string", description: "A heading's text, its #id, or a phrase on the page." },
      path: { type: "string", description: "Optional file path; the open file when omitted." },
    },
    required: [],
  },
};

/** The voice's tools on `device`, exactly (plus ElevenLabs' skip_turn system tool, provisioned with them). */
export function voiceToolDefs(device: VoiceDevice): VoiceToolDef[] {
  if (device === "laptop") return [ASK_DEF, LOOK_DEF, SHOW_DEF, SCROLL_DEF];
  if (device === "board") return [ASK_DEF, LOOK_DEF];
  return [ASK_DEF];
}
export const voiceToolNames = (device: VoiceDevice): string[] => voiceToolDefs(device).map((t) => t.name);

// ---------------------------------------------------------------- control lines

/** What vault-chat itself sends into a call as a user message ("[vc:result] …"): never a line of Carl's. */
export const CONTROL_PREFIX = "[vc:";
export const controlLine = (kind: string, body: string): string => `${CONTROL_PREFIX}${kind}] ${body}`;
export const isControlLine = (text: string): boolean => text.trimStart().startsWith(CONTROL_PREFIX);

// ---------------------------------------------------------------- spoken, never written

/** The platform's soft-timeout filler (src/voice-elevenlabs.ts SOFT_TIMEOUT_MESSAGE) and voice's own holding lines. */
const FILLER = /^(?:one sec(?:ond)?|just a (?:sec(?:ond)?|moment)|give me a (?:sec(?:ond)?|moment)|hang on|hold on|on it|checking|let me (?:check|look|see|find)|looking(?: it up| that up)?|i'll (?:check|look)|one moment)\b/i;
/** A short holding line ("One sec—I'm checking the objective…"): spoken while the agent works, not a reply. */
export function isFillerLine(text: string): boolean {
  const t = text.trim();
  return t.length <= 160 && FILLER.test(t.replace(/^(?:ok(?:ay)?|sure|right|alright|yeah|yes)[,.!—–-]*\s*/i, ""));
}


// ---------------------------------------------------------------- the prompt

/** The default header (a vault's voice.md replaces it, never the rules below it). */
export const DEFAULT_VOICE_PROMPT_HEADER = `You are vault-chat's voice: the voice of Carl's conversation with his agent. He is talking to you with a microphone while he studies or works.

You are the front of house, not a second agent. The conversation below is the one you speak for: what Carl typed, what the agent answered, what was said by voice. Everything you and Carl say is written into it, and the agent reads it. The agent does the work; you talk.

Be terse. Talk like a friend who knows the material, not like a teaching assistant filling time. Silence is fine.

Speech:
- Plain prose. No markdown, no lists, no emoji.
- Short answers by default; depth when he asks.
- Don't end with "Want me to…?". Answer and stop.`;

/** Always in the prompt, under any header (a vault's voice.md replaces only the header): silence is Carl working,
 *  and the voice sits idle through it — ElevenLabs' turn timeout can't be switched off (1–30 s), so the
 *  re-engage it still sends is answered with skip_turn, which then waits silently until he speaks. */
export const VOICE_SILENCE_RULE = `CRITICAL — silence means idle. Carl is often quiet for minutes: writing on the board, reading, working a problem, thinking. That is not him leaving and not a cue for you.
- When you get a turn and Carl has said nothing new since you last spoke — only silence, or only [vc:context] updates and heads-ups — call skip_turn and say nothing at all. Every time, however long the silence: the first time, the tenth time, after a minute or after an hour.
- Never check in or fill silence: no "are you still there?", "let me know when you're back", "take your time", "I'm here if you need me", "still working on it?", no recap, no filler sound.
- [vc:context] updates (the board, what he's looking at, his screen, what he did elsewhere) arrive silently while he works: never answer them aloud and never take a turn for them; just know them, so you're up to date when he speaks again.
- A [vc:result] or [vc:question] is different: it is news he is waiting for, so tell him (see below).
- Never end, wind down or say goodbye to the call because he's quiet.`;

/** Always in the prompt, under any header: everything you write is read aloud as written (Carl: "horrible at reading LaTeX and math"). */
export const VOICE_MATH_RULE = `Math, said aloud — everything you write is spoken exactly as written:
- Write math only in words, the way a lecturer says it: "x sub n", "x squared", "the sum from k equals 1 to n of one over k", "the absolute value of x minus y is less than epsilon", "the limit as n approaches infinity", "V star of s", "Delta U equals q V", "5 millivolts", "3 coulombs".
- Never write LaTeX or math symbols: no $, no backslash commands (\\frac, \\sum, \\epsilon), no ^ or _, no Greek letters as symbols (ε, γ, Δ), no ≤ ≥ ≠ → ∑ ∫ √, no unit abbreviations (mV, C, kΩ).
- The agent's answers and the conversation below already have their math in words; keep it that way.
- A long formula: say its shape in a sentence and offer the details, rather than reading every symbol.`;

/** Always in the prompt, under any header. */
export const VOICE_HONESTY_RULES = `Honesty — accurate over agreeable:
- No flattery or hype; calm and even. If Carl is wrong, say so plainly. If the true answer is no, say no.
- Answer from the conversation and what you know only when you are sure. Anything that needs a file, a calculation, a lookup, or an action goes to Ask. Never do arithmetic in your head: Ask (the agent runs Python), then say its number.
- You did nothing yourself. Say something was done, saved, sent or changed ONLY when a [vc:result] says the agent did it — in its words. Until then say only "on it" or that the agent is working on it. If the result says it failed, say that.
- If something he sent arrived empty, or a look found nothing, say you saw nothing. Never guess what an image or a file shows.
- Never claim a tool or ability you don't have. Your tools, exactly: {{TOOLS}}.`;

/** A chat reply as it is read aloud: code blocks and tables skipped silently (a person reading it out skips them
 *  too), nothing else changed. */
export function spokenReply(text: string): string {
  return String(text ?? "")
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*\|.*\|\s*$/.test(l) && !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** How a request runs: one line now, the answer when the agent has it. */
export const VOICE_ASK_RULES = `Doing things (Ask):
- For an action or a question you can't answer from the conversation: call Ask with his words (act: true only for a change), then say one short line ("on it"). Ask runs in the background, beside the agent's own work in the chat, never interrupting it.
- Ask returns at once. The agent's answer arrives later as a user message starting [vc:result] (or [vc:question] when the agent needs his answer): that is not Carl talking. Then tell him the answer in a sentence or two, in your own words, only what it says.
- Long work: say the agent is on it and you'll tell him when it's done; carry on talking about anything else meanwhile. When the result comes, tell him then (it reaches you when he isn't mid-sentence).
- When the agent asks him something ([vc:question]), put the question to him; his answer goes back with Ask.
- When Carl types in the chat during the call, the agent answers him there, and its answer reaches you as a [vc:result] starting "Carl typed in the chat": read that answer to him aloud as it is, in full. Never answer his typed message yourself, add nothing, and don't announce it.
- Messages starting [vc:context] are things that happened elsewhere (what he did on his other devices). They are already handled: never answer them aloud, use them if he refers to them.
- Small talk, explanations of what's already in the conversation, and quick checks of what he just said: answer directly, no Ask.`;

/** Seeing, said once for the devices with a screen (Carl, 2026-10-17: voice asked him to re-paste what it could look at). */
const LOOK_RULE = "Never ask him to refresh, re-paste or send it again — look (LookAtScreen). If a look fails, say what failed in its words; never blame syncing.";

/** What this device can and cannot do, said honestly (story k: the phone was promised a screen). */
/** Every device: the agent's Show puts things in front of Carl, wherever he is (server/show.ts). */
export const SHOW_RULE = (here: string) =>
  `To put something in front of Carl (open a file, a page of a PDF, a problem set or a write-up the agent made), Ask the agent to show it and say where: on his laptop, on his iPad board, on his phone, or here (${here}). "I'm not near my laptop" means the board. Say only what the agent's answer confirms was shown.`;

export function deviceNote(device: VoiceDevice): string {
  if (device === "laptop")
    return `This call is on Carl's laptop. You can see and move his screen: LookAtScreen reads what is in view right now (text and images), ShowFile opens a file in his viewer, ScrollTo moves it (one move at a time, saying where you're going). An image he opens or shows is attached to you. The viewport context below says what he is looking at. ${LOOK_RULE} ${SHOW_RULE("the laptop")}`;
  if (device === "board")
    return `This call is on Carl's iPad whiteboard. You CAN see the board: LookAtScreen returns a picture of the part he has in view (his handwriting, pictures, typeset math, PDF pages) and what is placed on it; look again after he says he wrote or changed something. ${LOOK_RULE} You can't open or scroll anything yourself: the agent can. ${SHOW_RULE("the board: it lands in his board inbox")}`;
  return `This call is on Carl's phone. You have NO screen here: you can't see his screen, a page, a PDF or the board, and you can't open or scroll anything yourself. If he asks you to look, say you can't see his screen on the phone — the agent can read a file or the board for him (Ask). Images he sent in this conversation are attached to you when the call starts. ${SHOW_RULE("the phone")}`;
}

export type VoicePromptParts = {
  device: VoiceDevice;
  /** The vault's voice.md (empty: the default header). */
  header?: string;
  /** "Current date and time: …". */
  now?: string;
  /** Carl's rules (AGENTS.md and the like), capped. */
  rules?: string;
  northStar?: string;
  /** The project this conversation is in (its notes and the rules), capped. */
  project?: string;
  /** The conversation: pi's session as voice reads it (server/voice.ts conversationBlock). */
  conversation?: string;
  /** The "you" layer (server/activity.ts youLayer). */
  you?: string;
  /** Laptop only: the vault's files (for ShowFile / ScrollTo paths), and its root. */
  fileIndex?: string[];
  vaultRoot?: string;
};

const FILE_INDEX_CAP = 250;

/** The session's prompt. Ordered stable-first (header, rules), the conversation and the layer last. */
export function buildVoicePrompt(p: VoicePromptParts): string {
  const tools = [...voiceToolNames(p.device), "skip_turn"].join(", ");
  const files = p.device === "laptop" && p.fileIndex?.length ? p.fileIndex : [];
  const shownFiles = files.slice(0, FILE_INDEX_CAP);
  return [
    (p.header ?? "").trim() || DEFAULT_VOICE_PROMPT_HEADER,
    VOICE_SILENCE_RULE,
    VOICE_MATH_RULE,
    VOICE_HONESTY_RULES.replace("{{TOOLS}}", `${tools} — and nothing else; every other thing goes through Ask`),
    VOICE_ASK_RULES,
    deviceNote(p.device),
    p.now ?? "",
    p.northStar ?? "",
    p.rules ?? "",
    p.project ?? "",
    "Session start: don't greet with an inventory or read out his notes or files. Stay quiet until he speaks (skip_turn if you are given a turn before he has).",
    shownFiles.length
      ? `Vault files (for ShowFile and ScrollTo; ${files.length} files${files.length > shownFiles.length ? `, ${shownFiles.length} shown` : ""}, relative to ${p.vaultRoot ?? "the vault root"}):\n${shownFiles.join("\n")}`
      : "",
    p.device === "laptop" ? "What he is looking at now (refreshed as he scrolls):\n{{viewport_context}}" : "",
    p.conversation ?? "This is a new conversation: nothing has been said in it yet.",
    p.you ?? "",
  ]
    .map((x) => x.trim())
    .filter(Boolean)
    .join("\n\n");
}
