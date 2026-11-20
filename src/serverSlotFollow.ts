// The laptop's server slot follows the box's accepted server build (server/serverBuild.ts, src-tauri/src/local_server.rs).
// The app's own server (no box, or the box out of reach) and the server tools the shell runs (fetch-claude-cli) come
// from the newest build the box runs instead of the installer's. The work is the server's (`fill-server-slot`, run by
// the shell's server_tool with the box address and token on stdin); this only says when: a while after launch, then
// every 6 hours, while the app is linked to a box. A shell without server_tool (an older installer) does nothing.
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Link } from "./boxChat";

export const FIRST_MS = 3 * 60_000;
export const EVERY_MS = 6 * 60 * 60_000;

export type SlotDeps = {
  commands: () => Promise<string[]>;
  link: () => Promise<Link | null>;
  tool: (task: string, input: string) => Promise<{ version: string; changed: boolean }>;
};

/** One look: fill the slot from the box when the shell can. */
export async function fillSlotOnce(d: SlotDeps): Promise<string> {
  if (!(await d.commands().catch(() => [] as string[])).includes("server_tool")) return "this installed app has no server_tool";
  const link = await d.link().catch(() => null);
  if (!link) return "no box";
  const r = await d.tool("fill-server-slot", JSON.stringify({ url: link.url, token: link.token }));
  return r.changed ? `took the box's server build ${r.version}` : `already on ${r.version}`;
}

let started = false;
export function startServerSlotFollow(): void {
  if (started || !isTauri()) return;
  started = true;
  const deps: SlotDeps = {
    commands: async () => ((await invoke<{ commands?: string[] }>("core_status")).commands ?? []),
    link: async () => {
      const [{ boxLinkFor, localServerLink }, { useStore }] = await Promise.all([import("./boxChat"), import("./store")]);
      const vault = useStore.getState().vaultPath;
      const l = await boxLinkFor(vault).catch(() => null);
      // Only a box's build: never the server this app runs itself.
      return l && l.url !== localServerLink(vault)?.url ? l : null;
    },
    tool: (task, input) => invoke("server_tool", { task, input }),
  };
  const look = () => void fillSlotOnce(deps).then((r) => console.info(`[server slot] ${r}`)).catch((e) => console.warn("[server slot]", e));
  window.setTimeout(look, FIRST_MS);
  window.setInterval(look, EVERY_MS);
}
