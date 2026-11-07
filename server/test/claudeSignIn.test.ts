// Claude Code's sign-in is the box's credential for RUNNING the engine, not a
// service the agent calls. It is kept with the box's other keys, but it must
// never reach anything the agent runs — that exclusion is the whole point, so
// it is checked here rather than assumed.
import { describe, it, expect } from "vitest";
import { KEY } from "../../src/keychain";
import { NOT_FOR_COMMANDS, envNameForKey, keyEnv } from "../../src/keyEnv";

const TOKEN = "sk-ant-oat-not-a-real-token-4242";

describe("Claude Code's sign-in", () => {
  it("is the keychain name the laptop and the box agree on", () => {
    expect(KEY.claudeCode).toBe("service.claude-code");
    expect(NOT_FOR_COMMANDS.has(KEY.claudeCode)).toBe(true);
  });

  it("has no environment variable, so no command the agent runs can see it", () => {
    expect(envNameForKey(KEY.claudeCode)).toBeNull();
    const env = keyEnv([
      ["api.openrouter", "sk-or-real"],
      [KEY.claudeCode, TOKEN],
      ["service.elevenlabs", "sk_eleven"],
    ]);
    // The keys that ARE the agent's are there…
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-real");
    expect(env.ELEVENLABS_API_KEY).toBe("sk_eleven");
    // …and the sign-in is nowhere in it, under any name.
    expect(Object.keys(env)).not.toContain("CLAUDE_CODE_API_KEY");
    expect(Object.keys(env)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });

  it("a name that merely looks like it is still the agent's", () => {
    // The exclusion is one exact name, not a prefix match: a key Carl adds for
    // the agent to use is not silently withheld from it.
    expect(envNameForKey("service.claude-code-notes")).toBe("CLAUDE_CODE_NOTES_API_KEY");
    expect(envNameForKey("user.claude_code")).toBe("CLAUDE_CODE");
  });
});
