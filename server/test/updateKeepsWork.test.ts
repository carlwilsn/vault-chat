// An update never kills the box's running work. The agent's shells (and so every test suite and test instance it
// runs) live inside the live server's systemd unit (vault-chat-server@<port>.service). A server started there with
// VC_BACKEND_PORT (blueGreen.test.ts's slots, a test instance on other ports) used to read that unit's cgroup as its
// own on its hand-over or SIGTERM and end every process in it: the live server, its Claude Code sessions and all their
// background workers (the box's 02:42 and 03:50 kills on 2026-11-16). Only the unit's own server may end its unit.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, freePort, type Running } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { isOwnUnit } from "../owner";

const UNIT = (port: number) => `/user.slice/user-1000.slice/user@1000.service/app.slice/vault-chat-server@${port}.service`;

describe("which server may end its unit's processes", () => {
  it("only the unit's own server: started by systemd, on the unit's port", () => {
    expect(isOwnUnit(UNIT(8851), 8851, "systemd")).toBe(true);
    // A test instance (or a test suite's blue-green slot) started from an agent's shell inside the live unit.
    expect(isOwnUnit(UNIT(8851), 41234, "node")).toBe(false);
    expect(isOwnUnit(UNIT(8851), 41234, "systemd")).toBe(false);
    expect(isOwnUnit(UNIT(8851), 8851, "node")).toBe(false);
    expect(isOwnUnit(UNIT(8851), 8851, "zsh")).toBe(false);
    expect(isOwnUnit(UNIT(8851), 8851, null)).toBe(false);
    // Not a server unit at all (a shell, the ship gate's unit).
    expect(isOwnUnit("/user.slice/user-1000.slice/user@1000.service/app.slice/vc-ship-request.service", 8851, "systemd")).toBe(false);
  });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const descendants = (pid: number): number[] => {
  const kids = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").map(Number).filter((n) => n > 0);
  return kids.flatMap((k) => [k, ...descendants(k)]);
};
const cmdline = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
};

describe.skipIf(process.platform !== "linux")("an update inside the live server's unit", () => {
  let home = "";
  const running: Running[] = [];
  const extra: ChildProcess[] = [];
  const apis: FakeApi[] = [];
  afterAll(async () => {
    for (const s of running) await s.stop().catch(() => {});
    for (const p of extra) if (p.exitCode === null) p.kill("SIGKILL");
    for (const a of apis) await a.close().catch(() => {});
    if (home) cleanup(home);
  });

  it("a hand-over and a stop of test servers there leave the live server's running turn and background worker alone", async () => {
    home = tmp();
    const vault = makeVault(join(home, "vault"));
    const secrets = await makeKeyStore(join(home, "secrets"), { "service.claude-code": "sk-ant-oat01-canary-not-real" });

    // The live server: a real one, with a real Claude Code turn running and a background shell (a worker) it started.
    const liveApi = await fakeAnthropic("Done.");
    apis.push(liveApi);
    mkdirSync(join(home, "live-state"), { recursive: true });
    const live = await startServer({ home, vault, secrets, anthropic: liveApi.url, extra: { VC_STATE_DIR: join(home, "live-state") } });
    running.push(live);
    const marker = `vc-survive-worker-${process.pid}`;
    liveApi.script.push({ toolCall: { name: "Bash", args: { command: `sh -c 'sleep 300; :' ${marker}`, run_in_background: true, description: "a background worker" } } });
    liveApi.script.push({ text: "Still working.", delayMs: 15_000 });
    const sent = await (await fetch(live.base + "/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Start the worker, then keep going." }) })).json();
    expect(sent.ok).toBe(true);
    let worker = 0;
    await waitFor(() => {
      worker = Number(spawnSync("pgrep", ["-f", `^sh -c sleep 300; : ${marker}$`], { encoding: "utf8" }).stdout.split("\n")[0]) || 0;
      return worker > 0;
    }, 60_000, 100).catch((e) => {
      throw new Error(`${e.message}\n${descendants(live.proc.pid!).map((p) => p + " " + cmdline(p)).join("\n")}\n${live.logs().slice(-3000)}\n${JSON.stringify(liveApi.requests.map((r) => r.messages?.slice(-1)), null, 0).slice(-3000)}`);
    });
    expect((await (await fetch(live.base + "/api/v1/health")).json()).busy.runs).toBeGreaterThan(0);
    const liveProcs = [...new Set([live.proc.pid!, ...descendants(live.proc.pid!), worker])];
    const claude = liveProcs.find((p) => /claude/.test(cmdline(p)) && !cmdline(p).includes(marker));
    expect(claude).toBeTruthy();

    // The live unit, as the test servers will see it: their cgroup is the live server's (vault-chat-server@<live>),
    // and every process in it, the test servers included, is in its cgroup.procs.
    const livePort = await freePort();
    const fs = join(home, "cgroup");
    const unitDir = join(fs, UNIT(livePort));
    mkdirSync(unitDir, { recursive: true });
    const selfCgroup = join(home, "self-cgroup");
    writeFileSync(selfCgroup, `0::${UNIT(livePort)}\n`);
    const procsFile = join(unitDir, "cgroup.procs");
    const unitProcs = new Set<number>(liveProcs);
    const writeProcs = () => writeFileSync(procsFile, [...unitProcs].join("\n") + "\n");
    writeProcs();

    // An update of test servers there: slot A serves, slot B stands by, A hands over, then B is stopped.
    mkdirSync(join(home, "state"), { recursive: true });
    const api = await fakeAnthropic("Done.");
    apis.push(api);
    const [pub, pa, pb] = [await freePort(), await freePort(), await freePort()];
    const slot = (port: number) => ({
      home,
      vault: makeVault(join(home, `vault-${port}`)),
      secrets,
      anthropic: api.url,
      extra: { VC_PORT: String(pub), VC_BACKEND_PORT: String(port), VC_TEST_CGROUP_FS: fs, VC_TEST_SELF_CGROUP: selfCgroup },
    });
    const a = await startServer(slot(pa));
    running.push(a);
    unitProcs.add(a.proc.pid!);
    writeProcs();
    const nextP = startServer(slot(pb));
    await waitFor(() => existsSync(join(home, "state", "standby")), 60_000, 50);
    a.proc.kill("SIGUSR2");
    expect(await a.exited).toBe(0);
    const b = await nextP;
    running.push(b);
    unitProcs.add(b.proc.pid!);
    writeProcs();
    expect(b.logs()).toContain("[owner] took over");
    expect(await b.stop()).toBe(143);

    // The live server, its Claude Code and its worker were never touched; its turn finishes whole.
    for (const p of [live.proc.pid!, claude!, worker]) expect(alive(p), `${p} ${cmdline(p)}`).toBe(true);
    expect(live.logs()).not.toMatch(/SIGTERM|hand-over/);
    await waitFor(async () => {
      const rows = (await (await fetch(live.base + "/api/v2/conversations")).json()).rows as any[];
      const row = rows.find((x) => x.id === sent.convId);
      return !!row && !row.running;
    }, 60_000, 200);
    expect(live.logs()).not.toMatch(/Claude Code process exited/);
    expect(alive(worker)).toBe(true);
    process.kill(worker, "SIGKILL");
  }, 180_000);

  it("the unit's own server still ends its unit's processes when it hands over", async () => {
    const h = tmp();
    try {
      const fs = join(h, "cgroup");
      const [pub, pa, pb] = [await freePort(), await freePort(), await freePort()];
      const unitDir = join(fs, UNIT(pa));
      mkdirSync(unitDir, { recursive: true });
      const selfCgroup = join(h, "self-cgroup");
      writeFileSync(selfCgroup, `0::${UNIT(pa)}\n`);
      const straggler = spawn("sleep", ["300"], { stdio: "ignore" });
      extra.push(straggler);
      const secrets = await makeKeyStore(join(h, "secrets"), { "service.claude-code": "sk-ant-oat01-canary-not-real" });
      mkdirSync(join(h, "state"), { recursive: true });
      const vault = makeVault(join(h, "vault"));
      const a = await startServer({
        home: h,
        vault,
        secrets,
        extra: { VC_PORT: String(pub), VC_BACKEND_PORT: String(pa), VC_TEST_CGROUP_FS: fs, VC_TEST_SELF_CGROUP: selfCgroup, VC_TEST_PARENT_COMM: "systemd" },
      });
      running.push(a);
      writeFileSync(join(unitDir, "cgroup.procs"), `${a.proc.pid}\n${straggler.pid}\n`);
      const nextP = startServer({ home: h, vault, secrets, extra: { VC_PORT: String(pub), VC_BACKEND_PORT: String(pb) } });
      await waitFor(() => existsSync(join(h, "state", "standby")), 60_000, 50);
      a.proc.kill("SIGUSR2");
      expect(await a.exited).toBe(0);
      running.push(await nextP);
      await waitFor(() => straggler.exitCode !== null || straggler.signalCode !== null, 5000, 25);
      expect(straggler.signalCode).toBe("SIGTERM");
    } finally {
      for (const s of running.splice(-2)) await s.stop().catch(() => {});
      cleanup(h);
    }
  }, 120_000);
});
