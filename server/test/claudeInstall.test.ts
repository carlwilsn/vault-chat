// The box has to be able to RUN Claude Code, which on NixOS the SDK's own
// bundled binary cannot do by itself. These checks run the real executable:
// they are the install story, not a mock of it.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { spawnSync } from "node:child_process";
import { bundledCli, claudeExeName, elfInterpreter, findClaude, installerCli, loaderWrapper, probe, sandboxedCli, wrapper } from "../engine/claude/install";
import { findBwrap } from "../engine/pi/install";

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

describe("a session's executable is the CLI inside the box's sandbox", () => {
  it("wraps the CLI in the outer sandbox, carves out what it must write, and still runs", () => {
    // On Linux the box is expected to have bubblewrap: pi refuses to run without
    // it, so a missing one is a real finding and not a reason to pass quietly.
    const bwrap = findBwrap();
    if (process.platform === "linux") expect(bwrap, "bubblewrap was not found on a Linux box").toBeTruthy();
    if (!bwrap) return;
    const root = tmp("vccs-");
    const found = findClaude({ stateDir: root, env: {} });
    if ("error" in found) throw new Error(found.error);
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    // The shape the backend builds: the box's outer layer, then the carve-outs.
    const outer = [bwrap, "--dev-bind", "/", "/", "--proc", "/proc", "--unshare-pid", "--die-with-parent", "--ro-bind", root, root, "--"];
    const cli = sandboxedCli({ install: found.install, dir: join(root, "bin"), name: "claude-test", sandbox: outer, writable: [configDir] });
    expect(cli).toBe(join(root, "bin", "claude-test"));
    const script = readFileSync(cli, "utf8");
    expect(script).toContain(bwrap);
    // The carve-out goes after the layer that made the state dir read-only.
    expect(script.indexOf(JSON.stringify(configDir))).toBeGreaterThan(script.indexOf(JSON.stringify(root)));
    expect(script).toContain(JSON.stringify(found.install.cli));

    // The real CLI still starts in there.
    expect(probe(cli)).toBe(found.install.version);
    cleanup(root);
  }, 120_000);

  it("the sandbox it is wrapped in really hides what the box hides", () => {
    const bwrap = findBwrap();
    if (process.platform === "linux") expect(bwrap, "bubblewrap was not found on a Linux box").toBeTruthy();
    if (!bwrap) return;
    const root = tmp("vccs2-");
    mkdirSync(root, { recursive: true });
    const secret = join(root, "secret");
    writeFileSync(secret, "not for the agent");
    const sh = "/bin/sh";
    expect(existsSync(sh), "/bin/sh is needed to look inside the sandbox").toBe(true);

    // Outside: readable. Inside the same layer the sessions run in: gone.
    expect(spawnSync(sh, ["-c", `cat ${JSON.stringify(secret)}`], { encoding: "utf8" }).stdout).toContain("not for the agent");
    const outer = [bwrap, "--dev-bind", "/", "/", "--proc", "/proc", "--unshare-pid", "--die-with-parent", "--ro-bind", "/dev/null", secret, "--"];
    const w = wrapper(join(root, "bin"), "peek", [...outer, sh, "-c", `cat ${JSON.stringify(secret)}`]);
    expect(spawnSync(w, [], { encoding: "utf8" }).stdout).toBe("");
    cleanup(root);
  }, 60_000);
});

describe("where it looks on Windows", () => {
  it("calls it claude.exe there, and claude everywhere else", () => {
    expect(claudeExeName("win32")).toBe("claude.exe");
    expect(claudeExeName("linux")).toBe("claude");
    expect(claudeExeName("darwin")).toBe("claude");
  });

  it("finds where Claude Code's own installer put it, by HOME or USERPROFILE", () => {
    // Windows was broken twice over: the name is claude.exe, and Windows does
    // not set HOME — so a search keyed on HOME and on a file called "claude"
    // found nothing on Carl's laptop, where ~/.local/bin/claude.exe is the only
    // copy there is.
    const root = tmp("winlook");
    try {
      for (const platform of ["win32", "linux"] as const) {
        const p = join(root, platform, ".local", "bin", claudeExeName(platform));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, "");
        const home = join(root, platform);
        // Either name for the home directory answers.
        expect(installerCli({ HOME: home }, platform)).toBe(p);
        expect(installerCli({ USERPROFILE: home }, platform)).toBe(p);
        // HOME wins when both are set, as the platform that sets both intends.
        expect(installerCli({ HOME: home, USERPROFILE: join(root, "elsewhere") }, platform)).toBe(p);
      }
      // Nothing there, nothing claimed.
      expect(installerCli({ HOME: join(root, "empty") }, "win32")).toBeNull();
      expect(installerCli({}, "win32")).toBeNull();
      // A blank home is not a home.
      expect(installerCli({ HOME: "   " }, "linux")).toBeNull();
    } finally {
      cleanup(root);
    }
  });
});
