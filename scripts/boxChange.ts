// The scripts' Keep / Discard / Switch back on a plugin's draft (change by asking, src/pluginDrafts.ts): the same
// plugin.change record the gate and the agent write, through the same route (POST /api/v2/supervisor on the box, which
// moves the slot's files: server/pluginDrafts.ts). One path: a script never moves the files itself.
//
// The box is the one on this machine (loopback is let in: server/auth.ts), at VC_BOX_URL or http://127.0.0.1:$VC_PORT
// (8848); --box <url> on the scripts names another. The vault is named by its folder's name (the box's vault name).
import { basename } from "node:path";

export type BoxChange = { plugin: string; change: "keep" | "discard" | "switch"; version?: string; reason?: string; by?: "agent" | "gate"; what?: string; conv?: string };

/** The box to write to: `box`, else VC_BOX_URL, else this machine's box. */
export function boxUrl(box?: string): string {
  return (box || process.env.VC_BOX_URL || `http://127.0.0.1:${process.env.VC_PORT || 8848}`).replace(/\/+$/, "");
}

/** Write one change record (the box moves the files). Throws with the box's reason when it refuses or does not answer. */
export async function postBoxChange(vault: string, c: BoxChange, box?: string): Promise<{ seq: number; text: string }> {
  const url = `${boxUrl(box)}/api/v2/supervisor?vault=${encodeURIComponent(basename(vault.replace(/[\\/]+$/, "")))}`;
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by: "agent", ...c }), signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`the box did not answer at ${boxUrl(box)} (${(e as Error).message}): nothing was moved; a change is a record the box writes`);
  }
  const body = (await r.json().catch(() => ({}))) as { seq?: number; text?: string; error?: string };
  if (!r.ok) throw new Error(body.error ?? `the box refused it (${r.status})`);
  return { seq: Number(body.seq) || 0, text: body.text ?? "done" };
}
