// The agent's sandbox, as the bubblewrap argv the engine builds (bwrap itself
// only runs on the box; these assert the mounts and their order — later mounts
// win). The home is read-only; writable are the own vault, pi's sessions and
// agent dir, the jobs dir, the work area and /tmp; every vault root is hidden
// and the own vault bound back; credentials, the server's env file and the key
// store are hidden. The per-command shell layer gets the same mounts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";

const home = tmp("vcsb-");
const vaults = join(home, "vaults");
const vault = join(vaults, "school2");
const state = join(home, ".local", "state", "vault-chat-server");
const sessions = join(state, "pi", "sessions");
const agentDir = join(state, "pi", "agent");
const jobs = join(state, "jobs");
const secrets = join(home, ".config", "vault-chat");
const envFile = join(home, ".config", "vault-chat-server.env");
const work = join(home, "agent-work", "school2");
const token = join(home, ".local", "share", "com.vault-chat.app", "phone-token");

let buildSandbox: typeof import("../engine/index").buildSandbox;
let agentWorkDir: typeof import("../engine/index").agentWorkDir;
let outerWith: typeof import("../engine/pi/backend").outerWith;

beforeAll(async () => {
  for (const d of [
    join(vault, ".vault-chat", "conversations"),
    join(vault, ".vault-chat", "local"),
    join(vaults, "school2.git"),
    join(vaults, "physics"),
    join(vaults, "physics.git"),
    join(vaults, "live-only"), // a vault this server does not know
    sessions,
    agentDir,
    jobs,
    secrets,
    work,
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".config", "gh"),
    join(home, ".local", "state", "thinkbox"),
    join(home, "machine"),
    join(home, ".local", "share", "com.vault-chat.app"),
  ])
    mkdirSync(d, { recursive: true });
  for (const f of [envFile, join(home, ".git-credentials"), join(home, ".npmrc"), token, join(agentDir, "settings.json")]) writeFileSync(f, "x");
  await import("../shims/globals");
  ({ buildSandbox, agentWorkDir } = await import("../engine/index"));
  ({ outerWith } = await import("../engine/pi/backend"));
});
afterAll(() => cleanup(home));

/** Index of a mount (flag + its args) in argv, -1 if absent. */
function at(argv: string[], ...m: string[]): number {
  for (let i = 0; i + m.length <= argv.length; i++) if (m.every((x, j) => argv[i + j] === x)) return i;
  return -1;
}

const base = () => ({
  bwrap: "/run/current-system/sw/bin/bwrap",
  home,
  stateDir: state,
  secretsDir: secrets,
  hideFiles: [token],
  sessionsDir: sessions,
  agentDir,
  vault,
  uid: -1,
  jobsDir: jobs,
  envFile,
});

describe("the agent sandbox (bubblewrap argv)", () => {
  it("keeps the pid namespace, the whole root (network, nix store), and ends with --", () => {
    const sb = buildSandbox(base());
    for (const argv of [sb.outer!, sb.shell!]) {
      expect(argv.slice(0, 8)).toEqual(["/run/current-system/sw/bin/bwrap", "--dev-bind", "/", "/", "--proc", "/proc", "--unshare-pid", "--die-with-parent"]);
      expect(argv[argv.length - 1]).toBe("--");
      expect(argv).not.toContain("--unshare-net");
      expect(argv).not.toContain("--unshare-all");
    }
  });

  it("makes the home read-only, empties the vaults root, and binds back only the own vault (rw)", () => {
    const o = buildSandbox(base()).outer!;
    const ro = at(o, "--ro-bind", home, home);
    const hideVaults = at(o, "--tmpfs", vaults);
    const own = at(o, "--bind", vault, vault);
    expect(ro).toBeGreaterThan(0);
    expect(hideVaults).toBeGreaterThan(ro);
    expect(own).toBeGreaterThan(hideVaults);
    // Nothing else of the vaults root comes back: the bare repos, the other vaults (known or not).
    for (const p of ["school2.git", "physics", "physics.git", "live-only"]) expect(o.some((x) => x === join(vaults, p))).toBe(false);
    // ~/machine is never writable (read-only with the home).
    expect(at(o, "--bind", join(home, "machine"), join(home, "machine"))).toBe(-1);
  });

  it("writable: pi's sessions and agent dir, the jobs dir, the work area — after the read-only state", () => {
    const o = buildSandbox(base()).outer!;
    const roState = at(o, "--ro-bind", state, state);
    expect(roState).toBeGreaterThan(at(o, "--ro-bind", home, home));
    for (const d of [sessions, agentDir, jobs, work]) expect(at(o, "--bind", d, d)).toBeGreaterThan(roState);
    expect(work).toBe(agentWorkDir(home, vault));
    // pi's own config and the server's conversation files stay read-only, after the writable binds.
    const ownAt = at(o, "--bind", vault, vault);
    expect(at(o, "--ro-bind", join(agentDir, "settings.json"), join(agentDir, "settings.json"))).toBeGreaterThan(at(o, "--bind", agentDir, agentDir));
    for (const d of ["conversations", "local"]) expect(at(o, "--ro-bind", join(vault, ".vault-chat", d), join(vault, ".vault-chat", d))).toBeGreaterThan(ownAt);
  });

  it("hides credentials, the key store, tokens and the server's env file — last, so nothing re-exposes them", () => {
    const sb = buildSandbox(base());
    for (const argv of [sb.outer!, sb.shell!]) {
      const lastBind = Math.max(...[vault, sessions, agentDir, jobs, work].map((d) => at(argv, "--bind", d, d)));
      for (const d of [secrets, join(home, ".ssh"), join(home, ".gnupg"), join(home, ".config", "gh"), join(home, ".local", "state", "thinkbox")])
        expect(at(argv, "--tmpfs", d)).toBeGreaterThan(lastBind);
      for (const f of [envFile, token, join(home, ".git-credentials"), join(home, ".npmrc")]) expect(at(argv, "--ro-bind", "/dev/null", f)).toBeGreaterThan(lastBind);
    }
    // pi's in-process tools are refused them too.
    expect(sb.denyRead).toEqual(expect.arrayContaining([secrets, envFile, token, join(home, ".ssh"), join(home, ".local", "state", "thinkbox"), join(home, ".git-credentials")]));
  });

  it("the per-command shell layer gets the same mounts as pi's (voice Bash, vault tools, jobs ride the outer one)", () => {
    const sb = buildSandbox(base());
    expect(sb.shell).toEqual(sb.outer);
    // The outer layer with the other vaults' state walled off, as voice/jobs/subagent children get it.
    const others = join(state, "vaults", "physics");
    mkdirSync(others, { recursive: true });
    const o = outerWith({ ...sb, others: () => [join(vaults, "physics"), others] })!;
    expect(at(o, "--tmpfs", others)).toBeGreaterThan(0);
    expect(o.slice(0, sb.outer!.length - 1)).toEqual(sb.outer!.slice(0, -1));
    expect(at(o, "--tmpfs", join(vaults, "physics"))).toBeGreaterThan(sb.outer!.length - 2);
    expect(o[o.length - 1]).toBe("--");
  });

  it("reads the server's env file path from VC_ENV_FILE", async () => {
    const custom = join(home, "etc-server.env");
    writeFileSync(custom, "VC_X=1");
    const prev = process.env.VC_ENV_FILE;
    process.env.VC_ENV_FILE = custom;
    try {
      const { envFile: _drop, ...rest } = base();
      const o = buildSandbox(rest).outer!;
      expect(at(o, "--ro-bind", "/dev/null", custom)).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.VC_ENV_FILE;
      else process.env.VC_ENV_FILE = prev;
    }
  });

  it("never empties the home itself: a vault directly in the home keeps the home read-only, the vault rw", () => {
    const v = join(home, "flat-vault");
    mkdirSync(v, { recursive: true });
    const o = buildSandbox({ ...base(), vault: v, vaultRoots: [home] }).outer!;
    expect(at(o, "--tmpfs", home)).toBe(-1);
    expect(at(o, "--ro-bind", home, home)).toBeGreaterThan(0);
    expect(at(o, "--bind", v, v)).toBeGreaterThan(0);
  });

  it("without bubblewrap: no argv, the path guard lists only", () => {
    const sb = buildSandbox({ ...base(), bwrap: null });
    expect(sb.outer).toBeNull();
    expect(sb.shell).toBeNull();
    expect(sb.denyRead).toContain(join(home, ".ssh"));
  });
});

describe("the machine section of the developer instructions", () => {
  it("names the work area and the browser command that works in the sandbox", async () => {
    const { machineText } = await import("../context");
    const t = machineText({ chrome: "/run/current-system/sw/bin/chromium", work: "/home/carl/agent-work/school2" });
    expect(t).toContain("/home/carl/agent-work/school2/");
    expect(t).toMatch(/home directory is read-only/);
    expect(t).toContain(
      "timeout 60 /run/current-system/sw/bin/chromium --headless=old --no-sandbox --disable-gpu --no-first-run --user-data-dir=/tmp/chrome-agent --window-size=1400,900 --screenshot=/tmp/page.png <url>",
    );
    expect(t).toContain("timeout 60 /run/current-system/sw/bin/chromium --headless=old --no-sandbox --disable-gpu --no-first-run --user-data-dir=/tmp/chrome-agent --dump-dom <url>");
    const cmds = t.match(/timeout 60 [^`]*/g)!;
    expect(cmds).toHaveLength(2);
    expect(cmds.every((c) => !c.includes("--headless=new"))).toBe(true);
    // No browser: the sandbox note alone.
    expect(machineText({ chrome: null, work: "/w" })).not.toMatch(/browser/i);
  });
});
