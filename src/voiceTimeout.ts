// When ElevenLabs closes a voice call because the model took too long
// ("LLM Cascade Error: TimeoutError", close code 1002: the chosen model and
// every backup missed the cascade timeout), the call reconnects once on its
// own, with a short recap, instead of dropping Carl. Only when that retry
// fails too does a line say so — in plain English, never the raw error.
//
// And the evidence for the next one: each turn's time to the agent's first
// response (audio, text or a tool call), what the session holds so far (its
// transcript and tool results in characters, its images), logged per turn.

/** A close that means "every model in the cascade timed out" (not a hang-up, not a refused config). */
export function isLlmTimeoutClose(d?: { reason?: string; message?: string; closeCode?: number; closeReason?: string }): boolean {
  if (!d || d.reason === "user") return false;
  const text = `${d.message ?? ""} ${d.closeReason ?? ""}`;
  return /LLM Cascade Error|TimeoutError|timed? ?out/i.test(text);
}

export const RECONNECTING_LINE = "The voice model took too long to answer — reconnecting.";

/** The one line when the retry failed too: what happened, in words. */
export function couldntReconnectLine(why: string): string {
  const w = why.trim().replace(/\.$/, "");
  return `The voice model took too long to answer, and the call couldn't reconnect: ${w || "no reason given"}.`;
}

/** The reason a retried call failed again, in words (never the raw cascade error). */
export function plainCloseReason(d?: { message?: string; closeReason?: string; closeCode?: number }): string {
  if (isLlmTimeoutClose(d)) return "the model timed out again";
  return [d?.message, d?.closeReason].filter(Boolean).join(" — ") || (d?.closeCode !== undefined ? `closed with code ${d.closeCode}` : "the connection closed");
}

/** What the reconnected agent is told: the call dropped mid-request, the last lines, carry on in small steps. */
export function reconnectRecap(lines: { role: string; content: string; system?: boolean }[]): string {
  const said = lines.filter((m) => !m.system && (m.role === "user" || m.role === "assistant") && m.content.trim());
  const lastUser = [...said].reverse().find((m) => m.role === "user");
  const tail = said.slice(-4).map((m) => `${m.role === "user" ? "User" : "You"}: ${clip(m.content.trim(), 300)}`);
  return [
    "This call just reconnected: on the previous connection the voice model took too long to answer and the call dropped.",
    lastUser ? `The user's last request: "${clip(lastUser.content.trim(), 500)}"` : "",
    tail.length ? `The last lines before the drop:\n${tail.join("\n")}` : "",
    "Don't greet and don't apologise at length. Carry on with that request if it isn't done (check the file first if you changed one); if it is done, say so in one line. Work in small steps: several short Edits rather than one big Write, or hand a large rewrite to AskAgent.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The user turn that makes the reconnected agent pick the request back up (never shown in the thread). */
export const RECONNECT_NUDGE = "(The call dropped and reconnected. Carry on with what I asked last; if it's already done, just say so.)";

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** One retry per incident: a second timeout soon after a retry gives up; one long after is a new incident. */
export class TimeoutRetry {
  private lastRetryAt = -Infinity;
  constructor(private readonly freshAfterMs = 120_000) {}
  /** Whether this timeout close may reconnect (and, if so, counts it). */
  take(now = Date.now()): boolean {
    if (now - this.lastRetryAt < this.freshAfterMs) return false;
    this.lastRetryAt = now;
    return true;
  }
  /** A deliberate end (the user hung up): the next timeout is a new incident. */
  reset(): void {
    this.lastRetryAt = -Infinity;
  }
}

/** Per-turn timings and the session's size, for the log. A turn starts when
 *  Carl stopped speaking (the last moment his mic was above speech level), not
 *  when ElevenLabs' final transcript lands: that arrives with the reply already
 *  under way, so timing from it read 12–61 ms. It ends at the first agent audio
 *  actually playing (the output level, not a chunk's arrival); a reply that
 *  never plays is logged too, with firstAudioMs null — "waves but silence". */
export class VoiceTurnStats {
  /** Characters the ElevenLabs conversation holds beyond the prompt: transcript lines and tool results. */
  sessionChars = 0;
  images = 0;
  turns = 0;
  promptChars = 0;
  private turnStart: number | null = null;
  private transcriptAt = 0;
  private fromSpeech = false;
  private first: { via: string; at: number } | null = null;
  private filler = false;
  private lastTool: string | null = null;

  startSession(promptChars: number): void {
    this.sessionChars = 0;
    this.images = 0;
    this.turns = 0;
    this.promptChars = promptChars;
    this.turnStart = null;
    this.first = null;
    this.filler = false;
    this.lastTool = null;
  }
  /** Carl's final transcript; `speechEndedAt` when the mic level says when he stopped. */
  userTurn(text: string, now = Date.now(), speechEndedAt?: number | null): void {
    this.sessionChars += text.length;
    this.turns++;
    this.fromSpeech = typeof speechEndedAt === "number" && speechEndedAt <= now;
    this.turnStart = this.fromSpeech ? (speechEndedAt as number) : now;
    this.transcriptAt = now;
    this.first = null;
    this.filler = false;
    this.lastTool = null;
  }
  /** The filler ("One sec.") the platform speaks when the model is slow: noted, not a response. */
  fillerSpoken(): void {
    this.filler = true;
  }
  addImages(n: number): void {
    this.images += n;
  }
  toolResult(name: string, chars: number): void {
    this.sessionChars += chars;
    this.lastTool = name;
  }
  /** The agent's first response to the turn (a line, a tool call): noted once a turn; the turn is logged when audio plays. */
  firstResponse(via: string, now = Date.now(), extraChars = 0): null {
    this.sessionChars += extraChars;
    if (this.turnStart !== null && !this.first) this.first = { via, at: now };
    return null;
  }
  /** The agent's audio is audibly playing (output level up): the turn's line, once. */
  audioPlaying(now = Date.now()): Record<string, unknown> | null {
    if (this.turnStart === null) return null;
    return this.close(now);
  }
  /** No audio played `afterMs` after the transcript: the turn's line with firstAudioMs null, once. */
  noAudio(now = Date.now(), afterMs = 20_000): Record<string, unknown> | null {
    if (this.turnStart === null || now - this.transcriptAt < afterMs) return null;
    return this.close(null);
  }
  private close(audioAt: number | null): Record<string, unknown> {
    const start = this.turnStart as number;
    const first = this.first ?? (audioAt !== null ? { via: "audio", at: audioAt } : null);
    this.turnStart = null;
    return {
      turn: this.turns,
      firstResponseMs: first ? Math.max(0, first.at - start) : null,
      via: first?.via ?? "none",
      firstAudioMs: audioAt === null ? null : Math.max(0, audioAt - start),
      transcriptToAudioMs: audioAt === null ? null : audioAt - this.transcriptAt,
      from: this.fromSpeech ? "speech-end" : "transcript",
      filler: this.filler,
      ...this.size(),
    };
  }
  /** At a close: how long the open turn had waited, and its last tool. */
  atClose(now = Date.now()): Record<string, unknown> {
    return { turn: this.turns, waitingMs: this.turnStart === null ? null : now - this.turnStart, filler: this.filler, lastTool: this.lastTool, ...this.size() };
  }
  /** The estimated context per turn: the prompt plus what the conversation accumulated, and its images. */
  size(): { promptChars: number; sessionChars: number; estTokens: number; images: number } {
    return {
      promptChars: this.promptChars,
      sessionChars: this.sessionChars,
      estTokens: Math.round((this.promptChars + this.sessionChars) / 4),
      images: this.images,
    };
  }
}
