// Projects by Carl's ask (reports: "No way to start or enter a project by voice"), through the real engine on a fake
// pi and the box's real voice routes (ElevenLabs faked):
//   - the rule: Carl makes projects in the app OR by asking in so many words; never the agent on its own;
//   - OpenProject (the existing createProjectWithThread, as a tool): "start a project for HW4" makes it and its
//     thread; "let's work on X" opens an existing one only; "back to Main" returns home;
//   - the surfaces follow: a feed signal the laptop and phone open, and a live call's lines, tools and updates go to
//     that thread from then on (one agent; the thread is where it works).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";

let rig: Rig;
let voice: typeof import("../voice");
const signals: Record<string, unknown>[] = [];
beforeAll(async () => {
  rig = await makeRig({ deps: { broadcast: (ev: Record<string, unknown>) => signals.push(ev) } });
  voice = await import("../voice");
});
afterAll(async () => {
  rig?.engine?.stop();
  cleanup(rig?.root);
});

const out = (r: any) => String(r?.text ?? "");
const settle = async (s: { convId: string; tid: string }) => {
  rig.backend.end(s.tid);
  await until(async () => (await rig.readConv(s.convId))?.state !== "running");
};
const said = async (convId: string) => ((await rig.readConv(convId))?.messages ?? []).map((m: any) => String(m.content ?? ""));

describe("the rule: Carl makes projects in the app or by asking, never the agent on its own", () => {
  it("every thread is told so, and pi has OpenProject (ListProjects still only reads)", async () => {
    const { PROJECTS_RULE } = await import("../context");
    expect(PROJECTS_RULE).not.toContain("you never do");
    expect(PROJECTS_RULE).toContain('Only Carl makes projects: in the app ("Make this a project", "+ New project"), or by asking you in so many words, spoken or typed ("start a project for HW4"); then OpenProject makes it. Never make one on your own initiative.');
    const s = await rig.start("Fix the typo in notes/a.md.");
    const th = rig.backend.threads.at(-1);
    const tool = (th.tools as any[]).find((t) => t.name === "OpenProject");
    expect(tool).toBeTruthy();
    expect(String(tool.description)).toMatch(/^Only when Carl asks, in so many words, spoken or typed/);
    expect(String(tool.description)).toContain("Never on your own initiative");
    expect(String(th.instructions)).toContain(PROJECTS_RULE);
    // Voice's Ask (a side thread with the action tools) has it too: that is how a spoken ask reaches it.
    const { voiceSideToolSpecs } = await import("../engine/engine");
    expect(voiceSideToolSpecs(true).some((t) => t.name === "OpenProject")).toBe(true);
    await settle(s);
  });
});

describe("OpenProject", () => {
  it('typed in Main, "start a project for HW4, make me practice problems": the project, its thread, the screens follow, the work runs there', async () => {
    const s = await rig.start("Start a project for HW4 and make me practice problems.", { convId: "main" });
    const n = signals.length;
    const r = await rig.backend.call(s.tid, "OpenProject", { project: "HW4", create: true, request: "Make me practice problems for HW4." });
    expect(r.ok).toBe(true);
    // A project is a folder with its own conversation: a new folder HW4 in the vault.
    expect(out(r)).toMatch(/^Started project HW4 \(the folder \S.*HW4\); its thread is project-hw4\. His screens are there now/);
    expect(out(r)).toContain("His request went to that thread, which is doing it now: don't do it here too.");
    expect(existsSync(join(rig.vault, "HW4", ".vault-chat", "project-memory.md"))).toBe(true);
    expect(signals.slice(n)).toContainEqual({ type: "follow", convId: "project-hw4", title: "HW4", project: "hw4", created: true });
    // The work is the project thread's own turn, with his words.
    await until(async () => (await said("project-hw4")).includes("Make me practice problems for HW4."));
    expect((await rig.readConv("project-hw4")).project).toBe("hw4");
    await settle(s);
  });

  it('"let\'s work on project X": an existing project opens (nothing new made); an unknown one is a question, not a project', async () => {
    const s = await rig.start("Let's work on project hw4.", { convId: "main" });
    const n = signals.length;
    const r = await rig.backend.call(s.tid, "OpenProject", { project: "hw4" });
    expect(r.ok).toBe(true);
    expect(out(r)).toMatch(/^Opened project HW4 /);
    expect(signals.slice(n)).toEqual([{ type: "follow", convId: "project-hw4", title: "HW4", project: "hw4" }]);
    const miss = await rig.backend.call(s.tid, "OpenProject", { project: "Physics" });
    expect(miss.ok).toBe(false);
    expect(out(miss)).toBe('Carl has no project "Physics" (his projects: HW4). Nothing changed. If he asked to start it, call OpenProject again with create: true; otherwise ask him which one he means.');
    expect(existsSync(join(rig.vault, "Physics"))).toBe(false);
    // Back home.
    const home = await rig.backend.call(s.tid, "OpenProject", { project: "main" });
    expect(out(home)).toBe("Back in Main. His screens are there now; what he says next arrives there.");
    expect(signals.at(-1)).toEqual({ type: "follow", convId: "main", title: "Main" });
    await settle(s);
  });
});

describe("a live call follows him to the thread", () => {
  const fakeEl = () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (!url.startsWith("https://api.elevenlabs.io/")) return real(input, init);
      if (url.includes("/convai/agents/create")) return new Response(JSON.stringify({ agent_id: "agent_follow" }), { status: 200 });
      if (url.includes("/get_signed_url")) return new Response(JSON.stringify({ signed_url: "wss://fake.elevenlabs/x" }), { status: 200 });
      if (url.includes("/conversation/token")) return new Response(JSON.stringify({ token: "fake-webrtc" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return () => (globalThis.fetch = real);
  };

  it('spoken "start a project for Coconut": the Ask makes it, then the call\'s lines, Asks and updates are that thread\'s', async () => {
    const restore = fakeEl();
    try {
      voice.resetVoiceSessionsForTests();
      (await import("../../src/store")).useStore.setState({ serviceKeys: { elevenlabs: "el-canary-key" } });
      const asked: any[] = [];
      let during: ((b: any) => Promise<void>) | null = null;
      const deps = {
        vault: rig.vault,
        name: "main",
        main: true,
        message: (b: any) => rig.engine.message(b),
        side: {
          start: async (b: any) => (asked.push(b), { id: `vs${asked.length}` }),
          wait: async (id: string) => {
            const b = asked[Number(id.slice(2)) - 1]!;
            if (during) await during(b);
            return { text: "Started project Coconut; we're in it now.", error: null };
          },
        },
      } as any;
      const ses = await voice.voiceSession("main", deps, { device: "laptop" });
      expect(ses.status).toBe(200);
      expect(ses.body.convId).toBe("main");
      const sid = String(ses.body.sessionId);
      // His words go to the agent (Ask, a side thread of Main), which calls OpenProject: his explicit ask.
      let opened: any = null;
      during = async (b) => {
        opened = await rig.backend.h.sideTool(b.convId, "OpenProject", { project: "Coconut", create: true });
      };
      const n = signals.length;
      await voice.voiceTool(deps, { name: "Ask", args: { request: "Start a project for Coconut.", act: true }, convId: "main", device: "laptop", sessionId: sid });
      await voice.voiceAsksSettled();
      expect(asked.at(-1)!.convId).toBe("main");
      expect(String(opened?.text)).toMatch(/^Started project Coconut .* His screens and the live call are there now/);
      expect(signals.slice(n)).toContainEqual({ type: "follow", convId: "project-coconut", title: "Coconut", project: "coconut", created: true });
      expect(voice.liveVoiceSession()?.convId).toBe("project-coconut");
      // The client still names Main; the box writes the call into the project's thread.
      const line = await voice.voiceTranscript(deps, { convId: "main", role: "user", text: "Make me three practice problems.", device: "laptop", sessionId: sid });
      expect(line.body.convId).toBe("project-coconut");
      expect(await said("project-coconut")).toContain("Make me three practice problems.");
      expect(await said("main")).not.toContain("Make me three practice problems.");
      // His next request is worked in that thread.
      during = null;
      const t = await voice.voiceTool(deps, { name: "Ask", args: { request: "Make them about tree height.", act: true }, convId: "main", device: "laptop", sessionId: sid });
      await voice.voiceAsksSettled();
      expect(t.convId).toBe("project-coconut");
      expect(asked.at(-1)!.convId).toBe("project-coconut");
      // Its updates are the thread's: a result there reaches the call.
      const cur = (await voice.voiceUpdates(deps, { convId: "main", session: sid })).cursor;
      const done = voice.voiceUpdates(deps, { convId: "main", cursor: cur, waitMs: 8000, session: sid });
      await voice.voiceTool(deps, { name: "Ask", args: { request: "How many are there?" }, convId: "main", device: "laptop", sessionId: sid });
      const got = await done;
      expect(got.updates.some((u) => u.kind === "result")).toBe(true);
    } finally {
      restore();
    }
  });
});
