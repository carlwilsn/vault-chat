// Only vault-chat's own native pi namespace has legacy UI/tool semantics.
// Never strip another MCP server's prefix (e.g. its AskUser is not ours).
export const hostToolName = (name: string | undefined): string => {
  const value = name ?? "";
  return value.startsWith("mcp__vault_chat__") ? value.slice("mcp__vault_chat__".length) : value;
};
