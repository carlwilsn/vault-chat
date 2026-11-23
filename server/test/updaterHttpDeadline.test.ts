import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

async function cases(...names: string[]) {
  const script = fileURLToPath(new URL("../deploy/test/test-http-readiness.py", import.meta.url));
  // Deliberate allowlist: no provider credentials, vault configuration or live-service env.
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile("python3", [script, ...names.map(name => name.includes(".") ? name : `Readiness.${name}`)], { env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` }, timeout: 20_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  expect(result.error, result.stderr).toBeNull();
  expect(result.stderr).toContain("OK");
}

// Each stdlib scenario owns its process/servers, retaining the original 20s
// process ceiling and all strict inner HTTP/start/cancellation deadlines.
it.concurrent.each([
  "test_actual_entry_binary_fallback_never_invokes_source_recovery_and_suppresses_retry",
  "test_actual_updater_entry_uses_http_check_and_records_failure",
  "test_alive_startup_process_never_opens_http",
  "test_connection_refused_and_bound_but_not_listening",
  "test_failed_candidate_without_fallback_is_suppressed_even_when_current",
  "test_long_poll_cannot_extend_window",
  "test_real_http_schema_identity_status_and_body_deadline",
  "test_start_submission_is_inside_same_deadline",
  "test_term_and_ctrl_c_cleanup_active_curl",
  "test_current_symlink_is_not_actual_http_readiness",
  "test_failed_restart_cannot_accept_a_stale_healthy_daemon",
  // The wait before the restart (busy.runs, busy.workers, busy.inputs), on the real entry.
  "test_busy_wait_holds_for_background_workers",
  "test_busy_wait_reads_a_server_without_the_workers_field_as_zero",
  // The wait is bounded (2026-11-16: a box never idle starved every update until systemd's 3 h timeout): past the
  // maximum it says so once and updates, inside the unit's timeout; a server that does not answer is waited for.
  "test_busy_wait_is_bounded_then_updates_anyway",
  "test_installed_unit_timeout_outlasts_the_maximum_wait",
  "test_busy_wait_holds_while_health_does_not_answer",
  // Behind the front: the hand-over waits for the old server's work, is asked again when declined, and a new
  // server that never stands by never takes traffic.
  "Front.test_hand_over_only_when_no_work_runs",
  "Front.test_declined_hand_over_is_asked_again",
  "Front.test_new_server_that_never_stands_by_never_takes_traffic",
  // Past the maximum wait an old server that keeps declining is stopped (systemd's stop) and the stand-by serves.
  "Front.test_old_server_that_keeps_declining_is_stopped_after_the_maximum_wait",
  // Workers a server resumes on the next one (busy.resumesWork) hold it minutes, not hours; a run still holds it;
  // an older server's workers hold it as before (it would end them with nothing said).
  "Front.test_workers_a_server_resumes_hold_it_minutes_not_hours_and_it_hands_over",
  "Front.test_workers_of_a_server_that_cannot_resume_them_still_hold_it",
  "Front.test_a_run_still_holds_it_on_a_server_that_resumes_workers",
  // A fallback is only a release that supports the front (2026-11-16: 0.8.91 crash-looped on 8848), `current` stays
  // on what serves, marks carry their reason, and a reasonless (older) mark is retried once.
  "Front.test_fallback_never_starts_a_release_from_before_the_front",
  "Front.test_fallback_to_a_release_that_supports_the_front",
  "Front.test_fallback_that_never_stands_by_leaves_current_on_what_serves",
  "Front.test_a_failed_mark_without_reason_is_retried_once_with_reason_never",
// The test timeout covers that 20s process ceiling (vitest's 5s default cut the slower multi-case ones on a loaded box).
])("bounded owned HTTP updater: %s", async name => { await cases(name); }, 25_000);
