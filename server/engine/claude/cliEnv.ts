// The environment Claude Code runs in. Its Bash tool, Delegate workers and
// subagents all inherit it, so this is where Carl's saved keys (src/keyEnv.ts
// names: ELEVENLABS_API_KEY, TAVILY_API_KEY, ...) reach the agent's shell.
// Values go only into the child's environment, never a log or an event.

export interface CliEnvInput {
  /** process.env of the server (deployment overrides). */
  processEnv: NodeJS.ProcessEnv;
  configDir: string;
  /** Claude Code's own sign-in token, or null. */
  token: string | null;
  /** agentKeyEnv(): every saved key under its documented variable name. */
  keys: Record<string, string>;
}

export function claudeCliEnv(i: CliEnvInput): NodeJS.ProcessEnv {
  const keys = { ...i.keys };
  // A saved Anthropic API key would make Claude Code bill that key instead of
  // Carl's subscription sign-in (the API key takes precedence), so with a
  // sign-in present it stays out of the CLI's env (StartJob jobs still get it).
  if (i.token) delete keys.ANTHROPIC_API_KEY;
  return {
    // Re-read at every session start: a key saved since reaches the next session.
    ...keys,
    PATH: i.processEnv.PATH ?? "/run/current-system/sw/bin",
    HOME: i.configDir,
    // Claude Code's config and credentials. vault-chat keeps its own, so a
    // session never sees Carl's plugins, skills or agents; VC_CLAUDE_CONFIG_DIR
    // points it at an existing Claude Code login instead.
    CLAUDE_CONFIG_DIR: i.processEnv.VC_CLAUDE_CONFIG_DIR || i.configDir,
    // Carl's Claude subscription: for the CLI only (not in agentKeyEnv).
    ...(i.token ? { CLAUDE_CODE_OAUTH_TOKEN: i.token } : {}),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    // An MCP call that waits on Carl (AskUser) is not idle.
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
    // A deployment pointing the CLI at another endpoint names it and its key together.
    ...(i.processEnv.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: i.processEnv.ANTHROPIC_BASE_URL } : {}),
    ...(i.processEnv.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: i.processEnv.ANTHROPIC_API_KEY } : {}),
  };
}
