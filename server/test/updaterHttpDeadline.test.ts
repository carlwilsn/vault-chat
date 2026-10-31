import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("bounds the executing updater HTTP/start path using owned ephemeral servers (stdlib; no live service)", async () => {
  const script = fileURLToPath(new URL("../deploy/test/test-http-readiness.py", import.meta.url));
  // Deliberate allowlist: no provider credentials, vault configuration or live-service env.
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile("python3", [script], { env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` }, timeout: 20_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, result.stderr).toBeNull();
  expect(result.stderr).toContain("OK");
});
