// A transport adapter, not a tool registry or an agent. The caller binds authority
// (vault, conversation/thread, device and allowed tools) before creating this server.
// The existing ToolSpecs and handlers remain the only definitions/implementations.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnswer, ToolSpec } from "../engine/backend";

export type McpCallContext = {
  signal: AbortSignal;
  /** MCP request id, NOT pi's model tool-call id. Never use it as a chat item id. */
  requestId: string | number;
  /** Cumulative preview, not a delta. Absent when the client did not request progress. */
  progress?: (message: string) => Promise<void>;
};

/** Trusted, request-local authority, created by the host, never from tools/call
 * arguments, clientInfo, roots, or _meta. A restricted client receives only its
 * allowed specs, and execution enforces that same list. No ambient main vault. */
export type BoundTools = {
  specs: readonly ToolSpec[];
  resources?: { uri: string; name: string; mimeType: string }[];
  readResource?: (uri: string) => Promise<string>;
  call: (name: string, args: Record<string, unknown>, context: McpCallContext) => Promise<ToolAnswer>;
  /**
   * The catalog as it is NOW, for a binding whose tools can change while its
   * client stays connected (a vault tool written in .vault-chat/tools, a host
   * catalog that changed): read at every tools/list and after every call. When
   * it differs from what was listed, the client is told (tools/list_changed) on
   * the call's own response stream, so a running session never keeps a stale
   * schema and a tool the agent just made is callable in the same turn. Same
   * validation as `specs`; a catalog that fails it keeps the last good one.
   */
  current?: () => Promise<readonly ToolSpec[]>;
};

/** Use the SDK's low-level Server because our authoritative definitions already
 * are JSON Schema. Rewriting them as Zod would create a second definition. The
 * SDK owns negotiation, protocol validation, cancellation and transport framing. */
/** How long a call's result waits for the client to read a changed catalog (a client that never does is not held). */
const RELIST_WAIT_MS = 3_000;

declare const ajv: AjvJsonSchemaValidator;
type Compiled = Map<string, { spec: Tool; validate: ReturnType<typeof ajv.getValidator<Record<string, unknown>>> }>;

/** Compile specs into the listed tools and their validators; throws on a name or schema that fails closed. */
function compile(specs: readonly ToolSpec[], validator: AjvJsonSchemaValidator): Compiled {
  const tools: Compiled = new Map();
  for (const source of specs) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source.name) || tools.has(source.name)) throw new Error(`Invalid or duplicate MCP tool: ${source.name}`);
    if (source.inputSchema.type !== "object") throw new Error(`MCP tool ${source.name} must have an object input schema`);
    const inputSchema = structuredClone(source.inputSchema) as Tool["inputSchema"];
    tools.set(source.name, {
      spec: {
        name: source.name,
        description: source.description,
        inputSchema,
        ...(source.readOnly === true ? { annotations: { readOnlyHint: true } } : {}),
      },
      validate: validator.getValidator<Record<string, unknown>>(inputSchema),
    });
  }
  return tools;
}

/** Use the SDK's low-level Server because our authoritative definitions already
 * are JSON Schema. Rewriting them as Zod would create a second definition. The
 * SDK owns negotiation, protocol validation, cancellation and transport framing. */
export type ToolServer = Server & {
  /**
   * Read the catalog again outside any call (a turn starting, a tool of the
   * runtime's own that may have written a vault tool); when it changed, tell the
   * client on its standalone stream and wait (briefly) until it has listed
   * again. True when it changed.
   */
  refreshTools: () => Promise<boolean>;
};

export function createToolServer(binding: BoundTools, version: string): ToolServer {
  const validator = new AjvJsonSchemaValidator();
  let tools = compile(binding.specs, validator);
  let listed = JSON.stringify([...tools.values()].map((t) => t.spec));
  /** Re-read the catalog; true when it changed since it was last read. Never throws. */
  const refresh = async (): Promise<boolean> => {
    if (!binding.current) return false;
    try {
      const next = compile(await binding.current(), validator);
      const key = JSON.stringify([...next.values()].map((t) => t.spec));
      if (key === listed) return false;
      tools = next;
      listed = key;
      return true;
    } catch (error) {
      console.error(`[mcp] tool catalog kept as it was: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  };
  const server = new Server({ name: "vault-chat", version }, {
    capabilities: { tools: binding.current ? { listChanged: true } : {}, ...(binding.readResource ? { resources: {} } : {}) },
    instructions: "Carl's vault-chat tools. Tools act only within the authority bound by the host to this connection/request.",
  });
  // Calls waiting for the client to have read the changed catalog (below).
  let relisted: (() => void)[] = [];
  /** Tell the client its list changed (on a call's own stream, or the session's) and wait until it lists again. */
  const announce = async (send: () => Promise<void>): Promise<void> => {
    const listedAgain = new Promise<void>((done) => {
      relisted.push(done);
      setTimeout(done, RELIST_WAIT_MS).unref?.();
    });
    await send().then(() => listedAgain, () => {});
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await refresh();
    const waiting = relisted;
    relisted = [];
    // Released just after this answer is on its way, not before it is sent.
    if (waiting.length) setTimeout(() => waiting.forEach((done) => done()), 100).unref?.();
    return { tools: [...tools.values()].map((t) => structuredClone(t.spec)) };
  });
  if (binding.readResource) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: binding.resources ?? [] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const resource = binding.resources?.find((r) => r.uri === request.params.uri);
      if (!resource) throw new McpError(ErrorCode.InvalidParams, "Resource unavailable in this scope");
      return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await binding.readResource!(resource.uri) }] };
    });
  }
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name;
    // A tool made since the client last listed: read the catalog again before refusing it.
    let changed = !tools.has(name) && (await refresh());
    const tool = tools.get(name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Tool not available in this scope: ${name}`);
    const checked = tool.validate(request.params.arguments ?? {});
    if (!checked.valid) throw new McpError(ErrorCode.InvalidParams, `${name}: ${checked.errorMessage}`);
    const token = request.params._meta?.progressToken;
    let sends = Promise.resolve();
    let sequence = 0;
    let finished = false;
    const progress = token === undefined ? undefined : (message: string) => {
      if (finished || extra.signal.aborted) return Promise.resolve();
      const progress = ++sequence;
      // Request-local ordering, including fire-and-forget host callbacks. Drain
      // before returning the result; never send previews after cancellation.
      sends = sends.then(async () => {
        if (!extra.signal.aborted) await extra.sendNotification({
          method: "notifications/progress", params: { progressToken: token, progress, message },
        });
      });
      // Attach a rejection handler immediately even if the host ignores it.
      void sends.catch(() => {});
      return sends;
    };
    try {
      extra.signal.throwIfAborted();
      const answer = await binding.call(name, checked.data, { signal: extra.signal, requestId: extra.requestId, progress });
      finished = true;
      await sends;
      // The call may have changed the catalog (it wrote a vault tool): say so on
      // this request's own stream, which is open now, and hold its result until
      // the client has listed again, so the model's very next step has the tool.
      if (((await refresh()) || changed) && !extra.signal.aborted) {
        changed = false;
        await announce(() => extra.sendNotification({ method: "notifications/tools/list_changed" }));
      }
      return {
        content: [
          { type: "text", text: answer.text },
          ...(answer.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
          ...(answer.resources ?? []).map((resource) => ({ type: "resource" as const, resource })),
        ],
        ...(answer.ok ? {} : { isError: true }),
      };
    } catch (error) {
      finished = true;
      await sends.catch(() => {});
      return { isError: true, content: [{ type: "text", text: `${name} failed: ${error instanceof Error ? error.message : "unknown failure"}` }] };
    }
  });
  return Object.assign(server, {
    refreshTools: async () => {
      if (!(await refresh())) return false;
      await announce(() => server.sendToolListChanged());
      return true;
    },
  });
}
