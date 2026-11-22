// The model on the box (server/model/, report 24 §4) and its parity check: every way the app changes a moved noun is an
// action of that noun on the box, and every action the box has is one the app has. Listed from the app's own source,
// so a new control that bypasses the model fails here. Settings (noun 1), notes (noun 2), pages (noun 3), workspace (noun 4),
// history (noun 5, read-only), jobs (noun 6), chats (noun 7).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvLog } from "../convlog/log";
import { SETTING_KEYS } from "../../src/settingsRecords";
import { configureSettings } from "../settings";
import { nextChange, noun, nouns } from "../model";
import { actBoxOffer, readBoxOffer, watchBoxOffer } from "../boxOffers";
import { agentToolSpecs } from "../engine/engine";

const SRC = join(__dirname, "..", "..", "src");
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}
const source = files(SRC).map((f) => [f.slice(SRC.length + 1), readFileSync(f, "utf8")] as const);
const PHONE = join(__dirname, "..", "..", "phone", "src");
const phone = files(PHONE).map((f) => [`phone/${f.slice(PHONE.length + 1)}`, readFileSync(f, "utf8")] as const);

/** Every way the app changes a setting, as "set:<key>", read from its source. */
function uiSettingsActions(): { actions: Set<string>; exempt: string[] } {
  const actions = new Set<string>();
  const exempt: string[] = [];
  for (const [f, s] of source) {
    for (const m of s.matchAll(/(?<!function )saveSetting\(\s*("([^"]+)"|([A-Za-z_.]+))/g)) {
      if (m[2]) actions.add(`set:${m[2]}`);
      // A key the user picks from the whole list (the Settings plugin's change action): every setting.
      else if (f.startsWith("plugins/settings/")) for (const k of SETTING_KEYS) actions.add(`set:${k}`);
      else throw new Error(`${f}: saveSetting with a computed key (${m[3]}): name it, or add it here`);
    }
    // The composer's model picker: model and effort, through the engine (it also restarts the running session).
    if (/boxPost\([^)]*"\/api\/v1\/model"/.test(s)) ["model", "effort"].forEach((k) => actions.add(`set:${k}`));
    for (const m of s.matchAll(/boxPost\([^,]+,\s*"\/api\/v2\/settings",\s*\{\s*(\w+)/g)) {
      if (m[1] === "key") continue; // saveSetting itself
      if (m[1] === "migrate") exempt.push(`${f}: migrate (a laptop's own old settings moved once; not a control)`);
      else throw new Error(`${f}: POST /api/v2/settings {${m[1]}…}: a settings change the model has no action for`);
    }
  }
  return { actions, exempt };
}

/** Every way the app and the phone change a note, as the notes noun's action names, read from their source. */
const ROUTE: Record<string, string[]> = { "/notes/edit": ["edit"], "/notes/status": ["resolve", "reopen"], "/notes/delete": ["delete"], "/notes/clear-resolved": ["clearResolved"] };
const NOTE_ACTION: Record<string, string> = { edit: "/notes/edit", status: "/notes/status", delete: "/notes/delete", "clear-resolved": "/notes/clear-resolved" };
const HOST_NOTES: Record<string, string[]> = { add: ["add"], saveDraft: ["edit"], setStatus: ["resolve", "reopen"], remove: ["delete"], clearResolved: ["clearResolved"] };
/** Panel controls that are not a change to a note (each named, with why). */
const HOST_NOTES_EXEMPT: Record<string, string> = { reformat: "re-summarize: rebuilds the cached summary on the laptop (an AI call); the note's own text is unchanged" };
/** Whole-file note writes that are not one of Carl's controls (each file named, with why). */
const NOTE_WRITES_EXEMPT: Record<string, string> = {
  "store.ts": "rename/delete cascades rewrite anchors, the summary cache, and the no-box fallback of each control",
  "hostBackend.ts": "the no-box fallback of edit",
  "notes.ts": "the write itself and compactNotes (dedupe, no box)",
};
function uiNotesActions(): { actions: Set<string>; exempt: string[] } {
  const actions = new Set<string>();
  const exempt: string[] = [];
  for (const [f, s] of [...source, ...phone]) {
    for (const m of s.matchAll(/["'`](\/notes(?:\/[a-z-]+)?)["'`]/g)) {
      const r = m[1]!;
      if (r === "/notes") {
        // POST /notes: add (the app's {note} built from a capture, the phone's {text}); GET /notes reads.
        if (/method:\s*"POST"|boxPost/.test(s)) actions.add("add");
      } else if (r === "/notes/write") {
        if (f !== "notes.ts") throw new Error(`${f}: a whole-file notes write (/notes/write) outside src/notes.ts`);
      } else if (ROUTE[r]) ROUTE[r]!.forEach((a) => actions.add(a));
      else if (!f.startsWith("phone/mock")) throw new Error(`${f}: ${r}: a notes route the model has no action for`);
    }
    for (const m of s.matchAll(/noteAction\([^,]+,\s*"([a-z-]+)"/g)) {
      const r = NOTE_ACTION[m[1]!];
      if (!r) throw new Error(`${f}: noteAction "${m[1]}": the model has no such action`);
      ROUTE[r]!.forEach((a) => actions.add(a));
    }
    if (f.startsWith("plugins/notes/")) for (const m of s.matchAll(/host\.notes\.(\w+)/g)) {
      if (HOST_NOTES_EXEMPT[m[1]!]) {
        exempt.push(`${f}: host.notes.${m[1]}: ${HOST_NOTES_EXEMPT[m[1]!]}`);
        continue;
      }
      const to = HOST_NOTES[m[1]!];
      if (!to) throw new Error(`${f}: host.notes.${m[1]}: a notes control the model has no action for`);
      to.forEach((a) => actions.add(a));
    }
    if (/\bwriteAllNotes\(/.test(s) && !f.startsWith("phone/")) {
      if (!NOTE_WRITES_EXEMPT[f]) throw new Error(`${f}: writes the notes file whole: call the box's notes action (noteAction) instead, or name why here`);
      exempt.push(`${f}: ${NOTE_WRITES_EXEMPT[f]}`);
    }
  }
  return { actions, exempt };
}

/** Every way the app turns a page or an app part on or off, as the pages noun's action names, from its POSTs to
 *  /api/v2/supervisor. A word on a change ({change: keep | discard | switch}: the core bundle, a draft) is not a page's
 *  on/off: each such line is named. */
function uiPagesActions(): { actions: Set<string>; exempt: string[] } {
  const actions = new Set<string>();
  const exempt: string[] = [];
  for (const [f, s] of [...source, ...phone]) {
    for (const l of s.split("\n")) {
      if (!l.includes("/api/v2/supervisor") || !/boxPost\(|\.post\(|method:\s*"POST"/.test(l)) continue;
      if (/change:|,\s*body\)/.test(l)) {
        exempt.push(`${f}: a word on a change (the core bundle's switch, a draft): not a page's on/off`);
        continue;
      }
      if (/"running"\s*:\s*"stopped"/.test(l)) ["enable", "disable"].forEach((a) => actions.add(a));
      else if (/state:\s*"running"/.test(l)) actions.add("enable");
      else if (/state:\s*"stopped"/.test(l)) actions.add("disable");
      else throw new Error(`${f}: POST /api/v2/supervisor the pages noun has no action for: ${l.trim().slice(0, 160)}`);
    }
  }
  return { actions, exempt };
}
/** The pages noun's actions no control of the app has (each named, with why). */
const PAGES_MODEL_ONLY: Record<string, string> = { budget: "a page's budget is set by asking the agent; the app shows its effect (turned off by budget)" };

const root = mkdtempSync(join(tmpdir(), "vc-model-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
beforeEach(() => {
  const dir = join(root, `log${++n}`);
  const log = new ConvLog(dir, null, join(dir, "events"));
  configureSettings({ log: () => log });
});
const deps = { vault: root };

describe("the model's settings noun", () => {
  it("parity: the app's settings changes are exactly the model's", () => {
    const { actions, exempt } = uiSettingsActions();
    const set = noun("settings", deps)!.actions.set!.args as { properties: { key: { enum: string[] } } };
    const model = new Set(set.properties.key.enum.map((k) => `set:${k}`));
    expect([...actions].filter((a) => !model.has(a)), "app actions the model lacks").toEqual([]);
    expect([...model].filter((a) => !actions.has(a)), "model actions the app lacks").toEqual([]);
    expect(Object.keys(noun("settings", deps)!.actions)).toEqual(["set"]);
    expect(exempt.length).toBeLessThanOrEqual(1);
  });

  it("is box:settings: read, set by the agent, refused with nothing changed, and watched without re-reading", async () => {
    let r = await readBoxOffer(deps, "box:settings");
    expect((r.state!.values as any).theme).toMatchObject({ value: "graphite", set: "default" });
    const watched = watchBoxOffer(deps, "box:settings", 5_000);
    const a = await actBoxOffer(deps, "box:settings", "set", { key: "theme", value: "light" });
    expect(a.ok).toBe(true);
    expect(a.text).toBe('theme is now "light" (was "graphite"). Every open app and the phone follow it.');
    const w = await watched;
    expect(w.changed).toBe(true);
    expect((w.state!.values as any).theme).toMatchObject({ value: "light", set: "agent" });
    expect((await actBoxOffer(deps, "box:settings", "set", { key: "apiKey", value: "x" })).text).toMatch(/No setting "apiKey"; nothing changed/);
    expect((await actBoxOffer(deps, "box:settings", "set", { key: "theme", value: "purple" })).text).toMatch(/theme takes .*nothing changed/);
    r = await readBoxOffer(deps, "box:settings");
    expect((r.state!.values as any).theme.value).toBe("light");
    expect(await nextChange(noun("settings", deps)!, 30)).toBe(false);
  });

  it("the engine's model and effort follow it", async () => {
    const { engineModel, engineEffort } = await import("../engine");
    const before = engineModel();
    await actBoxOffer(deps, "box:settings", "set", { key: "model", value: "sonnet" });
    await actBoxOffer(deps, "box:settings", "set", { key: "effort", value: "high" });
    expect(engineModel()).toBe("sonnet");
    expect(engineEffort()).toBe("high");
    await actBoxOffer(deps, "box:settings", "set", { key: "model", value: null });
    expect(engineModel()).toBe(before);
  });

  it("a moved noun has no tool of its own", () => {
    const names = agentToolSpecs().map((t) => t.name);
    for (const x of nouns(deps)) expect(names).not.toContain(x.name);
  });
});

describe("the model's notes noun", () => {
  it("parity: the app's and the phone's note controls are exactly the model's", () => {
    const { actions, exempt } = uiNotesActions();
    const model = new Set(Object.keys(noun("notes", deps)!.actions));
    expect([...actions].filter((a) => !model.has(a)), "app actions the model lacks").toEqual([]);
    expect([...model].filter((a) => !actions.has(a)), "model actions the app lacks").toEqual([]);
    expect(new Set(exempt).size).toBeLessThanOrEqual(Object.keys(NOTE_WRITES_EXEMPT).length + Object.keys(HOST_NOTES_EXEMPT).length);
  });

  it("is box:notes: added, edited in place, resolved, cleared, and watched without re-reading", async () => {
    const watched = watchBoxOffer(deps, "box:notes", 5_000);
    const a = await actBoxOffer(deps, "box:notes", "add", { text: "buy chalk" });
    expect(a.ok, a.text).toBe(true);
    const w = await watched;
    expect(w.changed).toBe(true);
    const id = (w.state!.open as any[])[0].id as string;
    expect((w.state!.open as any[])[0].text).toBe("buy chalk");
    expect((await actBoxOffer(deps, "box:notes", "edit", { id, text: "buy chalk and erasers" })).text).toContain(`Updated note ${id} in place`);
    expect((await actBoxOffer(deps, "box:notes", "resolve", { id })).ok).toBe(true);
    let r = await readBoxOffer(deps, "box:notes");
    expect(r.state!.open).toEqual([]);
    expect((r.state!.resolved as any[])[0]).toMatchObject({ id, text: "buy chalk and erasers" });
    expect((await actBoxOffer(deps, "box:notes", "clearResolved", {})).text).toBe("Cleared 1 resolved note(s) from the Notes panel (git history keeps them).");
    r = await readBoxOffer(deps, "box:notes");
    expect(r.state!.resolved).toEqual([]);
    expect((await actBoxOffer(deps, "box:notes", "delete", { id: "nope" })).text).toMatch(/no note with id "nope".*nothing changed/);
    expect(await nextChange(noun("notes", deps)!, 30)).toBe(false);
  });
});

describe("the model's pages noun", () => {
  it("parity: the app's page on/off controls are exactly the model's", () => {
    const { actions, exempt } = uiPagesActions();
    const model = new Set(Object.keys(noun("pages", deps)!.actions).filter((a) => !PAGES_MODEL_ONLY[a]));
    expect([...actions].filter((a) => !model.has(a)), "app actions the model lacks").toEqual([]);
    expect([...model].filter((a) => !actions.has(a)), "model actions the app lacks").toEqual([]);
    expect(exempt.length).toBeLessThanOrEqual(3);
  });

  it("is box:pages: turned off and on by name, a budget, refused with nothing changed, and watched without re-reading", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(root, "pages"), { recursive: true });
    writeFileSync(join(root, "pages", "html-lab.html"), '<!doctype html><html><head><title>HTML lab</title><meta name="vc-capabilities" content="state"></head><body></body></html>');
    let r = await readBoxOffer(deps, "box:pages");
    expect((r.state!.list as any).plugins).toEqual(["pages/html-lab.html: on | HTML lab"]);
    const watched = watchBoxOffer(deps, "box:pages", 5_000);
    const a = await actBoxOffer(deps, "box:pages", "disable", { plugin: "html-lab", reason: "too slow" });
    expect(a.text).toBe("pages/html-lab.html: off (by agent: too slow). Every view of it follows (the viewer, chats, the phone, its link).");
    const w = await watched;
    expect(w.changed).toBe(true);
    expect((w.state!.list as any).plugins[0]).toMatch(/^pages\/html-lab\.html: off \(by agent: too slow\)/);
    expect((await actBoxOffer(deps, "box:pages", "budget", { plugin: "html-lab", callsPerMinute: 30 })).text).toBe("pages/html-lab.html: off (by agent: too slow); budget 30 calls a minute");
    expect((await actBoxOffer(deps, "box:pages", "enable", { plugin: "pages/html-lab.html" })).ok).toBe(true);
    expect((await actBoxOffer(deps, "box:pages", "disable", { plugin: "notes" })).text).toContain("app/notes: off (by agent)");
    r = await readBoxOffer(deps, "box:pages");
    expect((r.state!.list as any).plugins[0]).toMatch(/^pages\/html-lab\.html: on \(by agent\); budget 30/);
    expect((r.state!.list as any).parts).toEqual(["app/notes: off (by agent)"]);
    expect((await actBoxOffer(deps, "box:pages", "disable", { plugin: "nothing-here" })).text).toMatch(/no page in the vault is named nothing-here; nothing changed/);
    expect(await nextChange(noun("pages", deps)!, 30)).toBe(false);
  });
});

describe("the model's workspace noun", () => {
  it("parity: every layout op the app has (src/layoutOps.ts, what the title bar and plugins call) is a workspace action", () => {
    // Read from source (src/layoutOps.ts imports the app's store).
    const ops = readFileSync(join(SRC, "layoutOps.ts"), "utf8");
    const LAYOUT_OPS = JSON.parse(`[${/export const LAYOUT_OPS = \[([^\]]+)\]/.exec(ops)![1]}]`) as string[];
    const app = new Set<string>([...LAYOUT_OPS, "openChat"]);
    // Every op the app applies is listed in LAYOUT_OPS (a case in applyOne that is not listed would bypass the model).
    for (const m of ops.matchAll(/case "(\w+)":/g)) expect(LAYOUT_OPS, `src/layoutOps.ts case ${m[1]}`).toContain(m[1]);
    const model = new Set(Object.keys(noun("workspace", deps)!.actions).filter((a) => a !== "arrange"));
    expect([...app].filter((a) => !model.has(a)), "app layout ops the model lacks").toEqual([]);
    expect([...model].filter((a) => !app.has(a)), "model actions the app lacks").toEqual([]);
  });

  it("is box:workspace: no link, nothing changed; the Layout tool is gone", async () => {
    const r = await actBoxOffer(deps, "box:workspace", "closeLeftPanel", {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/no link to the laptop here; nothing changed/);
    expect(agentToolSpecs().map((t) => t.name)).not.toContain("Layout");
  });
});

describe("the model's history noun", () => {
  it("parity: history is read-only: the app only appends to it (no control changes it), and every model action is a search", () => {
    const h = noun("history", deps)!;
    expect(Object.entries(h.actions).filter(([, a]) => !a.readOnly).map(([k]) => k), "history actions that change something").toEqual([]);
    expect(Object.keys(h.actions).sort()).toEqual(["activity", "search", "transcript"]);
    const names = agentToolSpecs().map((t) => t.name);
    for (const old of ["RecentActivity", "SearchHistory"]) expect(names).not.toContain(old);
  });

  it("is box:history: the activity search finds an appended entry, its watch hears the append, a search reads nothing back", async () => {
    const { appendActivity } = await import("../activity");
    const changed = nextChange(noun("history", deps)!, 5_000);
    appendActivity(root, { kind: "ask", modality: "ctrl-l", text: 'asked "what is a Gram matrix?"', detail: "answer: inner products." });
    expect(await changed).toBe(true);
    const r = await actBoxOffer(deps, "box:history", "activity", { query: "gram", hours: 1 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Gram matrix");
    expect(r.state).toBeUndefined();
    expect((await actBoxOffer(deps, "box:history", "activity", { query: "nothing like this" })).text).toMatch(/^Nothing in the last 24 h/);
    const t = await actBoxOffer(deps, "box:history", "transcript", { query: "x" });
    expect(t.ok).toBe(false);
    expect(t.text).toMatch(/No thread to search/);
    expect((await actBoxOffer(deps, "box:history", "transcript", {})).text).toMatch(/needs query\. Nothing was run/);
  });
});

describe("the model's jobs noun", () => {
  /** What the chat's background-task chip does to a worker or job (src/boxChat.ts boxSubagent → POST …/subagents/:sid/{op}). */
  function uiJobActions(): Set<string> {
    const out = new Set<string>();
    for (const [, s] of [...source, ...phone]) {
      if (!/\/subagents\/\$\{[^}]+\}\/\$\{op\}/.test(s)) continue;
      const m = /op:\s*((?:"[a-z]+"\s*\|?\s*)+)/.exec(s);
      for (const x of m?.[1]?.match(/"([a-z]+)"/g) ?? []) out.add(x.slice(1, -1));
    }
    return out;
  }
  const calls: string[] = [];
  const ctl = (turn: boolean) => ({
    turn,
    list: (all: boolean) => `- job-1: running${all ? " (all)" : ""}`,
    status: (id: string) => `${id}: running, 3 tool calls`,
    control: async (id: string, op: "stop" | "steer", text?: string) => (calls.push(`${op}:${id}${text ? `:${text}` : ""}`), { ok: true, text: `${op} ${id}` }),
  });

  it("parity: the chip's Stop and Steer are exactly the model's changing actions; the old tools are gone", () => {
    const j = noun("jobs", { ...deps, jobs: ctl(true) })!;
    const changing = Object.entries(j.actions).filter(([, a]) => !a.readOnly).map(([k]) => k).sort();
    expect(changing).toEqual([...uiJobActions()].sort());
    expect(changing).toEqual(["steer", "stop"]);
    const names = agentToolSpecs().map((t) => t.name);
    for (const old of ["JobList", "JobStatus", "JobStop", "JobSteer"]) expect(names).not.toContain(old);
    expect(noun("jobs", deps), "no jobs noun without a conversation").toBeNull();
  });

  it("is box:jobs: listed, a status reads nothing back, stop and steer reach the engine; a side thread only reads", async () => {
    calls.length = 0;
    const d = { ...deps, jobs: ctl(true) };
    expect((await readBoxOffer(d, "box:jobs")).state).toEqual({ list: "- job-1: running" });
    expect((await actBoxOffer(d, "box:jobs", "list", { all: true })).text).toBe("- job-1: running (all)");
    const st = await actBoxOffer(d, "box:jobs", "status", { id: "abc123" });
    expect(st.text).toBe("abc123: running, 3 tool calls");
    expect(st.state).toBeUndefined();
    const stop = await actBoxOffer(d, "box:jobs", "stop", { id: "job-1" });
    expect(stop.ok).toBe(true);
    expect(stop.state).toEqual({ list: "- job-1: running" });
    await actBoxOffer(d, "box:jobs", "steer", { id: "w1", message: "make it shorter" });
    expect(calls).toEqual(["stop:job-1", "steer:w1:make it shorter"]);
    expect((await actBoxOffer(d, "box:jobs", "steer", { id: "w1" })).text).toMatch(/needs message\. Nothing was run/);
    const side = { ...deps, jobs: ctl(false) };
    const r = await actBoxOffer(side, "box:jobs", "stop", { id: "job-1" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/needs an owning turn/);
    expect(calls).toHaveLength(2);
  });
});

describe("the model's chats noun", () => {
  /** The chat list's own actions (app/chats, src/plugins/chats/index.tsx chatsOffers), read from its source. */
  function uiChatActions(): string[] {
    const s = source.find(([f]) => f === "plugins/chats/index.tsx")![1];
    const body = s.slice(s.indexOf("actions: {"));
    return [...body.matchAll(/^ {6}(\w+): \{$/gm)].map((m) => m[1]!);
  }
  /** Where the list is on screen: the laptop's view, not a change to a chat (each named, with why). */
  const VIEW: Record<string, string> = {
    open: "which chat the pane shows (box:workspace openChat)",
    expand: "a place's chats shown on screen",
    collapse: "a place's chats hidden on screen",
    showMore: "how many rows the list shows",
    showLess: "how many rows the list shows",
    openPanel: "the list's panel on screen",
    closePanel: "the list's panel on screen",
  };
  /** The app's name for a control where the model's differs. */
  const AS: Record<string, string> = { newChat: "start" };
  /** What only the agent does, on Carl's ask (each named, with why). */
  const AGENT_ONLY: Record<string, string> = {
    restoreProject: "the app's Undo toast after a project delete, a transient control",
    openProject: "Carl's spoken / typed ask to move his screens and call to a project",
    post: "handing work to the chat that owns it",
  };
  const calls: string[] = [];
  const ok = (t: string) => async () => (calls.push(t), { ok: true, text: t });
  const ctl = {
    self: "c-self",
    list: async (n?: number) => `- c-1 — "Week 3" (${n ?? 25})`,
    read: async (id: string) => ({ ok: true, text: `read ${id}` }),
    projects: async (p?: string) => ({ ok: true, text: `projects ${p ?? "all"}` }),
    deleted: () => "No chat is deleted.",
    start: async (t: string, place?: string) => (calls.push(`start:${t}:${place ?? "main"}`), { ok: true, text: "started" }),
    rename: async (id: string, title?: string) => (calls.push(`rename:${id}:${title ?? "(summary)"}`), { ok: true, text: "renamed" }),
    renameProject: ok("renameProject"),
    delete: async (ids: string[]) => (calls.push(`delete:${ids.join(",")}`), { ok: true, text: "deleted" }),
    restore: ok("restore"),
    restoreProject: ok("restoreProject"),
    openProject: ok("openProject"),
    post: ok("post"),
  };

  it("parity: every chat-list control that changes a chat is a model action; the old tools are gone", () => {
    const c = noun("chats", { ...deps, chats: ctl })!;
    const changing = Object.entries(c.actions).filter(([, a]) => !a.readOnly).map(([k]) => k);
    const ui = uiChatActions();
    expect(ui.length).toBeGreaterThan(5);
    const want = ui.filter((k) => !(k in VIEW)).map((k) => AS[k] ?? k);
    expect(changing.filter((k) => !(k in AGENT_ONLY)).sort()).toEqual(want.sort());
    for (const k of Object.keys(VIEW)) expect(ui, `${k} is no longer a chat-list control: drop it from VIEW`).toContain(k);
    const names = agentToolSpecs().map((t) => t.name);
    for (const old of ["ListConversations", "ReadConversation", "ListProjects", "RenameConversation", "DeleteConversation", "RestoreConversation", "RestoreProject", "OpenProject", "PostToConversation"]) expect(names).not.toContain(old);
    expect(noun("chats", deps), "no chats noun without the engine").toBeNull();
  });

  it("is box:chats: read, reads change nothing, changes reach the engine with this chat as the default", async () => {
    calls.length = 0;
    const d = { ...deps, chats: ctl };
    expect((await readBoxOffer(d, "box:chats")).state).toEqual({ recent: '- c-1 — "Week 3" (25)', projects: "projects all" });
    const r = await actBoxOffer(d, "box:chats", "read", { id: "c-1" });
    expect(r.text).toBe("read c-1");
    expect(r.state).toBeUndefined();
    await actBoxOffer(d, "box:chats", "rename", { title: "Bench" });
    await actBoxOffer(d, "box:chats", "start", { text: "do X", place: "Physics" });
    await actBoxOffer(d, "box:chats", "delete", { ids: ["c-1"] });
    expect(calls).toEqual(["rename:c-self:Bench", "start:do X:Physics", "delete:c-1"]);
    expect((await actBoxOffer(d, "box:chats", "post", { id: "c-1" })).text).toMatch(/needs text\. Nothing was run/);
  });
});
