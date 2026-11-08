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
      ["api.anthropic", "sk-ant-api-real"],
      [KEY.claudeCode, TOKEN],
      ["service.elevenlabs", "sk_eleven"],
    ]);
    // The keys that ARE the agent's are there…
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api-real");
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

  it("the push to the box carries it, because a key left out of that push is DELETED there", async () => {
    // saveKeys makes the box's store EXACTLY what was pushed (server/keys.ts), so
    // laptopKeys() omitting a name is not a no-op — it removes it from the box.
    // That is the whole hazard, so it is pinned here.
    await import("../shims/globals");
    const { useStore } = await import("../../src/store");
    const { laptopKeys } = await import("../../src/boxKeys");
    useStore.setState({
      apiKeys: { anthropic: "sk-ant-api-real" },
      serviceKeys: { elevenlabs: "sk_eleven", claudeCode: TOKEN },
    } as never);
    const pushed = await laptopKeys();
    expect(pushed[KEY.claudeCode]).toBe(TOKEN);
    expect(pushed[KEY.anthropic]).toBe("sk-ant-api-real");
    expect(pushed[KEY.elevenlabs]).toBe("sk_eleven");

    // And with no sign-in there is simply no entry, rather than an empty one that
    // would overwrite a token the box already has.
    useStore.setState({ serviceKeys: { elevenlabs: "sk_eleven" } } as never);
    expect(KEY.claudeCode in (await laptopKeys())).toBe(false);
  });
});

describe("the models Claude Code runs", () => {
  it("accepts its aliases and its own pinned ids, and nothing else", async () => {
    const { isClaudeModel, validModel } = await import("../engine/claude/models");
    for (const m of ["opus", "sonnet", "haiku", "claude-opus-5", "claude-haiku-5-5", "claude-fable-5-1"]) {
      expect(isClaudeModel(m), m).toBe(true);
      expect(validModel(m), m).toBe(true);
    }
    // A provider path was pi's shape and pi is gone: handing one to Claude Code
    // fails every turn with "issue with the selected model", so it is refused
    // here instead, where Carl gets told.
    for (const m of ["openai/gpt-6.1-sol", "anthropic/claude-sonnet-4.5", "opus/extra", "", "not a model", "sonnet!", "/leading", "trailing/"]) {
      expect(validModel(m), m).toBe(false);
      expect(isClaudeModel(m), m).toBe(false);
    }
  });

  it("the effort levels are the four the composer offers, and nothing is taken for one", async () => {
    const { EFFORTS, isEffort } = await import("../engine/claude/models");
    expect([...EFFORTS]).toEqual(["low", "medium", "high", "max"]);
    for (const e of EFFORTS) expect(isEffort(e), e).toBe(true);
    // xhigh is a real SDK level, deliberately not offered (Carl asked for four).
    for (const e of ["xhigh", "", "HIGH", "none", null, undefined, 3]) expect(isEffort(e), String(e)).toBe(false);
  });

  it("every model this engine runs can do the work, so nothing reroutes a turn", async () => {
    const { capabilitiesOf, capabilityNote } = await import("../engine/capabilities");
    // There is one engine and its models take tools, run subagents, see images
    // and read PDFs. This used to be a question — pi ran whatever OpenRouter
    // offered, a model that could not see had to be found out from a catalog,
    // and a turn carrying a picture went to a different model when it was wrong.
    for (const m of ["opus", "sonnet", "haiku", "claude-fable-5-1"]) {
      expect(capabilitiesOf(m), m).toMatchObject({ images: true, tools: true, subagents: true, pdf: true });
    }
    // And nothing is warned about in the prompt any more.
    expect(capabilityNote("opus")).toBe("");
  });
});
