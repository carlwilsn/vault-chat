// The voice pipeline as a versioned box part (server/voicePipeline.ts): each version kept in voice/versions/<v>/, a new
// one taken and noted, one not yet proven that exits or never says ready is dropped and the previous one starts in its
// place, a proven one is never dropped, and every take and switch back becomes a box.voice.switch record.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ children: [] as any[], cwd: [] as string[] }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return {
    ...real,
    spawnSync: (...args: any[]) => (args[0] === "uv" ? { status: 0 } : (real.spawnSync as any)(...args)),
    spawn: (_cmd: string, _args: string[], o: any) => {
      fake.cwd.push(o.cwd);
      const p = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
      fake.children.push(p);
      return p;
    },
  };
});
import { pipelineState, pipelineVersion, readVoicePart, stopPipeline, wantPipeline } from "../voicePipeline";
import { recordVoiceSwitches, VOICE_SWITCH, type ServerSwitch } from "../serverSwitches";
import { cleanup, freePort, ROOT, tmp } from "./helpers";

let root = "";
afterEach(() => {
  stopPipeline();
  cleanup(root);
  fake.children = [];
  fake.cwd = [];
});

function seed(): string {
  root = tmp("voice-part-");
  const voice = join(root, "voice");
  mkdirSync(join(voice, "venv/bin"), { recursive: true });
  writeFileSync(join(voice, "venv/bin/python"), "");
  writeFileSync(join(voice, "venv.stamp"), createHash("sha256").update(readFileSync(join(ROOT, "voice-pipeline/requirements.txt"))).digest("hex").slice(0, 16));
  return voice;
}

/** An earlier, proven version on disk (same requirements, another bot.py), current in the part file. */
function earlier(voice: string): string {
  const v = "0badc0de";
  const d = join(voice, "versions", v);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "bot.py"), "# the earlier pipeline\n");
  writeFileSync(join(d, "requirements.txt"), readFileSync(join(ROOT, "voice-pipeline/requirements.txt")));
  writeFileSync(join(voice, "part.json"), JSON.stringify({ current: v, previous: null, proven: [v], bad: [] }));
  return v;
}

it("a new version is taken and noted; once it says ready it is proven", async () => {
  const voice = seed();
  const old = earlier(voice);
  const mine = pipelineVersion();
  await wantPipeline({ stateDir: root, serverPort: await freePort(), port: await freePort() }, true);
  await vi.waitFor(() => expect(fake.children).toHaveLength(1));
  expect(fake.cwd[0]).toBe(join(voice, "versions", mine));
  expect(existsSync(join(voice, "versions", mine, "bot.py"))).toBe(true);
  expect(readVoicePart(voice)).toMatchObject({ current: mine, previous: old });
  fake.children[0].stdout.write("[voice ready]\n");
  expect(pipelineState()).toMatchObject({ running: true, version: mine });
  expect(readVoicePart(voice).proven).toContain(mine);
  // Proven: a later exit is an ordinary failure, never a switch back.
  fake.children[0].emit("exit", 1);
  expect(fake.children).toHaveLength(1);
  expect(readVoicePart(voice).current).toBe(mine);
  const recs: ServerSwitch[] = [];
  expect(recordVoiceSwitches(root, (r) => (recs.push(r), true))).toBe(1);
  expect(recs[0]).toMatchObject({ type: VOICE_SWITCH, change: "keep", to: { version: mine }, from: { version: old } });
});

it("a new version that exits before it is ready is dropped and the previous one starts in its place, for good", async () => {
  const voice = seed();
  const old = earlier(voice);
  const mine = pipelineVersion();
  const o = { stateDir: root, serverPort: await freePort(), port: await freePort() };
  await wantPipeline(o, true);
  await vi.waitFor(() => expect(fake.children).toHaveLength(1));
  fake.children[0].exitCode = 1;
  fake.children[0].emit("exit", 1);
  expect(fake.children).toHaveLength(2);
  expect(fake.cwd[1]).toBe(join(voice, "versions", old));
  expect(readVoicePart(voice)).toMatchObject({ current: old, bad: [mine] });
  fake.children[1].stdout.write("[voice ready]\n");
  expect(pipelineState()).toMatchObject({ running: true, version: old, failure: null });
  const recs: ServerSwitch[] = [];
  recordVoiceSwitches(root, (r) => (recs.push(r), true));
  expect(recs.map((r) => r.change)).toEqual(["keep", "switch"]);
  expect(recs[1]).toMatchObject({ to: { version: old }, from: { version: mine }, reason: expect.stringContaining("before it was ready") });
  // The next start of this server never runs the bad version again.
  stopPipeline();
  await wantPipeline(o, true);
  await vi.waitFor(() => expect(fake.children).toHaveLength(3));
  expect(fake.cwd[2]).toBe(join(voice, "versions", old));
});

it("a new version that never says ready is stopped and the previous one starts; a port conflict is never the version's fault", async () => {
  const voice = seed();
  const old = earlier(voice);
  const mine = pipelineVersion();
  const o = { stateDir: root, serverPort: await freePort(), port: await freePort(), readyWaitMs: 50 };
  await wantPipeline(o, true);
  await vi.waitFor(() => expect(fake.children).toHaveLength(1));
  await vi.waitFor(() => expect(fake.children[0].kill).toHaveBeenCalledWith("SIGTERM"));
  fake.children[0].emit("exit", null);
  expect(fake.cwd[1]).toBe(join(voice, "versions", old));
  expect(readVoicePart(voice).bad).toEqual([mine]);

  // A conflict on the port: no switch, the version stays good.
  stopPipeline();
  writeFileSync(join(voice, "part.json"), JSON.stringify({ current: old, previous: null, proven: [old], bad: [] }));
  await wantPipeline(o, true);
  await vi.waitFor(() => expect(fake.children).toHaveLength(3));
  fake.children[2].stderr.write(`[voice bind] port=${o.port} errno=98\n`);
  fake.children[2].exitCode = 98;
  fake.children[2].emit("exit", 98);
  expect(fake.children).toHaveLength(3);
  expect(readVoicePart(voice).bad).toEqual([]);
  expect(pipelineState().failure).toMatchObject({ code: "VOICE_PORT_CONFLICT" });
});
