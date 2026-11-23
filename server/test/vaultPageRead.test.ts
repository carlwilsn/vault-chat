// Vault pages reachable like plugins (server/pluginOffersTool.ts over server/pluginState.ts): a vault .html that keeps
// its answers with vc.state (and vc.log) is read by PluginRead from the box's log, whether or not the page is open
// anywhere; the list names it with whether it is mounted now and when it last changed; `after` + `wait` follow its next
// change; `vault` reads a page in another registered vault. A page that keeps nothing says why (no state service).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";

const root = tmp("vcvp-");
const vault = join(root, "vault");
const other = join(root, "other");
mkdirSync(join(vault, "video"), { recursive: true });
mkdirSync(join(other, "quiz"), { recursive: true });

let tool: typeof import("../pluginOffersTool");
let st: typeof import("../pluginState");
let show: typeof import("../show");
let log: typeof import("../convlog/log");

const QUIZ = `<!doctype html><html><head><meta charset="utf-8"><meta name="vc-capabilities" content="state, log"><title>Video style quiz</title></head>
<body><div id="qs"></div><script>vc.offer({ state: { answers: { description: "the picks", read: () => ({}) } } });</script></body></html>`;

beforeAll(async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
  process.env.VC_STATE_DIR = join(root, "state");
  process.env.VC_VAULT = vault;
  process.env.VC_TOKEN_FILE = join(root, "token");
  writeFileSync(join(vault, "video", "style-quiz.html"), QUIZ);
  writeFileSync(join(vault, "video", "plain.html"), "<html><head><title>Plain</title></head><body><button>Copy answers</button></body></html>");
  writeFileSync(join(other, "quiz", "q.html"), QUIZ.replace("Video style quiz", "Other quiz"));
  tool = await import("../pluginOffersTool");
  st = await import("../pluginState");
  show = await import("../show");
  log = await import("../convlog/log");
});
afterAll(() => {
  log._resetConvLogs();
  cleanup(root);
});
beforeEach(() => show.resetPresence());

const PAGE = "video/style-quiz.html";
const set = (v: string, id: string, key: string, value: unknown) => expect(st.setPluginState(v, id, JSON.stringify({ key, value })).status).toBe(200);
const noLaptop = { vault, emit: () => {}, ackMs: 500 };

describe("PluginRead reaches a vault page's vc.state from the box", () => {
  it("a closed page (no device online): its saved state, last change and recent log, by path, file name or title", async () => {
    set(vault, PAGE, "medium", "a");
    set(vault, PAGE, "bg", "b");
    expect(st.appendPluginLog(vault, PAGE, JSON.stringify({ picked: "bg", choice: "b" })).status).toBe(200);
    for (const word of [PAGE, "style-quiz.html", "style-quiz", "Video style quiz", join(vault, PAGE)]) {
      const r = await tool.pluginOfferTool(noLaptop, "PluginRead", { plugin: word });
      expect(r.ok).toBe(true);
      expect(r.text).toContain(`${PAGE} "Video style quiz": kept on the box`);
      expect(r.text).toMatch(/the laptop is not online/);
      expect(r.text).toContain('"medium": "a"');
      expect(r.text).toContain('"bg": "b"');
      expect(r.text).toMatch(/recent log \(1 of 1/);
      expect(r.text).toContain('"choice": "b"');
      expect(r.text).toMatch(/last change: \d{4}-\d\d-\d\dT[\d:]+Z \(seq \d+/);
    }
  });

  it("the list names every page with records, mounted or not, with its last change; no device online is not a failure then", async () => {
    const r = await tool.pluginOfferTool(noLaptop, "PluginRead", {});
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/laptop isn't online/);
    expect(r.text).toMatch(/1 vault page\(s\) with state kept on the box/);
    expect(r.text).toMatch(/- video\/style-quiz\.html "Video style quiz": mounted: unknown \(no device online\); last change .*; state keys: medium, bg; log records: 1/);
  });

  it("the laptop online: the list says the page is mounted there; a read joins its live offers and the saved state", async () => {
    const sent: Record<string, unknown>[] = [];
    const emit = (ev: Record<string, unknown>) => {
      sent.push(ev);
      const plugin = { id: PAGE, name: "Video style quiz", state: [{ name: "answers", description: "the picks" }], actions: [], events: [] };
      const answer = ev.op === "list" ? { ok: true, plugins: [], pages: [PAGE] } : { ok: true, plugin, state: { answers: { medium: "a" } }, events: [{ event: "picked", at: 1 }] };
      queueMicrotask(() => show.ackShow(String(ev.id), { ok: true, data: { answer: JSON.stringify(answer) } }));
    };
    const leave = show.feedOpened(vault, "laptop");
    try {
      const list = await tool.pluginOfferTool({ vault, emit, ackMs: 2000 }, "PluginRead", {});
      expect(list.text).toMatch(/style-quiz\.html "Video style quiz": mounted now on the laptop/);
      const r = await tool.pluginOfferTool({ vault, emit, ackMs: 2000 }, "PluginRead", { plugin: "style-quiz" });
      expect(sent.at(-1)).toMatchObject({ op: "read", plugin: PAGE });
      expect(r.ok).toBe(true);
      expect(r.text).toMatch(/its offers read from the laptop now/);
      expect(r.text).toMatch(/recent events/);
      expect(r.text).toMatch(/mounted on the laptop now/);
      expect(r.text).toContain('"bg": "b"');
    } finally {
      leave();
    }
  });

  it("after + wait answers at the page's next change (Carl picks in the page while the agent follows)", async () => {
    const seq = st.readPluginRecords(vault, PAGE).seq;
    setTimeout(() => set(vault, PAGE, "motion", "b"), 150);
    const t0 = Date.now();
    const r = await tool.pluginOfferTool(noLaptop, "PluginRead", { plugin: PAGE, after: seq, wait: 10 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.text).toMatch(new RegExp(`something new since seq ${seq}`));
    expect(r.text).toContain('"motion": "b"');
    const idle = await tool.pluginOfferTool(noLaptop, "PluginRead", { plugin: PAGE, after: seq + 1, wait: 0.2 });
    expect(idle.text).toMatch(/nothing new since seq/);
  });

  it("a page with nothing recorded yet says why (Carl's input is recorded by itself once he clicks or types in it)", async () => {
    const r = await tool.pluginOfferTool(noLaptop, "PluginRead", { plugin: "video/plain.html" });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/No saved state or log records yet: Carl has not clicked, picked or typed in it/);
  });

  it("a page in another registered vault, by vault name or by absolute path; an unknown vault is refused", async () => {
    set(other, "quiz/q.html", "picked", 3);
    const vaults = () => [{ name: "main", path: vault }, { name: "other", path: other }];
    const d = { ...noLaptop, vaults };
    for (const a of [{ plugin: "quiz/q.html", vault: "other" }, { plugin: join(other, "quiz", "q.html") }]) {
      const r = await tool.pluginOfferTool(d, "PluginRead", a);
      expect(r.ok).toBe(true);
      expect(r.text).toContain('quiz/q.html "Other quiz" (vault other)');
      expect(r.text).toContain('"picked": 3');
    }
    const bad = await tool.pluginOfferTool(d, "PluginRead", { plugin: "q.html", vault: "nope" });
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/no registered vault is named "nope" \(the vaults: main, other\)/);
    // An app plugin's word never turns into a page read.
    const app = await tool.pluginOfferTool(d, "PluginRead", { plugin: "app/notes" });
    expect(app.ok).toBe(false);
    expect(app.text).toMatch(/laptop isn't online/);
  });

  it("PluginAct on a page that is not open says to open it, naming the page by its path", async () => {
    const emit = (ev: Record<string, unknown>) => queueMicrotask(() => show.ackShow(String(ev.id), { ok: false, error: "x", data: { answer: JSON.stringify({ ok: false, error: 'no plugin "video/style-quiz.html" is mounted here now' }) } }));
    const leave = show.feedOpened(vault, "laptop");
    try {
      const r = await tool.pluginOfferTool({ vault, emit, ackMs: 2000 }, "PluginAct", { plugin: "style-quiz", action: "reset" });
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/not mounted on the laptop now.*Show \{path: "video\/style-quiz\.html", where: "laptop"\}/);
    } finally {
      leave();
    }
  });
});
