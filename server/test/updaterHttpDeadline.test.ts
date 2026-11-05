import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

async function cases(...names: string[]) {
  const script = fileURLToPath(new URL("../deploy/test/test-http-readiness.py", import.meta.url));
  // Deliberate allowlist: no provider credentials, vault configuration or live-service env.
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile("python3", [script, ...names.map(name => `Readiness.${name}`)], { env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` }, timeout: 20_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, result.stderr).toBeNull();
  expect(result.stderr).toContain("OK");
}

it("bounds the executing updater HTTP/start path using owned ephemeral servers (stdlib; no live service)", async () => {
  await cases(
    "test_actual_entry_binary_fallback_never_invokes_source_recovery_and_suppresses_retry",
    "test_actual_updater_entry_uses_http_check_and_records_failure",
    "test_alive_startup_process_never_opens_http",
    "test_connection_refused_and_bound_but_not_listening",
    "test_failed_candidate_without_fallback_is_suppressed_even_when_current",
    "test_long_poll_cannot_extend_window",
    "test_real_http_schema_identity_status_and_body_deadline",
    "test_start_submission_is_inside_same_deadline",
    "test_term_and_ctrl_c_cleanup_active_curl",
  );
});

it("rechecks current selection and refuses failed restart without relaxing per-request deadlines", async () => {
  // Separate new cases from the original suite, retaining its 20s process ceiling and
  // every inner HTTP/start/cancellation deadline instead of growing a gate timeout.
  await cases("test_current_symlink_is_not_actual_http_readiness", "test_failed_restart_cannot_accept_a_stale_healthy_daemon");
});
