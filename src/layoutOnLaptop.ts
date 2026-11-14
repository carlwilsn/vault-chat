// The laptop's half of the agent's Layout tool (server/layoutTool.ts): the box puts a {type:"layout", id, to:"laptop", ops}
// signal on the feed (/poll, like Show's); src/boxChat.ts hands it here; the ops run through src/layoutOps.ts (the same
// ones a plugin has as api.host.layout) and the ack carries the layout read back from the screen: {ok, data:{results,
// layout}}. Putting a file in a pane goes through Show's own path (src/showOnLaptop.ts: the box's copy ahead of the
// sync, the pane swap), so a file the agent just made opens the same way either tool opens it.
import { applyLayoutOps, LAYOUT_OPS, readLayout, layoutText, type LayoutOp, type LayoutResult } from "./layoutOps";
import { showOnLaptop, type ShowDeps } from "./showOnLaptop";

export type LayoutSignal = { type: "layout"; id: string; to?: string; ops?: unknown };
export type LayoutAck = { ok: boolean; landed?: string; error?: string; data?: LayoutResult };

export async function layoutOnLaptop(sig: LayoutSignal, deps: ShowDeps = {}): Promise<LayoutAck> {
  try {
    const raw = Array.isArray(sig.ops) ? sig.ops : [];
    const ops = raw.filter((o): o is LayoutOp => !!o && typeof o === "object" && (LAYOUT_OPS as readonly string[]).includes((o as { op?: string }).op ?? ""));
    if (ops.length !== raw.length) return { ok: false, error: `unknown layout op in the request (${LAYOUT_OPS.join(", ")})` };
    if (!ops.length) {
      const layout = readLayout();
      return { ok: true, landed: layoutText(layout), data: { ok: true, results: [], layout } };
    }
    const r = await applyLayoutOps(ops, {
      async openInPane(path, pane) {
        const a = await showOnLaptop({ type: "show", id: "", to: "laptop", path, pane }, deps);
        return a.ok ? { ok: true, note: a.landed } : { ok: false, error: a.error };
      },
    });
    return { ok: r.ok, landed: layoutText(r.layout), data: r, ...(r.ok ? {} : { error: r.results.filter((x) => !x.ok).map((x) => `${x.op}: ${x.error}`).join("; ") }) };
  } catch (e) {
    return { ok: false, error: `the laptop could not apply it: ${(e as Error)?.message ?? String(e)}` };
  }
}
