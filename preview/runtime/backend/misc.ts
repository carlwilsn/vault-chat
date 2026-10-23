// Commands lib.rs has that server/commands/ (the node port) doesn't: the
// desktop-only file ops, the ignore list, captures, and the
// inert host commands (window/voice/phone/terminal) that only need a sane reply.
import * as fs from "../shims/memfs";
import { report } from "../overlay";

const NOTES_DIR = ".vault-chat";
const IGNORE_FILE = ".vaultchatignore";

function readList(vault: string, file: string): string[] {
  const t = fs.readText(`${vault}/${file}`);
  if (t === null) return [];
  return t
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
function writeList(vault: string, file: string, lines: string[]): void {
  fs.seedText(`${vault}/${file}`, lines.length ? lines.join("\n") + "\n" : "");
}
function listCommands(kind: "ignore") {
  const file = IGNORE_FILE;
  return {
    [`read_${kind}_lines`]: ({ vault }: any) => readList(vault, file),
    [`add_to_${kind}`]: ({ vault, relativePath }: any) => {
      const l = readList(vault, file);
      if (!l.includes(relativePath)) writeList(vault, file, [...l, relativePath]);
      return null;
    },
    [`rename_in_${kind}`]: ({ vault, oldRelative, newRelative }: any) => {
      writeList(vault, file, readList(vault, file).map((l) => (l === oldRelative ? newRelative : l.startsWith(oldRelative + "/") ? newRelative + l.slice(oldRelative.length) : l)));
      return null;
    },
    [`remove_prefix_from_${kind}`]: ({ vault, relativePrefixes }: any) => {
      const ps: string[] = relativePrefixes ?? [];
      writeList(vault, file, readList(vault, file).filter((l) => !ps.some((p) => l === p || l.startsWith(p + "/"))));
      return null;
    },
    [`remove_from_${kind}`]: ({ vault, relativePaths }: any) => {
      const ps: string[] = relativePaths ?? [];
      writeList(vault, file, readList(vault, file).filter((l) => !ps.includes(l)));
      return null;
    },
  };
}

let uniq = 0;
export const miscCommands: Record<string, (a: Record<string, any>) => unknown> = {
  ...listCommands("ignore"),
  create_dir: ({ path }) => {
    fs.mkdirSync(path, { recursive: true });
    return null;
  },
  path_exists: ({ path }) => fs.existsSync(path),
  rename_path: ({ from, to }) => {
    if (!fs.existsSync(from)) throw `path does not exist: ${from}`;
    if (fs.existsSync(to)) throw `destination already exists: ${to}`;
    fs.renameSync(from, to);
    return null;
  },
  copy_into_vault: ({ dstDir, src }) => {
    const name = String(src).replace(/\\/g, "/").split("/").pop();
    if (!fs.existsSync(src)) throw `preview: can't copy from outside the in-memory vault (${src})`;
    const dst = `${dstDir}/${name}`;
    fs.copyFileSync(src, dst);
    return dst;
  },
  write_binary_file_unique: ({ dir, name, bytes }) => {
    fs.mkdirSync(dir, { recursive: true });
    const dot = String(name).lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let p = `${dir}/${name}`;
    while (fs.existsSync(p)) p = `${dir}/${stem}-${++uniq}${ext}`;
    fs.writeFileSync(p, Uint8Array.from(bytes ?? []));
    return p;
  },
  cleanup_old_captures: () => 0,
  append_sync_log: ({ vaultPath, line }) => {
    fs.mkdirSync(`${vaultPath}/${NOTES_DIR}`, { recursive: true });
    fs.appendFileSync(`${vaultPath}/${NOTES_DIR}/sync-log.jsonl`, String(line).endsWith("\n") ? line : line + "\n");
    return null;
  },
  machine_host: () => "carl-laptop (preview)",

  // ---- host / window lifecycle (inert) ----
  app_ready: () => null,
  set_run_in_background: () => null,
  open_terminal: ({ cwd }) => {
    report("info", `would open a terminal in ${cwd ?? "~"} (not in the preview)`);
    return null;
  },
  open_box_terminal: ({ host, user, path }) => {
    report("info", `would open a terminal on the box: ssh -t ${user}@${host} (cd ${path}) — not in the preview`);
    return null;
  },
  compile_tex: () => {
    throw "preview: TeX compilation is not available in the preview";
  },
  run_script: ({ path }) => ({ stdout: "", stderr: `preview: scripts don't run in the preview (${path})`, code: 1, timed_out: false }),

  // ---- boot timing (src/bootTiming.ts): no main-thread watcher in a browser ----
  boot_timing: () => ({ uptime_ms: Math.round(performance.now()), stalls: [] }),

  // ---- voice / phone host (inert: no server, no audio) ----
  voice_server_start: ({ port }) => port ?? 8848,
  voice_server_stop: () => null,
  voice_server_status: () => false,
  voice_server_url: ({ port }) => `http://100.64.0.7:${port ?? 8848}`,
  voice_set_context: () => null,
  voice_tool_respond: () => null,
  phone_broadcast: () => null,
  phone_set_vapid: () => null,
  phone_push_subs: () => "[]",
  phone_push_unsub: () => null,
  notification_add: ({ vault, json }) => {
    fs.mkdirSync(`${vault}/${NOTES_DIR}`, { recursive: true });
    fs.appendFileSync(`${vault}/${NOTES_DIR}/notifications.jsonl`, String(json) + "\n");
    return null;
  },
  push_post: () => ({ status: 201, body: "" }),
  agent_audio_play: () => null,
  agent_audio_stop: () => null,
  http_fetch: ({ url }) => {
    report("refused", `http_fetch ${url}`);
    throw `preview: no network — http_fetch(${url}) refused`;
  },
  tavily_search: ({ query }) => {
    throw `preview: no network — web search for “${query}” refused`;
  },
};
