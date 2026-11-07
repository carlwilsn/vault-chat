// The box has to be able to RUN Claude Code, which on NixOS the SDK's own
// bundled binary cannot do by itself. These checks run the real executable:
// they are the install story, not a mock of it.
import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { bundledCli, elfInterpreter, findClaude, loaderWrapper, probe } from "../engine/claude/install";

describe("the Claude Code the box runs", () => {
  it("names the dynamic loader of an ELF executable, and nothing for a script", () => {
    const loader = elfInterpreter(process.execPath);
    // This Node is dynamically linked, so it names one, and it exists.
    expect(loader).toBeTruthy();
    expect(existsSync(loader!)).toBe(true);
    const root = tmp("vcci-");
    const script = join(root, "s.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o755);
    expect(elfInterpreter(script)).toBeNull();
    expect(elfInterpreter(join(root, "missing"))).toBeNull();
    cleanup(root);
  });

  it("finds an executable that really answers --version", () => {
    const root = tmp("vcci2-");
    const found = findClaude({ stateDir: root, env: {} });
    if ("error" in found) throw new Error(`${found.error}: ${found.tried.join("; ")}`);
    expect(found.install.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(probe(found.install.cli)).toBe(found.install.version);
    // When the SDK brought its own matching CLI, that is the one chosen —
    // directly where the box can run it, else through this Node's own glibc
    // loader. With no platform package, a `claude` on PATH is the fallback.
    expect(bundledCli() ? ["bundled", "loader"] : ["bundled", "loader", "path"]).toContain(found.install.source);
    if (found.install.source === "loader") {
      // NixOS: a one-line wrapper under the state dir, not a patched 325 MB copy.
      expect(found.install.cli).toBe(join(root, "claude", "bin", "claude"));
      expect(probe(bundledCli()!)).toBeNull();
    }
    cleanup(root);
  });

  it("a pinned binary a box install dropped under the state dir beats whatever is on PATH", () => {
    const root = tmp("vcci6-");
    const found = findClaude({ stateDir: root, env: {} });
    if ("error" in found) throw new Error(found.error);
    // The deployed box has no node_modules, so this is how it gets the CLI whose
    // version matches the SDK's rather than the one that happens to be on PATH.
    const cliDir = join(root, "claude", "cli");
    mkdirSync(cliDir, { recursive: true });
    const pinned = join(cliDir, "claude");
    writeFileSync(pinned, `#!/bin/sh\nexec ${JSON.stringify(found.install.cli)} "$@"\n`);
    chmodSync(pinned, 0o755);
    const picked = findClaude({ stateDir: root, env: {} });
    if ("error" in picked) throw new Error(picked.error);
    expect(picked.install).toMatchObject({ cli: pinned, source: "installed", version: found.install.version });
    cleanup(root);
  }, 120_000);

  it("VC_CLAUDE_BIN wins when it works, and is reported as the reason when it does not", () => {
    const root = tmp("vcci3-");
    const good = findClaude({ stateDir: root, env: {} });
    if ("error" in good) throw new Error(good.error);
    const picked = findClaude({ stateDir: root, env: { VC_CLAUDE_BIN: good.install.cli } });
    expect(picked).toMatchObject({ install: { cli: good.install.cli, source: "env" } });

    const bad = join(root, "not-claude");
    mkdirSync(root, { recursive: true });
    writeFileSync(bad, "#!/bin/sh\nexit 3\n");
    chmodSync(bad, 0o755);
    const fellBack = findClaude({ stateDir: root, env: { VC_CLAUDE_BIN: bad } });
    if ("error" in fellBack) throw new Error(fellBack.error);
    // It did not silently use the broken one.
    expect(fellBack.install.cli).not.toBe(bad);
    expect(fellBack.install.source).not.toBe("env");
    cleanup(root);
  });

  it("the loader wrapper is one line, executable, and passes its arguments through", () => {
    const root = tmp("vcci4-");
    const loader = elfInterpreter(process.execPath)!;
    const wrapper = loaderWrapper(join(root, "bin"), process.execPath, loader);
    // Running Node through its own loader still works, and `--version` reaches it.
    expect(probe(wrapper)).toBe(process.versions.node);
    cleanup(root);
  });

  it("says what it tried when nothing runs", () => {
    const root = tmp("vcci5-");
    const r = findClaude({ stateDir: root, env: { VC_CLAUDE_BIN: join(root, "nope"), PATH: join(root, "empty") } });
    // With a bundled CLI present this cannot fail; without one, an empty PATH leaves nothing.
    if ("error" in r) expect(r.tried.join("\n")).toContain("VC_CLAUDE_BIN");
    else expect(["bundled", "loader"]).toContain(r.install.source);
    cleanup(root);
  });
});
