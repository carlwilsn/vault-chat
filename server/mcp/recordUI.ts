// External RecordUI uses the existing recorder, with browser-only authority and
// a fresh output directory in its explicitly bound vault, never a live turn.
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { browserOnlyError, recordUITool, type RecordArgs } from "../recordUI";

export async function externalRecordUI(
  shell: string[] | null | undefined, vault: string, args: Record<string, unknown>,
  pathAllowed: (path: string, write?: boolean) => Promise<string | null>,
  options: { signal?: AbortSignal; entry?: string[] } = {},
): Promise<{ ok: boolean; text: string }> {
  options.signal?.throwIfAborted();
  if (!shell?.length) return { ok: false, text: "External RecordUI requires the installed sandbox; unsafe native mode is not external authority." };
  const why = browserOnlyError(args as RecordArgs);
  if (why) return { ok: false, text: why };
  // Never overwrite an existing artifact or follow a client-selected output
  // symlink. The fresh directory also contains all screenshot/codec siblings.
  if (args.out !== undefined) return { ok: false, text: "External RecordUI allocates a fresh vault visuals directory; omit out and use the returned video path." };
  const parent = join(vault, ".vault-chat", "visuals");
  const denied = await pathAllowed(parent, true);
  if (denied) return { ok: false, text: denied };
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "mcp-recording-"));
  const text = await recordUITool(shell, vault, { ...args, out: join(dir, "recording") }, { ...options, cwd: vault, browserOnly: true });
  options.signal?.throwIfAborted();
  return { ok: text.startsWith("Every step ran."), text };
}
