// The phone's MockDB (phone.html `installMock`) built from the same synthetic
// world the desktop scenarios load, so the phone shows the same missions,
// chats, alerts, notes and schedules. Injected as window.__VC_PREVIEW_DB__.
import * as W from "./world";
import type { Scenario } from "./types";

const VAULT = "/home/carl/vaults/summer-demo";

function summary(c: W.Conv) {
  const vis = c.messages.filter((m: any) => !m.hidden);
  const last = [...vis].reverse().find((m: any) => String(m.content ?? "").trim());
  return {
    id: c.id,
    title: c.title,
    source: c.source,
    role: c.role ?? "",
    mission: c.mission,
    lastActivityAt: c.lastActivityAt,
    msgCount: vis.length,
    preview: String(last?.content ?? "").replace(/\s+/g, " ").slice(0, 120),
    goal: c.source === "mission" ? String(c.messages[0]?.content ?? "") : c.source === "worker" ? String(c.messages[0]?.content ?? "") : "",
    taskSummary: c.taskSummary,
    statusSummary: c.statusSummary,
    thinkingDigest: c.thinkingDigest,
    doneWhenDone: c.doneWhenDone,
    completedAt: c.completedAt,
    missionState: c.missionState,
    costUsd: c.costUsd,
  };
}

function thread(c: W.Conv) {
  return {
    id: c.id,
    title: c.title,
    source: c.source,
    status: c.status ?? "idle",
    messages: c.messages
      .filter((m: any) => !m.hidden && !m.system)
      .map((m: any) => ({
        role: m.role,
        content: m.content,
        tools: (m.toolCalls ?? []).map((t: any) => t.name),
        timeline: m.timeline,
        direct: m.direct,
        decision: m.decision,
        askOptions: m.askOptions,
      })),
  };
}

export function phoneDB(sc: Scenario, now: number): any {
  const awaiting = sc.id === "missions-awaiting";
  const convs = [...W.chats(VAULT, now), ...W.missions(now, { awaiting })];
  const notifs = W.notifications(now, { awaiting }).map((l) => {
    const n = JSON.parse(l);
    return { ...n, read: false, summary: n.summary ?? "", body: n.body ?? "" };
  });
  if (awaiting) {
    const ask = notifs.find((n: any) => n.kind === "ask");
    if (ask)
      ask.deliberation = {
        mission: "BitNet 160M MVP",
        ask: ask.summary,
        askLong: "All three seeds are in tolerance; the remaining ~0.13 nat gap is token count. Two ways to go:",
        options: [
          { answer: "Extend one seed to 3.2B", primary: true, title: "Extend one seed first — a $31 probe", body: "Seed 42 at 3.2B tokens tells you whether the gap closes before spending on all three." },
          { answer: "Stop and write up", title: "Stop at 1.7B — write it up now", body: "The reproduction is already stable; report the gap and its cause." },
        ],
      };
  }
  const db: any = {
    vault: "summer-demo",
    model: "anthropic/claude-sonnet-5.5",
    convs: convs.map(summary),
    runs: [{ convId: "w-writeup", title: "eval table + writeup", mission: "BitNet 160M MVP", source: "worker", lastTool: "Write", lastProgressAt: now - 40_000 }],
    schedules: W.schedules(now).map((l) => {
      const s = JSON.parse(l);
      const label = s.recurrence.kind === "daily" ? `daily · ${s.time}` : s.recurrence.kind === "every" ? `every ${s.recurrence.minutes} min` : `weekly · ${s.time}`;
      return { id: s.id, name: s.name, prompt: s.prompt, label, enabled: s.enabled, lastFiredAt: s.lastFiredAt, quietUnlessAlert: !!s.quietUnlessAlert };
    }),
    notifs,
    notes: W.notes(now).map((l) => {
      const n = JSON.parse(l);
      return { id: n.id, status: n.status, timestamp: n.timestamp, last_updated: n.last_updated, title: null, user_draft: n.user_draft, turns: n.turns, anchors: n.anchors };
    }),
    threads: Object.fromEntries(convs.map((c) => [c.id, thread(c)])),
  };
  sc.phone?.db?.(db, now);
  return db;
}
