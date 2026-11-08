// TEST ONLY: a scripted stand-in for the Anthropic Messages API, so a test can
// drive the real Claude Code CLI with fixed replies and no network, model or
// key. It speaks only what the CLI needs: streaming /v1/messages and
// /v1/messages/count_tokens.
//
// The script is written in the prompt: `CALL <tool> <json>` makes the reply a
// tool call; anything else gets a plain text reply naming what it last saw, so
// a test can tell which message a turn was answering.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One scripted answer: a tool call to make, the text to say, or the connection
 * dropped mid-request. Deliberately the same shape the OpenRouter fake took
 * (server/test/helpers.ts), because that is how every engine test in this
 * suite already writes a turn.
 */
export type ScriptStep = {
  text?: string;
  toolCall?: { name: string; args?: any; arguments?: any };
  /** The same thing under the name the fake provider's steps used. */
  call?: { name: string; args?: any };
  drop?: boolean;
  /** Answer with this HTTP status instead (a provider error). */
  status?: number;
  body?: string;
  /** Wait this long before answering. */
  delayMs?: number;
};

export type FakeApi = {
  url: string;
  /** Every request body the CLI sent, in order. */
  requests: any[];
  /**
   * The turns' own calls, in order — the ones a test means by "the model call".
   * Claude Code also asks for things of its own around a turn (a title for the
   * session, with no tools and none of the turn's history); those are in
   * `requests` but never here, and never take a scripted answer.
   */
  calls: any[];
  close: () => Promise<void>;
  /**
   * Answers to give, one per request, before the prompt's own CALL directives
   * are read. A test that wants to say "then it calls this tool, then it says
   * this" pushes them here, which is how the engine tests have always written
   * a turn (it was the OpenRouter fake's `script`).
   */
  script: ScriptStep[];
  /**
   * Text to answer with when the script is empty, for a test that only wants a
   * turn to say one fixed thing. Left null, the reply instead names the message
   * it answered (`REPLY to: ...`), so a test can tell the turns apart.
   */
  reply: string | null;
  /**
   * Asked what to answer when the script is empty: the same hook the fake
   * provider had, so a test that decides from the prompt keeps reading like one.
   */
  respond: ((body: any, n: number) => ScriptStep | null | Promise<ScriptStep | null>) | null;
  /**
   * While true every turn's request has its connection dropped before any
   * answer — the endpoint going away, which the runtime retries on its own.
   * (A single `{ drop: true }` script step drops one request.)
   */
  drop: boolean;
};

const textOf = (c: any): string => (typeof c === "string" ? c : (c ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n"));
/**
 * The host wraps its own context around Carl's words — the sections it sends,
 * and the "you" layer, which quotes what he did elsewhere and can therefore
 * quote an earlier test's directive. A directive is Carl's, so only his part of
 * the message is read: the host's wrappers are stripped first, and a directive
 * must start its own line.
 */
const asked = (c: any): string =>
  textOf(c)
    .replace(/<(you|vault-files|rules|memory|project|earlier_conversation)>[\s\S]*?<\/\1>/g, " ")
    .split("\n")
    .filter((l) => !/^\s*</.test(l))
    .join("\n");
const DIRECTIVE = /^[ \t]*CALL (\S+) (\{.*\})[ \t]*$/m;
const DIRECTIVES = /^[ \t]*CALL \S+ \{.*\}[ \t]*$/gm;
const isToolResult = (m: any) => m?.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b?.type === "tool_result");

/**
 * A script names a logical tool ("Show"); what the model must answer with is the
 * name actually declared in this request, which for a vault-chat tool is its
 * MCP name. The OpenRouter fake did the same translation.
 */
function toolName(body: any, name: string): string {
  const declared = (body.tools ?? []).map((t: any) => t?.name).filter(Boolean) as string[];
  if (declared.includes(name)) return name;
  return declared.find((d) => d === `mcp__vault_chat__${name}` || d.endsWith(`__${name}`)) ?? name;
}

/** Carl asked for a slow turn ([slow] in the message this request is answering). */
function slowAsked(body: any): boolean {
  const msgs: any[] = body.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user" && !isToolResult(m));
  return /\[slow\]/.test(asked(lastUser?.content));
}

/** The reply this request should get: a tool call the prompt asked for, or text. */
function decide(body: any): { tool?: { name: string; input: any }; text?: string } {
  const msgs: any[] = body.messages ?? [];
  const hasTools = (body.tools ?? []).length > 0;
  // The last real (non tool-result) user message that carries a CALL directive.
  let di = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user" || isToolResult(m)) continue;
    if (DIRECTIVE.test(asked(m.content))) {
      di = i;
      break;
    }
    if (asked(m.content).trim()) break;
  }
  if (hasTools && di >= 0) {
    const steps = asked(msgs[di].content).match(DIRECTIVES) ?? [];
    const done = msgs.slice(di + 1).filter((m) => m.role === "assistant" && (m.content ?? []).some?.((b: any) => b.type === "tool_use")).length;
    if (done < steps.length) {
      const m = DIRECTIVE.exec(steps[done]!)!;
      return { tool: { name: m[1]!, input: JSON.parse(m[2]!) } };
    }
  }
  const lastUser = [...msgs].reverse().find((m) => m.role === "user" && !isToolResult(m));
  const words = asked(lastUser?.content).split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return { text: `REPLY to: ${words.slice(-120)}` };
}

export async function fakeAnthropic(opts: string | { delayMs?: number; reply?: string } = {}): Promise<FakeApi> {
  const o = typeof opts === "string" ? { reply: opts } : opts;
  const requests: any[] = [];
  const calls: any[] = [];
  const script: ScriptStep[] = [];
  const state: { reply: string | null; drop: boolean; respond: FakeApi["respond"] } = { reply: o.reply ?? null, drop: false, respond: null };
  let n = 0;
  const srv: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      let body: any = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* not JSON */
      }
      if (req.url?.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"input_tokens":42}');
      }
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end("{}");
      }
      const id = ++n;
      requests.push(body);
      // A turn always carries the host's tools; Claude Code's own side calls
      // (the session title) carry none and are not what a script answers.
      const isTurn = (body.tools ?? []).length > 0;
      if (isTurn) calls.push(body);
      // Every turn request failing, for as long as a test wants.
      if (isTurn && state.drop) return req.socket.destroy();
      // A pushed answer first, then the test's own hook, then the prompt's own directives.
      const step = isTurn ? (script.shift() ?? (await state.respond?.(body, calls.length)) ?? undefined) : undefined;
      // The real endpoint going away mid-request (the box reports "Connection error.").
      if (step?.drop) return req.socket.destroy();
      if (step?.status) {
        res.writeHead(step.status, { "content-type": "application/json" });
        return res.end(step.body ?? "{}");
      }
      if (step?.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      if (step?.text !== undefined) state.reply = step.text;
      const tool = step?.toolCall ?? (step?.call ? { name: step.call.name, args: step.call.args } : undefined);
      const d = tool
        ? { tool: { name: toolName(body, tool.name), input: (tool as any).args ?? (tool as any).arguments ?? {} } }
        : step?.text !== undefined
          ? { text: step.text }
          : state.reply !== null
            ? { text: state.reply }
            : decide(body);
      const usage = { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": `req_fake${id}` });
      const ev = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id: `msg_fake${id}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      if (d.tool) {
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_fake${id}`, name: d.tool.name, input: {} } });
        ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(d.tool.input) } });
      } else {
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
        // A turn a test needs to catch in flight (to steer it, stop it, or kill
        // the box while it talks) says [slow]: the same reply, a letter at a
        // time, which is how the fake runtime did it.
        if (isTurn && slowAsked(body)) {
          for (const ch of String(d.text ?? "")) {
            if (res.writableEnded || res.destroyed) return;
            ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: ch } });
            await new Promise((r) => setTimeout(r, 600));
          }
        } else {
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: d.text } });
        }
      }
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: d.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    calls,
    script,
    get reply() {
      return state.reply;
    },
    set reply(v: string | null) {
      state.reply = v;
    },
    get respond() {
      return state.respond;
    },
    set respond(v: FakeApi["respond"]) {
      state.respond = v;
    },
    get drop() {
      return state.drop;
    },
    set drop(v: boolean) {
      state.drop = v;
    },
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}
