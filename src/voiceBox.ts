// Voice in box mode: when the vault runs on a box, the voice agent's vault
// tools run there (POST /api/v1/voice/tool, server/voice.ts) — the box's
// working copy, its sandbox, its agent. Paths the agent builds from the
// laptop's vault root are sent vault-relative, so they mean the same file on
// the box. Tools that move the user's screen never come here (LOCAL_VOICE_TOOLS).
import { boxLinkFor, boxPost, type Link } from "./boxChat";

const PATH_KEYS = ["path", "cwd", "source_path"];

/** Args with paths under `vault` made vault-relative (other paths are left for the box to refuse). */
export function relativeArgs(args: unknown, vault: string): Record<string, unknown> {
  const a = args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {};
  const nv = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const k of PATH_KEYS) {
    const v = a[k];
    if (typeof v !== "string") continue;
    const p = v.replace(/\\/g, "/");
    const low = (x: string) => (/^[a-z]:\//i.test(nv) ? x.toLowerCase() : x);
    if (low(p) === low(nv)) a[k] = ".";
    else if (low(p).startsWith(low(nv) + "/")) a[k] = p.slice(nv.length + 1);
  }
  return a;
}

type Post = (link: Link, path: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }>;

/** The remote runner for one link. */
export function voiceToolVia(link: Link, vault: string, post: Post = boxPost) {
  return async (name: string, args: unknown): Promise<string> => {
    const r = await post(link, "/api/v1/voice/tool", { name, args: relativeArgs(args, vault) });
    if (!r.ok) return `Error: the box did not run ${name} (${r.error ?? "unreachable"}).`;
    return typeof r.data?.result === "string" ? r.data.result : JSON.stringify(r.data ?? {});
  };
}

/** The remote runner when `vault` runs on a box, else null (tools run here). */
export async function boxVoiceTool(vault: string | null): Promise<((name: string, args: unknown) => Promise<string>) | null> {
  if (!vault) return null;
  const link = await boxLinkFor(vault).catch(() => null);
  return link ? voiceToolVia(link, vault) : null;
}
