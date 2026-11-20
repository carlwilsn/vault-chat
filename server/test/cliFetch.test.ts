// Fetching Claude Code for the laptop (server/engine/claude/cliFetch.ts): checked against npm's hash, run here before it
// replaces anything, and the server bundle's fetch-claude-cli answers in lines the shell relays (claude_cli.rs).
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { cliPath, fetchClaudeCli, packageFor, type FetchDeps } from "../engine/claude/cliFetch";

const tgz = Buffer.from("pretend tarball bytes");
const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;

function deps(o: { integrity?: string; runs?: boolean } = {}): FetchDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: (async (url: string) => {
      asked.push(String(url));
      if (String(url).startsWith("https://registry.npmjs.org/")) return new Response(JSON.stringify({ dist: { tarball: "https://example.test/cli.tgz", integrity: o.integrity ?? integrity } }));
      return new Response(tgz, { headers: { "content-length": String(tgz.length) } });
    }) as typeof fetch,
    untar: (_t, into) => {
      mkdirSync(join(into, "package"), { recursive: true });
      writeFileSync(join(into, "package", "claude"), "#!/bin/sh\n");
      return null;
    },
    probe: (cli) => (cli.includes("incoming") && o.runs !== false ? "9.9.9 (Claude Code)" : existsSync(cli) && !cli.includes("incoming") ? "9.9.9 (Claude Code)" : null),
    platform: "linux",
    arch: "x64",
    env: {},
  };
}

describe("fetching Claude Code for the laptop", () => {
  it("names the package for every machine the app ships for, none elsewhere", () => {
    for (const p of ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"]) expect(packageFor(p.split("-")[0]!, p.split("-")[1]!)).toBe(`@anthropic-ai/claude-agent-sdk-${p}`);
    expect(packageFor("linux", "riscv64")).toBeNull();
  });

  it("downloads the pinned package, checks npm's hash, and puts a CLI that runs where everything looks", async () => {
    const state = mkdtempSync(join(tmpdir(), "vc-clifetch-"));
    const d = deps();
    const seen: number[] = [];
    const r = await fetchClaudeCli(state, (done) => seen.push(done), d);
    expect(r).toEqual({ cli: cliPath(state, "linux"), version: "9.9.9 (Claude Code)" });
    expect(d.asked[0]).toMatch(/^https:\/\/registry\.npmjs\.org\/@anthropic-ai\/claude-agent-sdk-linux-x64\/\d+\.\d+\.\d+$/);
    expect(seen.at(-1)).toBe(tgz.length);
    expect(existsSync(join(state, "claude", "incoming.tgz"))).toBe(false);
    // Asked again: the one it has, no download.
    const again = deps();
    expect(await fetchClaudeCli(state, () => {}, again)).toEqual(r);
    expect(again.asked).toEqual([]);
    rmSync(state, { recursive: true, force: true });
  });

  it("refuses a download that does not match npm's hash, and one that would not run here", async () => {
    const state = mkdtempSync(join(tmpdir(), "vc-clifetch-"));
    await expect(fetchClaudeCli(state, () => {}, deps({ integrity: "sha512-AAAA" }))).rejects.toThrow(/did not match what npm published/);
    await expect(fetchClaudeCli(state, () => {}, deps({ runs: false }))).rejects.toThrow(/would not run here/);
    expect(existsSync(cliPath(state, "linux"))).toBe(false);
    rmSync(state, { recursive: true, force: true });
  });

  it("the built server bundle answers fetch-claude-cli in lines without starting the server", () => {
    const bundle = join(__dirname, "..", "..", "dist-server", "vault-chat-server.mjs");
    expect(existsSync(bundle)).toBe(true);
    const state = mkdtempSync(join(tmpdir(), "vc-clifetch-"));
    // A CLI already in place: the answer comes at once, with no network.
    const cli = cliPath(state);
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, process.platform === "win32" ? "" : "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
    const out = execFileSync(process.execPath, [bundle, "fetch-claude-cli", state], { encoding: "utf8", timeout: 60_000 });
    const last = JSON.parse(out.trim().split("\n").at(-1)!);
    if (process.platform !== "win32") expect(last).toEqual({ ok: { cli, version: "9.9.9 (Claude Code)" } });
    expect(readFileSync(cli, "utf8")).toContain("9.9.9");
    rmSync(state, { recursive: true, force: true });
  });
});
