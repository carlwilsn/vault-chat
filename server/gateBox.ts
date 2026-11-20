// The gate's runner for box plugins (src/gateResult.ts, kind box-plugin): the live copy and the draft are loaded apart
// from the running box, each in its own thread (server/boxPlugins.ts probeBoxCopy), on a scratch copy of the vault (a
// fresh secret-filtered copy of the box's real data in scripts/gate.ts; the running box and its log are never touched).
// Both answer the same GET requests (every GET route they register, without a body); then they are compared:
//   fail        the draft did not load (a throw in activate, too slow, too big, stuck), a route it answers throws, is
//               slow (over BOX_SLOW_MS) or answers 5xx where the live copy does not, or it failed later (a hook)
//   borderline  what it registers differs (routes, tools, prompt, hidden tools) or a GET answers otherwise: the agent or
//               Carl's pages see a change (is it what was asked for?)
//   pass        the same routes, tools, prompt and answers: a refactor or a fix nothing sees
// POST routes are not called (their bodies are the caller's); tools are compared by their specs, not run.
import { probeBoxCopy, type BoxProbe, type BoxToolSpec } from "./boxPlugins";
import { versionOf } from "../src/pluginDrafts";

export type BoxAnswer = { status: number; body: unknown; error?: string };
export type BoxSide = { ran: boolean; error: string | null; routes: string[]; tools: BoxToolSpec[]; prompt: string | null; hidden: string[]; answers: Record<string, BoxAnswer> };
export type BoxVerdict = { verdict: "pass" | "borderline" | "fail"; reasons: string[]; plugin: string; version: string; live: BoxSide | null; draft: BoxSide };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const list = (xs: string[]) => xs.slice(0, 6).join(", ") + (xs.length > 6 ? ` and ${xs.length - 6} more` : "");

/** Compare the two sides. Pure, for tests. */
export function judgeBox(plugin: string, version: string, live: BoxSide | null, draft: BoxSide): BoxVerdict {
  const fail: string[] = [];
  const border: string[] = [];
  if (!draft.ran) fail.push(`the draft did not load: ${(draft.error ?? "it failed to start").replace(/^it did not load: /, "")}`);
  for (const [k, a] of Object.entries(draft.answers)) {
    const l = live?.answers[k];
    const liveBad = !!l && (!!l.error || l.status >= 500);
    if (a.error && !liveBad) fail.push(a.error);
    else if (a.status >= 500 && !liveBad) fail.push(`${k} answers ${a.status}${l ? ` (the live copy ${l.status})` : ""}`);
  }
  if (draft.ran && draft.error && !(live && live.error)) fail.push(`it failed while running: ${draft.error}`);
  if (!live) border.push(`a new box plugin: routes ${list(draft.routes) || "none"}${draft.tools.length ? `, tools ${list(draft.tools.map((t) => t.name))}` : ""}${draft.prompt ? ", a prompt" : ""}${draft.hidden.length ? `, hides ${list(draft.hidden)}` : ""}`);
  else {
    const added = draft.routes.filter((r) => !live.routes.includes(r));
    const gone = live.routes.filter((r) => !draft.routes.includes(r));
    if (added.length || gone.length) border.push(`routes differ:${added.length ? ` new ${list(added)}` : ""}${gone.length ? ` gone ${list(gone)}` : ""}`);
    if (!same(live.tools, draft.tools)) border.push(`its agent tools differ (${list(live.tools.map((t) => t.name)) || "none"} -> ${list(draft.tools.map((t) => t.name)) || "none"})`);
    if ((live.prompt ?? "") !== (draft.prompt ?? "")) border.push("its prompt for the agent differs");
    if (!same(live.hidden, draft.hidden)) border.push(`the tools it hides differ (${list(live.hidden) || "none"} -> ${list(draft.hidden) || "none"})`);
    const differs = Object.keys(draft.answers).filter((k) => k in live.answers && !draft.answers[k]!.error && (live.answers[k]!.status !== draft.answers[k]!.status || !same(live.answers[k]!.body, draft.answers[k]!.body)));
    if (differs.length) border.push(`answers differ: ${list(differs)}`);
  }
  const reasons = fail.length ? fail : border.length ? border : ["the same routes, tools, prompt and answers"];
  return { verdict: fail.length ? "fail" : border.length ? "borderline" : "pass", reasons, plugin, version, live, draft };
}

async function side(p: BoxProbe, gets: string[]): Promise<BoxSide> {
  const answers: Record<string, BoxAnswer> = {};
  for (const sub of gets) {
    if (!p.routes.includes(`GET ${sub}`)) continue;
    const a = await p.call("GET", sub);
    answers[`GET ${sub}`] = { status: a.status, body: a.body, ...(a.error ? { error: a.error } : {}) };
  }
  // A failure the copy's thread reported meanwhile (a hook, a timer) is read before it is closed.
  return { ran: p.ran, error: p.error, routes: p.routes, tools: p.tools, prompt: p.prompt, hidden: p.hidden, answers };
}

/**
 * Run the gate for box/<name> on `copy` (a scratch copy of the vault: never the live one). `live`: the live copy's code
 * (absent: a new plugin); `draft`: the draft's. Both are loaded, asked, compared and closed.
 */
export async function boxGate(o: { copy: string; name: string; live?: string; draft: string }): Promise<BoxVerdict> {
  const plugin = `box/${o.name}`;
  const lp = o.live !== undefined ? await probeBoxCopy(o.copy, o.name, o.live, false) : null;
  const dp = await probeBoxCopy(o.copy, o.name, o.draft, true);
  try {
    const gets = [...new Set([...(lp?.routes ?? []), ...dp.routes].filter((r) => r.startsWith("GET ") && !r.endsWith("/*")).map((r) => r.slice(4)))].sort();
    const live = lp ? await side(lp, gets) : null;
    const draft = await side(dp, gets);
    return judgeBox(plugin, versionOf(o.draft), live, draft);
  } finally {
    await Promise.all([lp?.close(), dp.close()]);
  }
}
