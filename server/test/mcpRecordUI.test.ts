import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserOnlyError } from "../recordUI";
import { externalRecordUI } from "../mcp/recordUI";
import { runSandboxed } from "../vaultTools";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const url = "http://127.0.0.1:1500/";

describe("external recorder authority before browser launch", () => {
  it("refuses commands even hidden alongside another action, malformed steps and non-http navigation", () => {
    for (const args of [
      { url, steps: [{ click: "#go", run: "echo escaped" }] },
      { url, steps: [{ run: "echo escaped" }] },
      { url, steps: [null] },
      { url, steps: [{ evaluate: "1+1" }] },
      { url, steps: [{ click: "#go", arbitrary: "x" }] },
      { url, steps: [{ goto: "file:///etc/passwd" }] },
      { url, steps: [{ goto: "javascript:alert(1)" }] },
      { url: "file:///etc/passwd" },
      { url: "http://user:password@localhost/" },
    ]) expect(browserOnlyError(args as any), JSON.stringify(args)).toBeTruthy();
    expect(browserOnlyError({ url, steps: [{ type: "hello", into: "#name" }, { press: "Enter" }, { waitFor: { text: "hello" }, timeout: 200 }, { goto: url }, { shot: "end" }] })).toBeNull();
  });

  it("fails closed without the sandbox and never accepts a client output path", async () => {
    const vault = mkdtempSync(join(tmpdir(), "vc-external-recorder-")); dirs.push(vault);
    const allow = async () => null;
    expect(await externalRecordUI(null, vault, { url }, allow)).toMatchObject({ ok: false, text: expect.stringMatching(/installed sandbox/) });
    for (const out of ["../escape.mp4", "/tmp/escape.mp4", ".vault-chat/visuals/existing.mp4"]) {
      expect(await externalRecordUI(["not-launched"], vault, { url, out }, allow)).toMatchObject({ ok: false, text: expect.stringMatching(/omit out/) });
    }
    expect(existsSync(join(vault, ".vault-chat"))).toBe(false);
  });

  it("cancels the shared sandbox runner and refuses an already-aborted recording", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const pending = runSandboxed(null, [process.execPath, "-e", "setInterval(()=>{},1000)"], { cwd: tmpdir(), timeoutMs: 20000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await pending;
    expect(Date.now() - start).toBeLessThan(5000);
    await expect(externalRecordUI(null, tmpdir(), { url }, async () => null, { signal: controller.signal })).rejects.toThrow();
  });

  it("uses the shared realpath and write-deny policy before creating any output", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-external-recorder-")); dirs.push(root);
    const vault = join(root, "vault"); mkdirSync(vault); mkdirSync(join(vault, ".vault-chat"));
    const outside = join(root, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(vault, ".vault-chat", "visuals"));
    const policy = await import("../engine/pi/ext/policy.mjs");
    const check = async (path: string, write?: boolean) => {
      expect(write).toBe(true);
      const real = policy.realish(path, vault, root);
      if (!policy.isUnder(real, vault)) return "Path is outside the explicitly bound vault.";
      return policy.guardToolCall("write", { path }, { cwd: vault, home: root, denyRead: [], denyWrite: [join(vault, ".vault-chat")] });
    };
    expect(await externalRecordUI(["not-launched"], vault, { url }, check)).toMatchObject({ ok: false, text: expect.stringMatching(/outside/) });
    rmSync(join(vault, ".vault-chat", "visuals"));
    expect(await externalRecordUI(["not-launched"], vault, { url }, check)).toMatchObject({ ok: false, text: expect.stringMatching(/read-only/) });
    expect(existsSync(join(vault, ".vault-chat", "visuals"))).toBe(false);
  });
});
