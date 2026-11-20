// The box server from the box, not GitHub (hot-swap "boxserver-1"): the updater (server/deploy/vault-chat-update.sh,
// the real script, one whole pass each time) promotes the server bundle the ship gate built for accepted main into
// versions/<rev> and hands over; a broken one is switched back by itself and marked failed/<rev>; a GitHub release
// built from what already runs is a mirror and never installed over it; every handover and switch back is one
// box.server.switch record (server/serverSwitches.ts). A scratch state folder, a fake systemctl and a fake health
// endpoint on an ephemeral loopback port: no real systemd, no network, no secrets.
import { afterAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmp, cleanup, ROOT } from "./helpers";
import { recordServerSwitches, type ServerSwitch } from "../serverSwitches";

const UPDATE = join(ROOT, "server", "deploy", "vault-chat-update.sh");
const dirs: string[] = [];
let server: Server | null = null;
afterAll(() => {
  server?.close();
  for (const d of dirs) cleanup(d);
});

const git = (repo: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A fake gate run for <rev>: its checkout's dist-server (a bundle that answers build-info), assets, deploy files. */
function gateRun(runs: string, run: string, rev: string, broken = false): void {
  const d = join(runs, run, rev);
  mkdirSync(join(d, "dist-server"), { recursive: true });
  mkdirSync(join(d, "src-tauri", "assets"), { recursive: true });
  mkdirSync(join(d, "server", "deploy"), { recursive: true });
  writeFileSync(join(d, "dist-server", "vault-chat-server.mjs"),
    `${broken ? "// CRASH: this server never comes up\n" : ""}if (process.argv[2] === "build-info") console.log(JSON.stringify({ version: "0.7.25", rev: "${rev}" }));\n`);
  writeFileSync(join(d, "dist-server", "server-version.json"), JSON.stringify({ version: "0.7.25", rev }));
  writeFileSync(join(d, "src-tauri", "assets", "phone.html"), `<html>${rev}</html>`);
  writeFileSync(join(d, "server", "deploy", "vault-chat-update.sh"), `#!/usr/bin/env bash\n# updater of ${rev}\nexit 0\n`);
  writeFileSync(join(runs, run, `${rev}-build-server.log`), "built\n");
}

describe("box server from the box", () => {
  it("promotes the gate's build of accepted main, switches back from a broken one, and treats GitHub as a mirror", async () => {
    const root = tmp("vc-boxserver-");
    dirs.push(root);
    const state = join(root, "state"), repo = join(root, "repo"), runs = join(root, "host-ship-runs"), fake = join(root, "bin");
    for (const d of [state, repo, runs, fake, join(root, "units"), join(root, "home")]) mkdirSync(d, { recursive: true });

    // The repo: accepted main C1, later C2; the release CI made from C1 (a detached version commit).
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "C1");
    const c1 = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "--detach");
    git(repo, "commit", "-q", "--allow-empty", "-m", "v0.9.64 [skip ci]");
    const bump = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");

    // What runs now: a GitHub release.
    const old = join(state, "versions", "0.9.63");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "vault-chat-server.mjs"), "// 0.9.63\n");
    writeFileSync(join(old, "server-version.json"), JSON.stringify({ version: "0.9.63", rev: "e".repeat(40) }));
    symlinkSync("versions/0.9.63", join(state, "current"));

    // systemd: every unit is "inactive" (no front), everything else succeeds. /bin/sh, not /usr/bin/env: the ship
    // gate's sandbox has no /usr/bin/env, and a fake that cannot start fails every restart (and so every check).
    writeFileSync(join(fake, "systemctl"), `#!/bin/sh\necho "$*" >> "${root}/systemctl.log"\ncase " $* " in *" is-active "*) exit 3 ;; esac\nexit 0\n`);
    chmodSync(join(fake, "systemctl"), 0o755);

    // The server behind `current`: healthy unless its bundle is broken. GitHub's latest release is v0.9.64 (from C1).
    server = createServer((req, res) => {
      const at = join(state, readlinkSync(join(state, "current")));
      if (req.url === "/api/v1/health") {
        if (readFileSync(join(at, "vault-chat-server.mjs"), "utf8").includes("CRASH")) { res.writeHead(503); return res.end(); }
        const m = JSON.parse(readFileSync(join(at, "server-version.json"), "utf8"));
        return res.end(JSON.stringify({ ok: true, app: "vault-chat-server", version: m.version, rev: m.rev, releaseReadiness: { status: "healthy" }, busy: { runs: 0, workers: 0, inputs: 0 } }));
      }
      const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
      if (req.url === "/release") return res.end(JSON.stringify({ tag_name: "v0.9.64", draft: false, assets: [{ name: "server-version.json", browser_download_url: `${base}/dl/server-version.json` }] }));
      if (req.url === "/dl/server-version.json") return res.end(JSON.stringify({ version: "0.9.64", rev: bump }));
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const pass = () =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const p = spawn("bash", [UPDATE], {
          env: {
            PATH: `${fake}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
            HOME: join(root, "home"),
            VC_SERVER_STATE: state,
            VC_SERVER_URL: base,
            VC_UPDATE_API: `${base}/release`,
            VC_UPDATE_COMMITS_API: `${base}/commits`,
            VC_UPDATE_SOURCE_REPO: repo,
            VC_UPDATE_SHIP_RUNS: runs,
            VC_UPDATE_BIN_DIR: join(state, "bin"),
            VC_UPDATE_UNITS_DIR: join(root, "units"),
            VC_UPDATE_HEALTH_WAIT_S: "3",
            VC_UPDATE_HEALTH_POLL_S: "0.2",
            VC_UPDATE_BUSY_POLL_S: "1",
          },
        });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (out += d));
        p.on("exit", (code) => resolve({ code, out }));
      });
    const records: ServerSwitch[] = [];
    const record = () => recordServerSwitches(state, (ev) => (records.push(ev), true));

    // 1. The gate built C1 and accepted it (it is main): promoted into versions/<C1>, handed over, one record.
    gateRun(runs, "ship-a", c1);
    let r = await pass();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`box build ${c1.slice(0, 12)}`);
    expect(readlinkSync(join(state, "current"))).toBe(`versions/${c1}`);
    const meta = JSON.parse(readFileSync(join(state, "versions", c1, "server-version.json"), "utf8"));
    expect(meta).toMatchObject({ version: "0.7.25", rev: c1, source: "box", run: "ship-a" });
    expect(readFileSync(join(state, "versions", c1, "assets", "phone.html"), "utf8")).toContain(c1);
    // Copied, not moved: the gate's run is untouched.
    expect(existsSync(join(runs, "ship-a", c1, "dist-server", "vault-chat-server.mjs"))).toBe(true);
    // The commit's own updater refreshed itself after the healthy handover.
    expect(readFileSync(join(state, "bin", "vault-chat-update.sh"), "utf8")).toContain(`updater of ${c1}`);
    expect(record()).toBe(1);
    expect(records[0]).toMatchObject({ type: "box.server.switch", change: "keep", by: "auto", to: { slot: c1, rev: c1, source: "box" }, from: { slot: "0.9.63", version: "0.9.63", source: "github" } });
    expect(record()).toBe(0); // once

    // 2. Nothing new: the running box build is checked, nothing moves.
    r = await pass();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("up to date (box build");
    expect(readlinkSync(join(state, "current"))).toBe(`versions/${c1}`);

    // 3. Main moves to C2, whose server never comes up: handed over, unhealthy within the window, switched back to C1.
    git(repo, "commit", "-q", "--allow-empty", "-m", "C2");
    const c2 = git(repo, "rev-parse", "HEAD");
    gateRun(runs, "ship-b", c2, true);
    r = await pass();
    expect(r.code, r.out).toBe(1);
    expect(readlinkSync(join(state, "current"))).toBe(`versions/${c1}`);
    expect(readFileSync(join(state, "failed", c2), "utf8")).toContain("restored healthy retained");
    expect(record()).toBe(1);
    expect(records[1]).toMatchObject({ change: "switch", by: "auto", to: { slot: c1, rev: c1 }, from: { slot: c2, rev: c2 } });
    expect(records[1].reason).toContain("failed actual release readiness after install");

    // 4. C2 failed here: GitHub is asked, and its v0.9.64 was built from C1, which already runs: not installed.
    r = await pass();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`box build ${c2.slice(0, 12)} failed here before`);
    expect(r.out).toContain("v0.9.64 mirrors main");
    expect(readlinkSync(join(state, "current"))).toBe(`versions/${c1}`);
    expect(existsSync(join(state, "versions", "0.9.64"))).toBe(false);
    expect(record()).toBe(0);
  }, 60_000);
});
