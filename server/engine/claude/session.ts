// One warm Claude Code session, as the host drives it.
//
// Why warm: the spike measured ~290 ms to start a session and 13–40 ms from a
// pushed message to the first token on one already running. So a live
// conversation keeps its session, and messages are pushed into its streaming
// input rather than starting a process per turn.
//
// Streaming input is also what makes vault-chat's four controls native, with no
// queue of the box's own (measured in the spike):
//   steer      push with no priority — folded into the running turn right after
//              the current tool result;
//   queue      push with priority:"later" — its own next turn;
//   take back  cancelAsyncMessage(uuid) — withdrawn if not delivered yet;
//   stop       interrupt() — returns in ~5 ms, and the session still takes input.
import { BUILTIN_TOOL_NAMES, query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";

export type SessionSend = {
  text: string;
  /** data: URLs, sent as the API's image blocks. */
  images?: string[];
  /** Our id for this message, so it can be withdrawn and matched in the result. */
  uuid?: string;
  /** "later": its own next turn (a follow-up). Absent: folded into the running turn (a steer). */
  priority?: "later" | "now";
};

export type SessionOptions = {
  /** What answers --version (server/engine/claude/install.ts). */
  cli: string;
  cwd: string;
  model: string;
  /** Appended to Claude Code's own system prompt. */
  instructions?: string;
  /** Resume this Claude Code session; absent starts a new one. */
  resume?: string;
  /** Claude Code's own config dir, kept away from Carl's ~/.claude (the spike: settingSources:[] still loads user plugins and skills). */
  configDir: string;
  env: NodeJS.ProcessEnv;
  mcpServers?: Options["mcpServers"];
  /** Tools the run may use without asking (vault-chat's MCP server). */
  allowedTools?: string[];
  /** Claude Code's built-ins we replace with vault-chat's policy-enforcing ones. */
  disallowedTools?: string[];
  settingSources?: Options["settingSources"];
  /**
   * Claude Code summarised the session: what the host wants put back into it.
   * Returning "" or nothing adds nothing.
   */
  onCompacted?: () => Promise<string>;
  /** Every SDK message, in order. */
  onMessage: (m: SDKMessage) => void;
  /** The session ended (it threw, or the CLI exited). */
  onClosed: (error: Error | null) => void;
  log?: (s: string) => void;
};

/**
 * Every Claude Code built-in is off by default, and vault-chat's own tools come
 * in as MCP (phase 4). Not only the obvious ones: Glob, Grep and WebFetch read
 * the box too, and vault-chat has one path policy — realpath and deny rules,
 * the voice write gate, live edits — which only its own tools enforce. Agent,
 * Skill, Cron*, Worktree* and the rest would put state outside the host's
 * reach as well. Phase 4 decides which of these come back once the tool
 * surface is bound (Carl's decision: Claude Code's subagents replace
 * vault-chat's workers).
 */
export const CLAUDE_BUILTINS_OFF: readonly string[] = BUILTIN_TOOL_NAMES;

export class ClaudeSession {
  /** Claude Code's session id, known from the first message; `resume` uses it next time. */
  sessionId: string | null = null;
  /** It is not taking input any more (it threw, or close() was called). */
  closed = false;
  private q: Query | null = null;
  private buf: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ending = false;
  private pump: Promise<void> | null = null;

  constructor(private readonly o: SessionOptions) {}

  /** Start the CLI and begin reading its messages. Resolves once it is reading (not when the turn ends). */
  start(): void {
    if (this.q) return;
    this.sessionId = this.o.resume ?? null;
    const options: Options = {
      pathToClaudeCodeExecutable: this.o.cli,
      cwd: this.o.cwd,
      model: this.o.model,
      includePartialMessages: true,
      env: this.o.env,
      // Claude Code's own prompt, then vault-chat's layer on top of it.
      ...(this.o.instructions ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: this.o.instructions } } : {}),
      ...(this.o.resume ? { resume: this.o.resume } : {}),
      ...(this.o.mcpServers ? { mcpServers: this.o.mcpServers } : {}),
      ...(this.o.allowedTools ? { allowedTools: this.o.allowedTools } : {}),
      disallowedTools: [...(this.o.disallowedTools ?? CLAUDE_BUILTINS_OFF)],
      settingSources: this.o.settingSources ?? [],
      // Its own memory is off: vault-chat's memory files are the only memory.
      settings: JSON.stringify({ autoMemoryEnabled: false }),
      // A summary may not have kept what the host had told the thread. This puts
      // it back into the compacted session, so the turn in flight keeps its
      // footing rather than waiting for the next prompt to say it again.
      ...(this.o.onCompacted
        ? {
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    async (input) => {
                      // A session starts for several reasons; only a summary loses context.
                      if ((input as { source?: string }).source !== "compact") return {};
                      const additionalContext = (await this.o.onCompacted!().catch(() => "")) || "";
                      return additionalContext
                        ? { hookSpecificOutput: { hookEventName: "SessionStart" as const, additionalContext } }
                        : {};
                    },
                  ],
                },
              ],
            },
          }
        : {}),
    };
    const q = (this.q = query({ prompt: this.input(), options }));
    this.pump = this.read(q);
  }

  /** The streaming input the CLI reads: everything send() pushes, in order. */
  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.buf.length) yield this.buf.shift()!;
      if (this.ending) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }

  private async read(q: Query): Promise<void> {
    let error: Error | null = null;
    try {
      for await (const m of q) {
        if (!this.sessionId && typeof (m as any).session_id === "string") this.sessionId = (m as any).session_id;
        try {
          this.o.onMessage(m);
        } catch (e) {
          this.o.log?.(`claude session ${this.sessionId}: handling ${m.type} failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      // maxTurns exhaustion and a CLI that dies both arrive here (the iterator throws).
      error = e as Error;
    } finally {
      this.closed = true;
      this.o.onClosed(error);
    }
  }

  /**
   * Push a message. It is folded into the running turn, or queued as its own,
   * by `priority`. Throws on a session that has ended, rather than swallowing
   * the message: a caller that is waiting to show it as delivered has to know.
   */
  send(s: SessionSend): string {
    if (this.closed || this.ending) throw new Error("this Claude Code session has ended");
    const uuid = s.uuid ?? randomUUID();
    const content: SDKUserMessage["message"]["content"] = s.images?.length
      ? [{ type: "text", text: s.text }, ...s.images.map(imageBlock).filter(Boolean) as any[]]
      : s.text;
    this.buf.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
      uuid: uuid as SDKUserMessage["uuid"],
      ...(s.priority ? { priority: s.priority } : {}),
    } as SDKUserMessage);
    this.wake?.();
    return uuid;
  }

  /** Withdraw a pushed message the CLI has not delivered yet. */
  async withdraw(uuid: string): Promise<boolean> {
    // Not in the typings yet; the spike measured it working.
    const cancel = (this.q as unknown as { cancelAsyncMessage?: (u: string) => Promise<boolean> } | null)?.cancelAsyncMessage;
    if (!cancel || !this.q) {
      // Still in our own buffer: never sent, so dropping it is the withdrawal.
      return this.drop(uuid);
    }
    if (this.drop(uuid)) return true;
    try {
      return !!(await cancel.call(this.q, uuid));
    } catch {
      return false;
    }
  }

  private drop(uuid: string): boolean {
    const i = this.buf.findIndex((m) => m.uuid === uuid);
    if (i < 0) return false;
    this.buf.splice(i, 1);
    return true;
  }

  /** Stop the running turn. The session keeps taking input. */
  async interrupt(): Promise<void> {
    await this.q?.interrupt().catch(() => undefined);
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model).catch(() => undefined);
  }

  /** Replace the MCP servers this session can reach, without restarting it. */
  async setMcpServers(servers: Record<string, unknown>): Promise<void> {
    const set = (this.q as unknown as { setMcpServers?: (s: Record<string, unknown>) => Promise<unknown> } | null)?.setMcpServers;
    if (set && this.q) await set.call(this.q, servers).catch(() => undefined);
  }

  /** End the session (the conversation keeps its id, so the next turn resumes it). */
  close(): void {
    this.ending = true;
    this.closed = true;
    this.buf.length = 0;
    this.wake?.();
    try {
      (this.q as unknown as { close?: () => void } | null)?.close?.();
    } catch {
      /* already gone */
    }
    this.q = null;
  }

  /** Resolves once the CLI's messages are exhausted (tests; shutdown). */
  async finished(): Promise<void> {
    await this.pump;
  }
}

/** A data: URL as the API's image block; null if it is not one we can send. */
function imageBlock(url: string): { type: "image"; source: { type: "base64"; media_type: string; data: string } } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!m) return null;
  return { type: "image", source: { type: "base64", media_type: m[1]!, data: m[2]! } };
}
