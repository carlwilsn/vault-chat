// What a box runs by default, and what counts as signed in.
//
// Claude Code is the engine vault-chat runs on now, so on a box that has one it
// is the engine AND the model a conversation gets without anyone choosing. Both
// of those were wrong on Carl's real box at once, and either one alone breaks
// every turn: the engine defaulted to pi, and when that was fixed the model was
// still the OpenRouter default, which Claude Code answers with "there's an issue
// with the selected model". These pin both, and the sign-in report beside them.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxEngine, engineModel } from "../engine/index";
import { tmp, cleanup } from "./helpers";

function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const before: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    before[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(patch)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

describe("what a box runs by default", () => {
  it("is Claude Code, whatever is asked and whatever is set", () => {
    // There is no engine to choose any more, so neither a caller's argument nor
    // VC_ENGINE can put a box back on something else: pi does not exist.
    withEnv({ VC_ENGINE: undefined }, () => expect(boxEngine()).toBe("claude"));
    withEnv({ VC_ENGINE: "pi" }, () => expect(boxEngine()).toBe("claude"));
    withEnv({ VC_ENGINE: "claude" }, () => expect(boxEngine()).toBe("claude"));
  });

  // The model a box has been told to run arrives either from Carl's stored choice
  // or from the deployment's VC_ENGINE_MODEL; both land in the same `chosen`, and
  // only the env one is readable here (the localStorage shim is the running
  // server's, not a test's — asserting through it would pass for any value).
  it("the model on a Claude box is a Claude alias, whatever the OpenRouter days left behind", () => {
    withEnv({ VC_ENGINE_MODEL: undefined, VC_CLAUDE_MODEL: undefined }, () => expect(engineModel()).toBe("sonnet"));
    // THE BUG: the box's model was an OpenRouter id, so every Claude turn failed
    // on "an issue with the selected model". It gives way to a model Claude runs.
    withEnv({ VC_ENGINE_MODEL: "openai/gpt-6.1-sol", VC_CLAUDE_MODEL: undefined }, () => expect(engineModel()).toBe("sonnet"));
    // Carl's own Claude alias is still his choice.
    withEnv({ VC_ENGINE_MODEL: "opus", VC_CLAUDE_MODEL: undefined }, () => expect(engineModel()).toBe("opus"));
  });

  it("a deployment can name the Claude model it wants", () => {
    withEnv({ VC_ENGINE_MODEL: undefined, VC_CLAUDE_MODEL: "haiku" }, () => {
      expect(engineModel()).toBe("haiku");
    });
  });
});

describe("what counts as signed in", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) cleanup(r);
  });

  it("a Claude Code login in the session's own config dir is a sign-in", async () => {
    const root = tmp("signedin");
    roots.push(root);
    const { ClaudeCodeBackend } = await import("../engine/claude/backend");
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const make = (env: Record<string, string>) =>
      new ClaudeCodeBackend({
        install: { cli: join(root, "claude"), source: "path", argv: [join(root, "claude")] } as never,
        paths: { root, configDir, binDir: join(root, "bin"), threadsFile: join(root, "threads.json"), sessionsDir: join(root, "sessions"), instrDir: join(root, "instr") },
        vault: root,
        feedSessionsDir: join(root, "feed"),
        env: () => env,
        log: () => {},
      } as never);

    // Nothing at all: there is nothing to run a turn with.
    expect(make({ CLAUDE_CONFIG_DIR: configDir }).signedIn()).toBe(false);
    // The product path: Carl's token, given only to the CLI.
    expect(make({ CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: "t" }).signedIn()).toBe(true);
    // A login already on the machine (`claude setup-token` / `claude auth login`
    // leave it here). Reporting "not signed in" for a box that runs turns fine
    // is a lie the UI acts on, so existence of the credential counts — and only
    // its existence is ever looked at.
    writeFileSync(join(configDir, ".credentials.json"), "{}");
    expect(make({ CLAUDE_CONFIG_DIR: configDir }).signedIn()).toBe(true);
  });
});
