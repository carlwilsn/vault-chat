// Claude Code's sign-in is the box's credential for RUNNING the engine, not a
// service the agent calls. It is kept with the box's other keys, but it must
// never reach anything the agent runs — that exclusion is the whole point, so
// it is checked here rather than assumed.
import { describe, it, expect, beforeAll } from "vitest";
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
}

  it("the push to the box carries it, because a key left out of that push is DELETED there", async () => {
    // saveKeys makes the box's store EXACTLY what was pushed (server/keys.ts), so
    // laptopKeys() omitting a name is not a no-op — it removes it from the box.
    // That is the whole hazard, so it is pinned here.
    await import("../shims/globals");
    const { useStore } = await import("../../src/store");
    const { laptopKeys } = await import("../../src/boxKeys");
    useStore.setState({
      apiKeys: { openrouter: "sk-or-real" },
      serviceKeys: { elevenlabs: "sk_eleven", claudeCode: TOKEN },
    } as never);
    const pushed = await laptopKeys();
    expect(pushed[KEY.claudeCode]).toBe(TOKEN);
    expect(pushed[KEY.openrouter]).toBe("sk-or-real");
    expect(pushed[KEY.elevenlabs]).toBe("sk_eleven");

    // And with no sign-in there is simply no entry, rather than an empty one that
    // would overwrite a token the box already has.
    useStore.setState({ serviceKeys: { elevenlabs: "sk_eleven" } } as never);
    expect(KEY.claudeCode in (await laptopKeys())).toBe(false);
  });
});

describe("the models Claude Code runs", () => {
  it("accepts its aliases as well as an OpenRouter path, and nothing else", async () => {
    const { isClaudeModel, validModel } = await import("../engine/claude/models");
    for (const m of ["opus", "sonnet", "haiku", "claude-opus-5", "claude-haiku-5-5"]) {
      expect(isClaudeModel(m), m).toBe(true);
      expect(validModel(m), m).toBe(true);
    }
    expect(validModel("openai/gpt-6.1-sol")).toBe(true);
    expect(isClaudeModel("openai/gpt-6.1-sol")).toBe(false);
    for (const m of ["", "not a model", "opus/extra", "sonnet!"]) expect(validModel(m), m).toBe(false);
  });

  it("knows one of its models can see, so a picture is never sent to the OpenRouter vision model instead", async () => {
    const { capabilitiesOf } = await import("../engine/capabilities");
    // A Claude model is not in the OpenRouter catalog, and reading it as a model
    // that cannot see is what would quietly reroute every turn carrying an image.
    for (const m of ["opus", "sonnet", "haiku"]) {
      expect(capabilitiesOf(m), m).toMatchObject({ images: true, tools: true, subagents: true, pdf: true });
    }
    // An unknown non-Claude model still reads as it did.
    expect(capabilitiesOf("nobody/nothing").images).toBe(false);
  });
});
