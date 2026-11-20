// The native shell's command set is versioned per command (scripts/shell-abi.ts): src-tauri/shell-abi.json must match
// the Rust source, a bundle's needs carry the version of every command it calls, and a shell whose version of one
// differs is refused (here in the laptop's choice, nextCoreStep; in the loader, core_loader.rs tests).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ABI_FILE, abiText, commandSignatures, shellAbi } from "../../scripts/shell-abi";
import { needsOf } from "../../scripts/core-publish";
import { CORE_BOX_API, manifestProblem, manifestText, missingNeeds, nextCoreStep } from "../../src/coreBundle";

const repo = join(__dirname, "..", "..");

describe("the shell's command set", () => {
  it("src-tauri/shell-abi.json is current (run `npx tsx scripts/shell-abi.ts` after changing a command)", () => {
    // A changed signature makes every bundle that needs the command wait for the installer that carries it; to keep
    // newer bundles running on older shells, add a new command (foo_v2) instead of changing an old one.
    expect(readFileSync(join(repo, ABI_FILE), "utf8")).toBe(abiText(shellAbi(repo)));
  });

  it("a signature is the bundle's call: injected arguments are left out, the result is in", () => {
    const sigs = commandSignatures(`
#[tauri::command]
pub async fn web_embed_open(
    app: tauri::AppHandle,
    id: String, // the frame
    headers: Vec<(String, String)>,
) -> Result<HashMap<String, u8>, String> {
}
#[tauri::command]
fn set_bg(state: tauri::State<'_, RunInBackground>, window: tauri::WebviewWindow, mut enabled: bool) {}
`);
    expect(sigs.get("web_embed_open")).toBe("web_embed_open(id:String,headers:Vec<(String,String)>)->Result<HashMap<String,u8>,String>");
    expect(sigs.get("set_bg")).toBe("set_bg(enabled:bool)->()");
  });

  it("this source's bundle names the version of every command it calls, and this shell runs it", () => {
    const abi = shellAbi(repo);
    const needs = needsOf(repo);
    expect(Object.keys(needs.abi ?? {}).sort()).toEqual(needs.commands);
    const shell = { commands: Object.keys(abi), plugins: ["autostart", "dialog", "opener", "process", "single-instance", "updater"], abi: Object.fromEntries(Object.entries(abi).map(([c, e]) => [c, e.v])) };
    expect(missingNeeds(needs, shell)).toEqual([]);
  });

  it("a shell with another version of a needed command is refused; one from before versions checks names only", () => {
    const needs = { commands: ["app_ready", "read_text_file"], plugins: [], boxApi: CORE_BOX_API, abi: { app_ready: "11111111", read_text_file: "22222222" } };
    const offer = { version: "12345678", sha256: "12345678" + "0".repeat(56), commit: "a".repeat(40), commitTime: 200, needs, seq: 1 };
    const base = { offer, active: null, bad: [] as string[], bakedCommitTime: 100, boxApi: CORE_BOX_API };
    const same = { commands: ["app_ready", "read_text_file"], plugins: [], abi: { app_ready: "11111111", read_text_file: "22222222" } };
    expect(nextCoreStep({ ...base, shell: same }).kind).toBe("install");
    expect(nextCoreStep({ ...base, shell: { ...same, abi: { ...same.abi, read_text_file: "33333333" } } })).toMatchObject({ kind: "stay", why: expect.stringContaining("read_text_file (changed)") });
    expect(nextCoreStep({ ...base, shell: { commands: same.commands, plugins: [] } }).kind).toBe("install");
  });

  it("the manifest carries the versions in its hashed bytes, and a bad one is refused", () => {
    const m = { schema: 1 as const, commit: "a".repeat(40), commitTime: 1, builtAt: "x", needs: { commands: ["app_ready"], plugins: [], boxApi: 1, abi: { app_ready: "0123abcd" } }, files: [{ path: "index.html", sha256: "0".repeat(64), size: 1 }] };
    expect(manifestProblem(m)).toBeNull();
    expect(JSON.parse(manifestText(m)).needs.abi).toEqual({ app_ready: "0123abcd" });
    expect(manifestProblem({ ...m, needs: { ...m.needs, abi: { app_ready: "nope" } } })).toBe("needs: a bad abi");
    const old = { ...m, needs: { commands: ["app_ready"], plugins: [], boxApi: 1 } };
    expect(JSON.parse(manifestText(old)).needs).not.toHaveProperty("abi");
  });
});
