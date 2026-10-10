// The node command table behind the `invoke` shim. Each command mirrors a
// `#[tauri::command]` in src-tauri/src/lib.rs (cited at each registration).
// Tauri converts the JS camelCase argument keys to the Rust snake_case
// parameter names; handlers here receive the JS-side (camelCase) keys as sent.

export type CommandFn = (args: Record<string, any>) => unknown | Promise<unknown>;

const table = new Map<string, CommandFn>();

export function register(name: string, fn: CommandFn): void {
  if (table.has(name)) throw new Error(`command ${name} registered twice`);
  table.set(name, fn);
}

export function registerAll(cmds: Record<string, CommandFn>): void {
  for (const [k, v] of Object.entries(cmds)) register(k, v);
}

export function knownCommands(): string[] {
  return [...table.keys()].sort();
}

/** Tauri rejects with a plain string on `Err(String)`; keep that shape so the
 * app's error formatting sees the same thing it does on the desktop. */
export async function dispatch(name: string, args: Record<string, any>): Promise<unknown> {
  const fn = table.get(name);
  if (!fn) {
    const msg = `[vault-chat-server] unknown invoke command "${name}" — not implemented headless (see server/COMMANDS.md)`;
    console.error(msg);
    throw new Error(msg);
  }
  try {
    return await fn(args);
  } catch (e) {
    throw typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  }
}
