// A throwaway box for the final-model proof (dev only): the REAL server bundle (dist-server) on this machine, with a
// vault-chat folder shaped like the live one — school2 (the main vault, with IEMS 469 and an agent-projects/ project),
// the vault-chat vault (its project registered to the code repo) and projects/vault-chat — migrated with the real CLI
// (`projects migrate`), then served. The agent is the fake pi (server/test/fakePiCli.mjs); nothing leaves the machine.
//   npx tsx preview/tools/finalModelBox.ts [--root DIR] [--port N]
// Prints {base, root, master} on one line, then keeps serving until killed.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function main(): Promise<void> {
  // server/test/helpers.ts reads __dirname (vitest gives it one): the same, here.
  (globalThis as { __dirname?: string }).__dirname = fileURLToPath(new URL("../../server/test/", import.meta.url));
  const { fakeOpenRouter, makeKeyStore, makeVault, startServer, BUNDLE, tmp, git } = await import("../../server/test/helpers");
const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const root = opt("root") ?? tmp("vc-finalbox-");
const home = join(root, "home");
const master = join(root, "vc");
const school2 = makeVault(join(master, "vaults", "school2"));
const vcVault = makeVault(join(master, "vaults", "vault-chat"));
const code = makeVault(join(master, "projects", "vault-chat"));
mkdirSync(home, { recursive: true });

const put = (p: string, s: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, s);
};
// school2: folders, one of them the IEMS project's (in agent-projects/, as live), a deleted project, the hide lists.
put(join(school2, "IEMS 469", "course-notes.html"), "<html><body><h1>IEMS 469</h1></body></html>\n");
put(join(school2, "IEMS 469", "lectures", "lecture-07.md"), "# Lecture 7: value iteration\n");
put(join(school2, "Psych 221", "essay.md"), "# Essay draft\n\nOn memory.\n");
put(join(school2, "Physics 135", "ps5.md"), "# Problem set 5\n");
const iems = join(school2, "agent-projects", "iems-469-course-notes-visuals");
put(join(iems, "project.md"), "# IEMS 469 Course Notes Visuals\n\n## What\n\n(not written yet)\n\n## Status\n\nstarted 2026-10-18\n");
put(join(iems, "memory.md"), "# Memory: IEMS 469 Course Notes Visuals\n\n## Decisions\n\nPatched only `IEMS 469/course-notes-copy.html`.\n");
put(join(school2, "agent-projects", ".deleted", "whiteboard-20261026-002736", "project.md"), "# Whiteboard\n");
put(join(school2, ".vaultchatignore"), "agent-projects\nboards\n");
put(join(school2, ".vault-chat", "hidden-by-default"), "# Hidden by default once by vault-chat; unhiding one keeps it shown.\nagent-projects\nboards\n");
// vault-chat vault: its project, registered to the code repo.
put(join(vcVault, "reports", "QUEUE.md"), "# Queue\n\n1. the folder model\n");
put(join(vcVault, "agent-projects", "vault-chat", "project.md"), "# vault-chat\n\n## Memory\n- 2026-10-29: one final handover authorized\n");
put(join(vcVault, "agent-projects", "vault-chat", "rules.md"), "# Rules\n\n- 2026-10-29: This agent never merges or pushes main\n");
put(join(vcVault, ".vault-chat", "local", "project-folders.json"), JSON.stringify({ folders: { "vault-chat": { path: code, at: "2026-10-28T04:39:01.497Z" } }, deleted: {} }, null, 2) + "\n");
put(join(code, "AGENTS.md"), "# vault-chat\n\nThe rules for the agent that builds vault-chat.\n");
put(join(code, "src", "main.tsx"), "export {};\n");
for (const v of [school2, vcVault, code]) {
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "seed");
}
// Each vault's hub (the box lists a vault in the folder that has one).
for (const n of ["school2", "vault-chat"]) {
  const hub = join(master, ".hub", "vaults", `${n}.git`);
  mkdirSync(hub, { recursive: true });
  git(hub, "init", "-q", "--bare");
}

const secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-test-not-a-key" });
const or = await fakeOpenRouter("Morning! What are we working on?");
const env = join(home, "server.env");
writeFileSync(env, `VC_VAULT=${school2}\nVC_VAULT_NAME=school2\nVC_MASTER=${master}\nVC_STATE_DIR=${join(home, "state")}\nVC_PORT=1\n`);
// The real migration CLI, on this copy.
const mig = execFileSync(process.execPath, [BUNDLE, "projects", "migrate", "--env", env, "--map", "iems-469-course-notes-visuals=IEMS 469"], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
const box = await startServer({ home, vault: school2, secrets, openrouter: or.url, extra: { VC_MASTER: master, VC_VAULT_NAME: "school2", ...(opt("port") ? { VC_PORT: opt("port")! } : {}) } });
console.log(JSON.stringify({ base: box.base, root, master, migrated: JSON.parse(mig).report }));
process.on("SIGTERM", () => void box.stop().then(() => process.exit(0)));
setInterval(() => {}, 1 << 30);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
