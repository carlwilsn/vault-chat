// A transport adapter, not a tool registry or an agent. The caller binds authority
// (vault, conversation/thread, device and allowed tools) before creating this server.
// The existing ToolSpecs and handlers remain the only definitions/implementations.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnswer, ToolSpec } from "../engine/pi/backend";

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
};

/** Use the SDK's low-level Server because our authoritative definitions already
 * are JSON Schema. Rewriting them as Zod would create a second definition. The
 * SDK owns negotiation, protocol validation, cancellation and transport framing. */
export function createToolServer(binding: BoundTools, version: string): Server {
  const validator = new AjvJsonSchemaValidator();
  const tools = new Map<string, { spec: Tool; validate: ReturnType<typeof validator.getValidator<Record<string, unknown>>> }>();
  for (const source of binding.specs) {
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
  const server = new Server({ name: "vault-chat", version }, {
    capabilities: { tools: {}, ...(binding.readResource ? { resources: {} } : {}) },
    instructions: "Carl's vault-chat tools. Tools act only within the authority bound by the host to this connection/request.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools.values()].map((t) => structuredClone(t.spec)) }));
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
  return server;
}
