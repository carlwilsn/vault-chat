// The box's own state as offers (Native agency: one read / change / watch for everything, with or without a device).
// The laptop's and phone's parts declare offers in the app (src/pluginOffers.ts) and answer only while that app is
// online. What lives on the box — the settings, the notes, the jobs, the device links, the logs — was reachable only
// through one-off tools or Bash, and not at all as "state". Here it is offers of the same shape, answered by the box
// itself: PluginRead {plugin: "box:settings"} reads, PluginAct {plugin: "box:notes", action: "add", args} changes,
// PluginRead {plugin, wait} watches (the box re-reads the state until it changes). A device being off changes nothing.
//
// Secrets are never state: settings hold none (the key store is not reachable here), and log lines pass through
// `redact` before they leave this file.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { OffersDescription } from "../src/pluginOffers";
import { linkStates } from "./deviceLink";

export type JsonSchema = Record<string, unknown>;
type State = { description: string; read: () => unknown | Promise<unknown> };
type Action = { description: string; args?: JsonSchema; run: (args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }> | { ok: boolean; text: string } };
export type BoxOffer = { id: string; name: string; state: Record<string, State>; actions: Record<string, Action> };

export type BoxOfferDeps = {
  vault: string;
  /** The box's state dir (its logs live in <stateDir>/logs). */
  stateDir?: string;
  /** The jobs and workers of the asking conversation, as JobList says them. */
  jobs?: () => string;
  /** Every registered vault's path (box:history searches all their logs). */
  vaults?: () => string[];
};

export const BOX_PREFIX = "box:";
export const isBoxWord = (w: string) => w.trim().toLowerCase().startsWith(BOX_PREFIX);

/** Anything that looks like a credential, cut out of text that leaves the box's own files. */
export function redact(s: string): string {
  return s
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{12,})/g, "[secret]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[secret]")
    .replace(/((?:token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]{6,}/gi, "$1[secret]");
}

const LOGS = ["turns", "app", "voice", "board"] as const;
const LOG_LINES = 15;

function tail(file: string, n: number): string[] {
  if (!existsSync(file)) return [];
  try {
    const text = readFileSync(file, "utf8");
    return text.split("\n").filter(Boolean).slice(-n).map((l) => redact(l.length > 400 ? `${l.slice(0, 400)}…` : l));
  } catch {
    return [];
  }
}

const obj = (props: Record<string, unknown>, required: string[] = []): JsonSchema => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

/** The box's offers, now. */
export function boxOffers(d: BoxOfferDeps): BoxOffer[] {
  const note = async (name: string, a: Record<string, unknown>) => {
    const { noteTool } = await import("./notesTools");
    const r = await noteTool(d.vault, name as never, a);
    return { ok: r.ok, text: r.text };
  };
  const out: BoxOffer[] = [
    {
      id: "box:settings",
      name: "Settings",
      state: {
        values: {
          description: "every setting's value and who set it (theme, model, effort, voice, pushAutomatic, chatSidebar, corePublish)",
          read: async () => {
            const { readSettings } = await import("./settings");
            const s = readSettings();
            return Object.fromEntries(Object.entries(s.values).map(([k, v]) => [k, { value: v, set: s.set[k as keyof typeof s.set]?.by ?? "default" }]));
          },
        },
      },
      actions: {
        set: {
          description: "set one setting (value null: its default); shows at once in every open app",
          args: obj({ key: str("the setting"), value: { type: ["string", "boolean", "null"] } }, ["key", "value"]),
          run: async (a) => (await import("./settingsTool")).settingsTool({ key: a.key, value: a.value }),
        },
      },
    },
    {
      id: "box:notes",
      name: "Notes",
      state: {
        open: {
          description: "Carl's open notes (the Notes panel), newest first",
          read: async () => {
            const { readNotes } = await import("../src/notes");
            const { noteText } = await import("./notesTools");
            return ((await readNotes(d.vault)) as any[])
              .filter((n) => n.status === "open")
              .sort((x, y) => (x.timestamp < y.timestamp ? 1 : -1))
              .slice(0, 50)
              .map((n) => ({ id: n.id, at: String(n.timestamp ?? "").slice(0, 16), text: noteText(n).slice(0, 400) }));
          },
        },
      },
      actions: {
        add: { description: "add a note", args: obj({ text: str("the note"), source_path: str("a vault file it points at") }, ["text"]), run: (a) => note("CreateNote", a) },
        edit: { description: "replace a note's text", args: obj({ id: str("the note's id"), text: str("its new text") }, ["id", "text"]), run: (a) => note("UpdateNote", a) },
        resolve: { description: "mark a note done", args: obj({ id: str("the note's id") }, ["id"]), run: (a) => note("ResolveNote", a) },
        reopen: { description: "open a resolved note again", args: obj({ id: str("the note's id") }, ["id"]), run: (a) => note("ReopenNote", a) },
        delete: { description: "delete a note (git history keeps it)", args: obj({ id: str("the note's id") }, ["id"]), run: (a) => note("DeleteNote", a) },
      },
    },
    {
      id: "box:links",
      name: "Devices",
      state: {
        devices: { description: "each device app's link to the box: up or down since when and why, the vault it has open, unanswered requests", read: () => linkStates() },
      },
      actions: {},
    },
  ];
  const logs = () => (d.vaults?.() ?? [d.vault]).concat(d.vault);
  out.push({
    id: "box:history",
    name: "History",
    state: {
      recent: {
        description: "the newest 30 things Carl did in the app's parts (offer events: opened a file, switched chat, …), kept in the event log",
        read: async () => (await import("./offerLog")).searchOfferEvents(logs(), { limit: 30 }).map(line),
      },
    },
    actions: {
      search: {
        description: "search that history, as far back as it goes: every word of query in the part, event or its details; plugin narrows to one part; days limits how far back",
        args: obj({ query: str("words that must all appear"), plugin: str("a part, e.g. app/viewer"), days: { type: "number" }, limit: { type: "number" } }),
        run: async (a) => {
          const hits = (await import("./offerLog")).searchOfferEvents(logs(), { query: a.query as string, plugin: a.plugin as string, days: Number(a.days) || undefined, limit: Number(a.limit) || undefined });
          return { ok: true, text: hits.length ? hits.map(line).join("\n") : "nothing matches" };
        },
      },
    },
  });
  if (d.stateDir) {
    const sd = d.stateDir;
    out.push({
      id: "box:queue",
      name: "Queue",
      state: {
        pending: { description: "device actions kept while the device is away (PluginAct whenBack), run when its app is back", read: async () => (await import("./deviceQueue")).queueState(sd).pending },
        done: { description: "the last ones run, expired or cancelled, with what happened", read: async () => (await import("./deviceQueue")).queueState(sd).done.slice(-10) },
      },
      actions: {
        cancel: { description: "drop a kept action before it runs", args: obj({ id: str("its id (q-…)") }, ["id"]), run: async (a) => (await import("./deviceQueue")).cancelQueued(sd, String(a.id)) },
      },
    });
  }
  if (d.jobs) out.push({ id: "box:jobs", name: "Jobs", state: { list: { description: "this conversation's background workers and shell jobs (JobStop / JobSteer act on them)", read: () => d.jobs!() } }, actions: {} });
  if (d.stateDir) {
    const dir = join(d.stateDir, "logs");
    out.push({
      id: "box:logs",
      name: "Logs",
      state: Object.fromEntries(LOGS.map((l) => [l, { description: `the newest ${LOG_LINES} lines of the box's ${l} log (credentials cut out)`, read: () => tail(join(dir, `${l}.jsonl`), LOG_LINES) }])),
      actions: {},
    });
  }
  return out;
}

const noArgs = obj({});

/** One history record as a line Carl could read. */
function line(r: { at: number; device: string; plugin: string; event: string; payload?: string }): string {
  return `${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")} ${r.device} ${r.plugin} ${r.event}${r.payload ? ` ${r.payload}` : ""}`;
}

export function describeBoxOffer(o: BoxOffer): OffersDescription {
  return {
    id: o.id,
    name: o.name,
    state: Object.entries(o.state).map(([name, s]) => ({ name, description: s.description })),
    actions: Object.entries(o.actions).map(([name, a]) => ({ name, description: a.description, args: (a.args ?? noArgs) as never })),
    events: [],
  };
}

function find(d: BoxOfferDeps, word: string): BoxOffer | null {
  const w = word.trim().toLowerCase();
  return boxOffers(d).find((o) => o.id === w || `${BOX_PREFIX}${o.name.toLowerCase()}` === w) ?? null;
}

const known = (d: BoxOfferDeps) => boxOffers(d).map((o) => o.id).join(", ");

/** Read a box offer's state (all of it, or one selector). */
export async function readBoxOffer(d: BoxOfferDeps, word: string, only?: string): Promise<{ ok: boolean; id?: string; state?: Record<string, unknown>; error?: string }> {
  const o = find(d, word);
  if (!o) return { ok: false, error: `no box state "${word}" (the box offers: ${known(d)})` };
  if (only && !(only in o.state)) return { ok: false, id: o.id, error: `${o.id} has no state "${only}" (it offers: ${Object.keys(o.state).join(", ")})` };
  const state: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(o.state)) {
    if (only && k !== only) continue;
    try {
      state[k] = await s.read();
    } catch (e) {
      state[k] = { error: (e as Error)?.message ?? String(e) };
    }
  }
  return { ok: true, id: o.id, state };
}

/** Wait (at most `ms`) for a box offer's state to differ from what it is now; then its state. */
export async function watchBoxOffer(d: BoxOfferDeps, word: string, ms: number, only?: string, everyMs = 500): Promise<{ ok: boolean; id?: string; state?: Record<string, unknown>; error?: string; changed?: boolean }> {
  const first = await readBoxOffer(d, word, only);
  if (!first.ok) return first;
  const was = JSON.stringify(first.state);
  const end = Date.now() + Math.max(0, Math.min(ms, 25_000));
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(everyMs, Math.max(1, end - Date.now()))));
    const now = await readBoxOffer(d, word, only);
    if (now.ok && JSON.stringify(now.state) !== was) return { ...now, changed: true };
  }
  return { ...first, changed: false };
}

/** Run a box offer's action. */
export async function actBoxOffer(d: BoxOfferDeps, word: string, action: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; state?: Record<string, unknown> }> {
  const o = find(d, word);
  if (!o) return { ok: false, text: `no box state "${word}" (the box offers: ${known(d)})` };
  const a = o.actions[action];
  if (!a) return { ok: false, text: `${o.id} has no action "${action}" (it offers: ${Object.keys(o.actions).join(", ") || "no actions: it is read-only"})` };
  const schema = (a.args ?? noArgs) as { properties?: Record<string, unknown>; required?: string[] };
  const missing = (schema.required ?? []).filter((k) => !(k in args));
  const extra = Object.keys(args).filter((k) => !(k in (schema.properties ?? {})));
  if (missing.length || extra.length) return { ok: false, text: `${o.id} ${action}: ${missing.length ? `needs ${missing.join(", ")}` : ""}${missing.length && extra.length ? "; " : ""}${extra.length ? `does not take ${extra.join(", ")}` : ""}. Nothing was run.` };
  let r: { ok: boolean; text: string };
  try {
    r = await a.run(args);
  } catch (e) {
    r = { ok: false, text: (e as Error)?.message ?? String(e) };
  }
  const back = await readBoxOffer(d, o.id);
  return { ...r, ...(back.state ? { state: back.state } : {}) };
}
