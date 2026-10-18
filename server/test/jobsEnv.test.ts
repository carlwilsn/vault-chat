// A job's environment (the stored agent keys among it) reaches systemd-run
// through a 0600 EnvironmentFile, never its argv: a process lister sees argv.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup } from "./helpers";
import { startJob, sweepJobEnvFiles, writeJobEnvFile, jobArgv } from "../engine/pi/jobs";

const root = mkdtempSync(join(tmpdir(), "vc-jobenv-"));
afterAll(() => cleanup(root));

// Fakes built at runtime: no key-like literal in the source.
const fakeKey = "sk-or-v1-" + "x".repeat(64);
const otherKey = "lam-" + "y".repeat(40) + "'q\"$`\\";

describe("job environment file", () => {
  it("argv never holds a value; the file is 0600 in a 0700 dir, holds the vars, and is gone once the unit started", () => {
    const envDir = join(root, "run", "jobs");
    const seen: { argv: string[]; file?: string; body?: string; mode?: number; dirMode?: number }[] = [];
    const env = {
      logDir: join(root, "logs"),
      wrap: ["bwrap", "--"],
      envDir,
      env: { PATH: "/bin", HOME: "/home/c", OPENROUTER_API_KEY: fakeKey, OTHER_KEY: otherKey },
      exec: (cmd: string, args: string[]) => {
        if (cmd === "systemd-run") {
          const file = args.find((a) => a.startsWith("--property=EnvironmentFile="))?.slice("--property=EnvironmentFile=".length);
          const rec: (typeof seen)[number] = { argv: args, ...(file ? { file } : {}) };
          if (file && existsSync(file)) {
            rec.body = readFileSync(file, "utf8");
            rec.mode = statSync(file).mode & 0o777;
            rec.dirMode = statSync(envDir).mode & 0o777;
          }
          seen.push(rec);
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const out = startJob(env, "/vault", { command: "python train.py", name: "train" });
    expect(out).toMatch(/Started job/);
    const s = seen[0]!;
    const joined = s.argv.join("\n");
    expect(joined).not.toContain(fakeKey);
    expect(joined).not.toContain("y".repeat(40));
    expect(s.argv).not.toContain("-E");
    expect(s.argv).toContain("--property=Type=exec");
    expect(s.file!.startsWith(envDir)).toBe(true);
    // The file existed while systemd-run ran, with every variable in it.
    expect(s.body).toContain(`OPENROUTER_API_KEY='${fakeKey}'`);
    expect(s.body).toMatch(/^PATH='\/bin'$/m);
    // A value with a single quote: double quotes, \ before " $ ` and \.
    const bs = "\\";
    expect(s.body).toContain(`OTHER_KEY="lam-${"y".repeat(40)}'q${bs}"${bs}$${bs}\`${bs}${bs}"\n`);
    if (process.platform !== "win32") {
      expect(s.mode).toBe(0o600);
      expect(s.dirMode).toBe(0o700);
    }
    // ...and is removed once it returned.
    expect(existsSync(s.file!)).toBe(false);
    expect(readdirSync(envDir)).toEqual([]);
  });

  it("the file is removed when systemd-run fails too, and argv built directly carries only the path", () => {
    const envDir = join(root, "run2");
    let file = "";
    const env = {
      logDir: join(root, "logs2"),
      wrap: ["bwrap", "--"],
      envDir,
      env: { OPENROUTER_API_KEY: fakeKey },
      exec: (_cmd: string, args: string[]) => {
        file = args.find((a) => a.startsWith("--property=EnvironmentFile="))!.split("=").slice(2).join("=");
        return { status: 1, stdout: "", stderr: "Failed to start transient service unit" };
      },
    };
    expect(startJob(env, "/vault", { command: "true" })).toMatch(/StartJob failed/);
    expect(file).toBeTruthy();
    expect(existsSync(file)).toBe(false);
    const argv = jobArgv(env, "/vault", "x-1", "true", 60, "/run/user/1/vault-chat/jobs/x-1.env");
    expect(argv.join(" ")).not.toContain(fakeKey);
  });

  it("stale files (a crash between write and start) are swept; fresh ones and other files stay", () => {
    const dir = join(root, "sweep");
    const stale = writeJobEnvFile(dir, "old-1", { OPENROUTER_API_KEY: fakeKey });
    const fresh = writeJobEnvFile(dir, "new-1", { OPENROUTER_API_KEY: fakeKey });
    const old = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(stale, old, old);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "keep");
    expect(sweepJobEnvFiles(dir)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(sweepJobEnvFiles(dir, 0)).toBe(1);
    expect(existsSync(fresh)).toBe(false);
    expect(sweepJobEnvFiles(join(root, "missing"))).toBe(0);
  });
});
