#!/usr/bin/env python3
"""Owned ephemeral HTTP + real updater entry; no installed units, vaults or credentials."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "vault-chat-update.sh"
SOURCE = SCRIPT.read_text()
HELPER = SOURCE[SOURCE.index("wait_for_version()") : SOURCE.index("\nrecord_failure()")]
REV = "a" * 40
GOOD = {"ok": True, "app": "vault-chat-server", "version": "1.0.1", "rev": REV,
        "releaseReadiness": {"status": "healthy"}}


class Fixture:
    def __init__(self, mode="good"):
        self.mode = mode
        self.requests = []
        self.posts = []
        self.sockets = []
        self.started = threading.Event()
        self.disconnected = threading.Event()
        self.disconnected_at = None
        self.state = None
        # Mode "busy": the busy document of each health poll of the running 1.0.0, in order
        # (the last one repeats), and how many of them were served.
        self.busy = []
        self.polls = 0
        self.release = {}
        self.bundle = b"// inert owned release fixture; never executed\n"
        self.meta = json.dumps({"version": "1.0.1", "rev": REV,
                                "sha256": hashlib.sha256(self.bundle).hexdigest()}).encode()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                owner.posts.append(self.path)
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def do_GET(self):
                if self.path == "/release":
                    body = json.dumps(owner.release).encode()
                elif self.path == "/bundle":
                    body = owner.bundle
                elif self.path == "/sha":
                    body = (hashlib.sha256(owner.bundle).hexdigest() + "  vault-chat-server.mjs\n").encode()
                elif self.path == "/meta":
                    body = owner.meta
                elif self.path == "/api/v1/health":
                    owner.requests.append(time.monotonic())
                    owner.started.set()
                    mode = owner.mode
                    if mode.startswith("first"):
                        mode = mode[5:] if len(owner.requests) == 1 else "500"
                    if mode in ("hung", "partial"):
                        owner.sockets.append(self.connection)
                        if mode == "partial":
                            self.send_response(200)
                            self.send_header("Content-Length", "2000")
                            self.end_headers()
                            self.wfile.write(b'{"ok":true,')
                            self.wfile.flush()
                        # Read until curl is killed/disconnected: no sleeping test threads left over.
                        try:
                            while self.connection.recv(1024):
                                pass
                        except OSError:
                            pass
                        owner.disconnected_at = time.monotonic()
                        owner.disconnected.set()
                        return
                    data = dict(GOOD)
                    if mode in ("rollback", "fallback-failed", "fallback-pending"):
                        data["busy"] = {"runs": 0, "inputs": 0}
                        if (owner.state / "current").readlink() == Path("versions/1.0.0"):
                            data.update(version="1.0.0", rev="b" * 40)
                            if mode != "rollback":
                                data["releaseReadiness"] = {"status": "pending" if mode == "fallback-pending" else "failed"}
                        else:
                            data["releaseReadiness"] = {"status": "failed", "binaryFallback": False}
                    if mode == "front":
                        if (owner.state / "active-backend").read_text() == "8851":
                            doc = owner.busy[min(owner.polls, len(owner.busy) - 1)]
                            data.update(version="1.0.0", rev="b" * 40, busy=doc)
                            owner.polls += 1
                            if doc.get("runs") or doc.get("workers"):
                                owner.busy_at.append(time.monotonic())
                    if mode == "front-failed":
                        # Behind the front: 1.0.1 is current and fails readiness; the retained 1.0.0 is healthy.
                        if (owner.state / "current").readlink() == Path("versions/1.0.0"):
                            data.update(version="1.0.0", rev="b" * 40)
                        else:
                            data["releaseReadiness"] = {"status": "failed"}
                    if mode == "busy" and (owner.state / "current").readlink() == Path("versions/1.0.0"):
                        data.update(version="1.0.0", rev="b" * 40, busy=owner.busy[min(owner.polls, len(owner.busy) - 1)])
                        owner.polls += 1
                    if mode == "old":
                        data["rev"] = "b" * 40
                    if mode == "oldversion":
                        data["version"] = "1.0.0"
                    if mode == "wrongbody":
                        data = {"listening": True}
                    if mode in ("pending", "failed"):
                        data["releaseReadiness"] = {"status": mode}
                    body = b"not-json" if mode == "invalid" else json.dumps(data).encode()
                    if mode in ("500", "503", "502", "401"):
                        self.send_response(int(mode))
                        self.end_headers()
                        self.wfile.write(body)
                        return
                    if mode == "redirect":
                        self.send_response(302)
                        self.end_headers()
                        self.wfile.write(body)
                        return
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        self.release = {"tag_name": "v1.0.1", "draft": False, "assets": [
            {"name": name, "browser_download_url": self.url + route} for name, route in [
                ("server-version.json", "/meta"), ("vault-chat-server.mjs", "/bundle"),
                ("vault-chat-server.mjs.sha256", "/sha")]]}

    def __enter__(self):
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01})
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        for connection in self.sockets:
            connection.close()
        self.server.server_close()
        self.thread.join()


class Readiness(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vc-http-readiness-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "systemctl.jsonl"
        self.started = self.root / "start-time"
        # Only this executable can be resolved by the updater for unit operations.
        fake = self.bin / "systemctl"
        fake.write_text("#!" + os.sys.executable + "\nimport json,os,sys,time\n"
                        "with open(os.environ['TEST_CALLS'],'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n"
                        "with open(os.environ['TEST_STARTED'],'w') as f: f.write(str(time.monotonic()))\n"
                        "time.sleep(float(os.environ.get('TEST_START_DELAY','0')))\n"
                        "sys.exit(int(os.environ.get('TEST_START_STATUS','0')))\n")
        fake.chmod(0o755)
        self.env = {"PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                    "HOME": str(self.root), "TEST_CALLS": str(self.calls), "TEST_STARTED": str(self.started),
                    "TEST_PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                    "VC_VOICE_PIPELINE": "0", "UNIT": "owned-fixture.service", "HEALTH_POLL_S": "0.03"}

    def helper(self, url, seconds=.24, restart=True):
        env = dict(self.env, SERVER_URL=url)
        command = 'PATH="$TEST_PATH";\n' + HELPER + '\nwait_for_version 1.0.1 "$1" "' + REV + '" "" "$2"'
        start = time.monotonic()
        result = subprocess.run(["bash", "-c", command, "fixture", str(seconds), "restart" if restart else ""],
                                env=env, capture_output=True, timeout=2)
        elapsed = time.monotonic() - start
        # Cold bash/Node startup has a separate scheduling allowance. The actual startup
        # request is observed by the inert systemctl fixture INSIDE the monotonic budget:
        # bound that interval to 15ms clock/cleanup tolerance, not curl's former 5s tail.
        self.assertLess(elapsed, seconds + .20, (elapsed, result.stderr))
        self.assertLess(time.monotonic() - float(self.started.read_text()), seconds + .015)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")
        return result.returncode

    def test_real_http_schema_identity_status_and_body_deadline(self):
        for mode, expected in [("good", 0), ("old", 1), ("oldversion", 1), ("wrongbody", 1),
                               ("invalid", 1), ("500", 1), ("redirect", 1), ("hung", 1),
                               ("partial", 1), ("pending", 2), ("failed", 1)]:
            with self.subTest(mode=mode), Fixture(mode) as fixture:
                self.assertEqual(self.helper(fixture.url), expected)
                self.assertTrue(fixture.requests, "must perform real GET, not PID/listening check")

    def test_connection_refused_and_bound_but_not_listening(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.assertEqual(self.helper("http://127.0.0.1:" + str(sock.getsockname()[1])), 1)

    def test_alive_startup_process_never_opens_http(self):
        alive = subprocess.Popen([os.sys.executable, "-c", "import time; time.sleep(5)"],
                                 env={"PATH": os.environ["PATH"]})
        try:
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                self.assertEqual(self.helper("http://127.0.0.1:" + str(sock.getsockname()[1]), restart=True), 1)
                self.assertIsNone(alive.poll(), "an alive startup process is not readiness")
        finally:
            alive.terminate()
            alive.wait(timeout=1)

    def test_start_submission_is_inside_same_deadline(self):
        self.env["TEST_START_DELAY"] = "2"
        with Fixture() as fixture:
            self.assertEqual(self.helper(fixture.url, restart=True), 1)
            self.assertEqual(json.loads(self.calls.read_text()),
                             ["--user", "--no-block", "restart", "owned-fixture.service"])
            self.assertEqual(fixture.requests, [])

    def test_failed_restart_cannot_accept_a_stale_healthy_daemon(self):
        self.env["TEST_START_STATUS"] = "1"
        with Fixture() as fixture:
            self.assertEqual(self.helper(fixture.url), 1)
            self.assertEqual(fixture.requests, [], "failed startup must not verify an old daemon")

    def test_current_symlink_is_not_actual_http_readiness(self):
        # Already-current path after a pending install (or a later health failure).
        # Inert systemctl and disposable state only, never the installed service.
        for mode in ("good", "old", "oldversion", "wrongbody", "401", "502", "503", "pending", "failed"):
            with self.subTest(mode=mode), Fixture(mode) as fixture:
                state = self.root / ("current-" + mode)
                current = state / "versions/1.0.1"
                current.mkdir(parents=True)
                (current / "server-version.json").write_bytes(fixture.meta)
                (state / "current").symlink_to("versions/1.0.1")
                env = dict(self.env, VC_UPDATE_API=fixture.url + "/release", VC_SERVER_URL=fixture.url,
                           VC_SERVER_STATE=str(state), VC_SERVER_UNIT="owned-fixture.service",
                           VC_UPDATE_HEALTH_WAIT_S="0.24", VC_UPDATE_HEALTH_POLL_S="0.03")
                result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 0 if mode in ("good", "pending") else 1, result.stderr)
                self.assertTrue(fixture.requests)
                self.assertEqual((state / "current").readlink(), Path("versions/1.0.1"))
                self.assertEqual((state / "failed/1.0.1").exists(), mode not in ("good", "pending"))
                if mode == "good":
                    self.assertIn(b"actual box readiness", result.stdout)
                else:
                    self.assertNotIn(b"up to date", result.stdout)
                if mode == "pending":
                    self.assertIn(b"not confirmed", result.stdout)
                self.assertFalse(self.calls.exists(), "checking current does not restart it")
                self.assertEqual(fixture.posts, [])

    def test_long_poll_cannot_extend_window(self):
        self.env["HEALTH_POLL_S"] = "10"
        with Fixture("old") as fixture:
            self.assertEqual(self.helper(fixture.url), 1)

    def test_term_and_ctrl_c_cleanup_active_curl(self):
        for sig in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=sig), Fixture("hung") as fixture:
                env = dict(self.env, SERVER_URL=fixture.url)
                child = subprocess.Popen(["bash", "-c", 'PATH="$TEST_PATH";\n' + HELPER + '\nwait_for_version 1.0.1 5 "' + REV + '"'],
                                         env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    self.assertTrue(fixture.started.wait(1))
                    child.send_signal(sig)
                    child.communicate(timeout=1)
                    self.assertEqual(child.returncode, 143 if sig == signal.SIGTERM else 130)
                    self.assertTrue(fixture.disconnected.wait(.3), "cancel must close/reap curl, not orphan it")
                finally:
                    if child.poll() is None:
                        child.kill()
                    child.communicate()

    def test_actual_entry_binary_fallback_never_invokes_source_recovery_and_suppresses_retry(self):
        for mode in ("rollback", "fallback-failed", "fallback-pending"):
            with self.subTest(mode=mode), Fixture(mode) as fixture:
                state = self.root / mode
                old = state / "versions/1.0.0"
                old.mkdir(parents=True)
                oldmeta = json.dumps({"version": "1.0.0", "rev": "b" * 40})
                (old / "server-version.json").write_text(oldmeta)
                (state / "current").symlink_to("versions/1.0.0")
                # A poisoned obsolete recovery CLI is present: neither it nor a release bundle
                # may be executed. No listening code exists in the fixture.
                ship = self.root / ".local/lib/vault-chat/simple-ship"
                ship.mkdir(parents=True, exist_ok=True)
                recovery = self.root / "recovery.json"
                (ship / "simple-ship.mjs").write_text("import fs from 'node:fs'; fs.writeFileSync(" + json.dumps(str(recovery)) + ", 'FORBIDDEN'); process.exit(99);\n")
                repo = self.root / (mode + "-repo")
                repo.mkdir()
                def git(*args):
                    return subprocess.check_output(["git", "-c", "user.name=test", "-c", "user.email=test@local", *args], cwd=repo, env=self.env)
                git("init", "-qb", "main")
                (repo / "app").write_text("accepted source remains")
                git("add", "."); git("commit", "-qm", "accepted source")
                refs, head = git("show-ref"), (repo / ".git/HEAD").read_bytes()
                fixture.state = state
                env = dict(self.env, VC_UPDATE_API=fixture.url + "/release", VC_SERVER_URL=fixture.url,
                           VC_SERVER_STATE=str(state), VC_SERVER_UNIT="owned-fixture.service",
                           VC_UPDATE_HEALTH_WAIT_S="0.24", VC_UPDATE_HEALTH_POLL_S="0.03")
                before_calls = len(self.calls.read_text().splitlines()) if self.calls.exists() else 0
                result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual((state / "current").readlink(), Path("versions/1.0.0"))
                self.assertEqual((old / "server-version.json").read_text(), oldmeta)
                self.assertTrue((state / "failed/1.0.1").exists())
                self.assertFalse(recovery.exists())
                self.assertEqual(len(self.calls.read_text().splitlines()) - before_calls, 2)
                self.assertEqual(git("show-ref"), refs); self.assertEqual((repo / ".git/HEAD").read_bytes(), head)
                self.assertEqual(fixture.posts, [])
                lines = [line for line in result.stdout.splitlines() if b"failed actual release readiness;" in line]
                self.assertEqual(len(lines), 1, result.stdout)
                self.assertIn(b"restored healthy retained" if mode == "rollback" else b"failed readiness", lines[0])
                # The actual whole updater is retried. A failed candidate is never restarted,
                # redownloaded, source-reverted or announced, regardless of fallback health.
                calls = self.calls.read_bytes()
                marker = (state / "failed/1.0.1").stat()
                self.assertEqual(json.loads(next((state / "release-failures").glob("*.json")).read_text())["revision"], REV)
                retry = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, timeout=3)
                self.assertEqual(retry.returncode, 0, retry.stderr)
                self.assertIn(b"skipping 1.0.1", retry.stdout)
                self.assertEqual(self.calls.read_bytes(), calls)
                self.assertEqual((state / "failed/1.0.1").stat().st_mtime_ns, marker.st_mtime_ns)
                self.assertEqual(git("show-ref"), refs); self.assertEqual((repo / ".git/HEAD").read_bytes(), head)
                self.assertFalse(recovery.exists()); self.assertEqual(fixture.posts, [])

    def test_failed_candidate_without_fallback_is_suppressed_even_when_current(self):
        with Fixture("failed") as fixture:
            state = self.root / "no-fallback"
            env = dict(self.env, VC_UPDATE_API=fixture.url + "/release", VC_SERVER_URL=fixture.url,
                       VC_SERVER_STATE=str(state), VC_SERVER_UNIT="owned-fixture.service",
                       VC_UPDATE_HEALTH_WAIT_S="0.24", VC_UPDATE_HEALTH_POLL_S="0.03")
            result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(b"failed actual release readiness; no retained binary", result.stdout)
            self.assertEqual((state / "current").readlink(), Path("versions/1.0.1"))
            self.assertRegex((state / "failed/1.0.1").read_bytes(), rb"^\S+Z failed actual release readiness after install; no retained binary\n$")
            calls = self.calls.read_bytes()
            retry = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, timeout=3)
            self.assertEqual(retry.returncode, 0, retry.stderr)
            self.assertIn(b"skipping 1.0.1", retry.stdout)
            self.assertEqual(self.calls.read_bytes(), calls)
            self.assertEqual(fixture.posts, [])

    def test_actual_updater_entry_uses_http_check_and_records_failure(self):
        # Full ordinary entry, real downloads/hashes, symlink and restart call. No helper override.
        for mode in ("good", "old", "wrongbody", "500", "pending", "firsthung", "firstpartial"):
            with self.subTest(mode=mode), Fixture(mode) as fixture:
                state = self.root / mode
                env = dict(self.env, VC_UPDATE_API=fixture.url + "/release", VC_SERVER_URL=fixture.url,
                           VC_SERVER_STATE=str(state), VC_SERVER_UNIT="owned-fixture.service",
                           VC_UPDATE_HEALTH_WAIT_S="0.24", VC_UPDATE_HEALTH_POLL_S="0.03",
                           VC_UPDATE_BIN_DIR=str(self.root / "installed-bin"),
                           VC_UPDATE_UNITS_DIR=str(self.root / "installed-units"))
                if mode == "good":
                    # Exercise the ordinary configured-port route, not only URL overrides.
                    env.pop("VC_SERVER_URL")
                    env["VC_PORT"] = str(fixture.server.server_port)
                result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 0 if mode in ("good", "pending") else 1, result.stderr)
                self.assertEqual((state / "current").readlink(), Path("versions/1.0.1"))
                self.assertEqual((state / "failed/1.0.1").exists(), mode not in ("good", "pending"))
                self.assertTrue(fixture.requests)
                if mode.startswith("first"):
                    self.assertTrue(fixture.disconnected.wait(.3))
                    self.assertLess(fixture.disconnected_at - float(self.started.read_text()), .24 + .015)
                self.assertNotIn(b'"rev"', result.stdout)  # No raw health/private document dump.
                if mode == "good":
                    self.assertIn(b"actual box readiness", result.stdout)
                elif mode == "pending":
                    self.assertIn(b"not confirmed and not reverted", result.stdout)
                else:
                    self.assertIn(b" failed actual release readiness after install; no retained binary", (state / "failed/1.0.1").read_bytes())
                    self.assertEqual(json.loads(next((state / "release-failures").glob("*.json")).read_text())["revision"], REV)
                for call in self.calls.read_text().splitlines():
                    self.assertEqual(json.loads(call), ["--user", "--no-block", "restart", "owned-fixture.service"])

    def busy_update(self, name, busy, max_s="30"):
        # The real updater entry against a running 1.0.0 whose health answers the scripted busy
        # documents, one per poll, until `current` is swapped to the 1.0.1 release (then: healthy).
        with Fixture("busy") as fixture:
            state = self.root / name
            old = state / "versions/1.0.0"
            old.mkdir(parents=True)
            (old / "server-version.json").write_text(json.dumps({"version": "1.0.0", "rev": "b" * 40}))
            (state / "current").symlink_to("versions/1.0.0")
            fixture.state, fixture.busy = state, busy
            env = dict(self.env, VC_UPDATE_API=fixture.url + "/release", VC_SERVER_URL=fixture.url,
                       VC_SERVER_STATE=str(state), VC_SERVER_UNIT="owned-fixture.service",
                       VC_UPDATE_HEALTH_WAIT_S="3", VC_UPDATE_HEALTH_POLL_S="0.03",
                       VC_UPDATE_BUSY_POLL_S="0.02", VC_UPDATE_BUSY_MAX_S=max_s,
                       VC_UPDATE_BIN_DIR=str(self.root / "installed-bin"),
                       VC_UPDATE_UNITS_DIR=str(self.root / "installed-units"))
            before_calls = len(self.calls.read_text().splitlines()) if self.calls.exists() else 0
            result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, timeout=12)
            out = result.stdout.decode()
            # However long it waited, it then updated: once, to the release, and healthy.
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((state / "current").readlink(), Path("versions/1.0.1"))
            self.assertEqual(self.calls.read_text().splitlines()[before_calls:],
                             [json.dumps(["--user", "--no-block", "restart", "owned-fixture.service"])])
            self.assertIn("actual box readiness", out)
            return out, fixture.polls

    def test_busy_wait_holds_for_background_workers(self):
        # Nothing but background workers (no run, no input on a surface): the restart that would
        # kill them waits until health says none is left — one poll each for 2, 1 and 0.
        out, polls = self.busy_update("workers", [{"runs": 0, "workers": w, "inputs": 0} for w in (2, 1, 0)])
        self.assertEqual(polls, 3)
        self.assertIn("server busy (0 runs, 2 background workers, 0 surfaces in use) — waiting for it to go idle", out)
        self.assertNotIn("updating anyway", out)
        # Workers and a run together: both must end (the run first here, then the worker).
        out, polls = self.busy_update("run-and-workers", [{"runs": 1, "workers": 1, "inputs": 0},
                                                         {"runs": 0, "workers": 1, "inputs": 0},
                                                         {"runs": 0, "workers": 0, "inputs": 0}])
        self.assertEqual(polls, 3)
        self.assertIn("server busy (1 runs, 1 background workers, 0 surfaces in use)", out)
        # Idle: no wait at all.
        out, polls = self.busy_update("idle", [{"runs": 0, "workers": 0, "inputs": 0}])
        self.assertEqual(polls, 1)
        self.assertNotIn("server busy", out)

    def test_busy_wait_reads_a_server_without_the_workers_field_as_zero(self):
        # A server that predates busy.workers never reports it: that is 0 workers, not a wait
        # and not an error…
        out, polls = self.busy_update("old-idle", [{"runs": 0, "inputs": 0}])
        self.assertEqual(polls, 1)
        self.assertNotIn("server busy", out)
        # …and what it does report still holds the update back, as before.
        out, polls = self.busy_update("old-run", [{"runs": 1, "inputs": 0}, {"runs": 0, "inputs": 1}, {"runs": 0, "inputs": 0}])
        self.assertEqual(polls, 3)
        self.assertIn("server busy (1 runs, 0 background workers, 0 surfaces in use) — waiting for it to go idle", out)
        self.assertNotIn("updating anyway", out)

    def test_busy_wait_is_bounded_then_updates_anyway(self):
        # 2026-11-16: workers that never reach 0 (a box with agents at work around the clock, or a count that never
        # comes down) held every update until systemd killed the pass at 3 h, from 05:58 on. The wait is bounded:
        # past VC_UPDATE_BUSY_MAX_S it says so once and updates, well inside the unit's timeout.
        start = time.monotonic()
        out, polls = self.busy_update("stuck", [{"runs": 0, "workers": 3, "inputs": 0}], max_s="1")
        self.assertLess(time.monotonic() - start, 8)
        self.assertGreaterEqual(polls, 2)
        self.assertIn("server busy (0 runs, 3 background workers, 0 surfaces in use) — waiting for it to go idle (at most 1s)", out)
        self.assertEqual(out.count("updating anyway"), 1)
        self.assertIn("still busy after 1s (0 runs, 3 background workers, 0 surfaces in use): updating anyway", out)
        # A run (or a voice call) is bounded the same way.
        out, _ = self.busy_update("stuck-run", [{"runs": 1, "workers": 0, "inputs": 0}], max_s="1")
        self.assertIn("still busy after 1s (1 runs, 0 background workers, 0 surfaces in use): updating anyway", out)

    def test_installed_unit_timeout_outlasts_the_maximum_wait(self):
        # The bounded wait must really end the pass: the default maximum (plus downloads, stand-by and health
        # checks) fits inside the unit's TimeoutStartSec, or systemd kills the pass first and nothing installs.
        unit = (SCRIPT.parent / "vault-chat-update.service").read_text()
        timeout = unit.split("TimeoutStartSec=")[1].split()[0]
        secs = int(timeout[:-1]) * {"h": 3600, "m": 60, "s": 1}[timeout[-1]]
        default_max = int(SOURCE.split('BUSY_MAX_S="${VC_UPDATE_BUSY_MAX_S:-')[1].split("}")[0])
        standby = int(SOURCE.split('STANDBY_WAIT_S="${VC_UPDATE_STANDBY_WAIT_S:-')[1].split("}")[0])
        self.assertLessEqual(default_max + standby + 30 * 60, secs)

    def test_busy_wait_holds_while_health_does_not_answer(self):
        # A running server that does not answer its health (a busy event loop) is waited for, never skipped
        # (2026-11-15 22:41: "server not answering /api/v1/health — not waiting for it" killed live workers).
        with Fixture("busy") as fixture:
            state = self.root / "silent"
            old = state / "versions/1.0.0"
            old.mkdir(parents=True)
            (old / "server-version.json").write_text(json.dumps({"version": "1.0.0", "rev": "b" * 40}))
            (state / "current").symlink_to("versions/1.0.0")
            fixture.state = state
            fixture.busy = [{"runs": 0, "workers": 0, "inputs": 0}]
            fixture.mode = "500"   # not answering, for now
            env = dict(self.env, VC_UPDATE_API=fixture.url + "/release", VC_SERVER_URL=fixture.url,
                       VC_SERVER_STATE=str(state), VC_SERVER_UNIT="owned-fixture.service",
                       VC_UPDATE_HEALTH_WAIT_S="3", VC_UPDATE_HEALTH_POLL_S="0.03",
                       VC_UPDATE_BUSY_POLL_S="0.02", VC_UPDATE_BUSY_MAX_S="30",
                       VC_UPDATE_BIN_DIR=str(self.root / "installed-bin"), VC_UPDATE_UNITS_DIR=str(self.root / "installed-units"))
            p = subprocess.Popen(["bash", str(SCRIPT)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            time.sleep(1.5)
            self.assertIsNone(p.poll())
            self.assertEqual((state / "current").readlink(), Path("versions/1.0.0"))
            self.assertFalse(self.calls.exists() and any("restart" in c for c in self.calls.read_text().splitlines()))
            fixture.mode = "busy"  # it answers again: idle
            out = p.communicate(timeout=10)[0].decode()
            self.assertEqual(p.returncode, 0, out)
            self.assertIn("server not answering /api/v1/health — waiting (at most 30s)", out)
            self.assertEqual((state / "current").readlink(), Path("versions/1.0.1"))


class Front(unittest.TestCase):
    """The hand-over behind the front, on the real updater entry: a stateful fake systemctl plays the two slots
    (start = the new one reads ahead and stands by; SIGUSR2 = the old one hands over, or declines while busy)."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vc-front-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        old = self.state / "versions/1.0.0"
        old.mkdir(parents=True)
        (old / "server-version.json").write_text(json.dumps({"version": "1.0.0", "rev": "b" * 40}))
        (self.state / "current").symlink_to("versions/1.0.0")
        (self.state / "active-backend").write_text("8851")
        self.units = self.root / "units"
        self.units.mkdir()
        (self.units / "vault-chat-front.service").write_text("# installed\n")
        self.active = self.root / "active-units"
        self.active.mkdir()
        for u in ("vault-chat-front.service", "vault-chat-server@8851.service"):
            (self.active / u).write_text("")
        self.calls = self.root / "calls.jsonl"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        fake = self.bin / "systemctl"
        fake.write_text("#!" + os.sys.executable + "\n" + '''
import json, os, sys, time
from pathlib import Path
a = [x for x in sys.argv[1:] if x not in ("--user", "--quiet", "--no-block")]
act, st = Path(os.environ["T_ACTIVE"]), Path(os.environ["T_STATE"])
with open(os.environ["T_CALLS"], "a") as f: f.write(json.dumps([time.monotonic()] + a) + "\\n")
if a[0] == "is-active": sys.exit(0 if (act / a[1]).exists() else 3)
if a[0] == "start":
    port = a[1].split("@")[1].split(".")[0]
    if os.environ.get("T_NO_STANDBY"): sys.exit(0)
    (act / a[1]).write_text("")
    others = [u for u in os.listdir(act) if u.startswith("vault-chat-server@") and u != a[1]]
    (st / ("standby" if others else "active-backend")).write_text(port)
if a[0] == "stop":
    was = (act / a[1]).exists()
    (act / a[1]).unlink(missing_ok=True)
    sb = st / "standby"
    if was and sb.exists(): (st / "active-backend").write_text(sb.read_text()); sb.unlink()
if a[0] == "kill":
    unit = a[-1]
    decline = Path(os.environ["T_DECLINE"])
    n = int(decline.read_text()) if decline.exists() else 0
    if n > 0: decline.write_text(str(n - 1)); sys.exit(0)
    (act / unit).unlink(missing_ok=True)
    sb = st / "standby"
    if sb.exists(): (st / "active-backend").write_text(sb.read_text()); sb.unlink()
''')
        fake.chmod(0o755)
        self.env = {"PATH": str(self.bin) + os.pathsep + os.environ["PATH"], "HOME": str(self.root),
                    "T_ACTIVE": str(self.active), "T_STATE": str(self.state), "T_CALLS": str(self.calls),
                    "T_DECLINE": str(self.root / "decline")}

    def run_update(self, fixture, **extra):
        fixture.state = self.state
        env = dict(self.env, VC_UPDATE_API=fixture.url + "/release", VC_SERVER_URL=fixture.url,
                   VC_SERVER_STATE=str(self.state), VC_UPDATE_HEALTH_WAIT_S="3", VC_UPDATE_HEALTH_POLL_S="0.03",
                   VC_UPDATE_BUSY_POLL_S="0.02", VC_UPDATE_BUSY_MAX_S="30", VC_UPDATE_STANDBY_WAIT_S="1", VC_UPDATE_HANDOVER_WAIT_S="1",
                   VC_UPDATE_BIN_DIR=str(self.root / "installed-bin"), VC_UPDATE_UNITS_DIR=str(self.units))
        env.update(extra)
        result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, timeout=12)
        calls = [json.loads(l) for l in self.calls.read_text().splitlines()] if self.calls.exists() else []
        return result, calls

    def front_fixture(self, busy):
        f = Fixture("front")
        f.busy = busy
        f.busy_at = []
        return f

    def test_hand_over_only_when_no_work_runs(self):
        busy = [{"runs": 0, "workers": 2, "inputs": 0}, {"runs": 1, "workers": 1, "inputs": 0}, {"runs": 0, "workers": 0, "inputs": 0}]
        with self.front_fixture(busy) as fixture:
            result, calls = self.run_update(fixture)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            kills = [c for c in calls if c[1] == "kill"]
            self.assertEqual(len(kills), 1)
            self.assertEqual(kills[0][-1], "vault-chat-server@8851.service")
            # Asked only after the last poll that saw work running on the old server.
            self.assertGreater(kills[0][0], max(fixture.busy_at))
            # Never stopped or restarted: the old server ends itself, after its work.
            self.assertFalse([c for c in calls if c[1] in ("stop", "restart")])
            starts = [c for c in calls if c[1] == "start"]
            self.assertEqual([c[-1] for c in starts], ["vault-chat-server@8852.service"])
            self.assertLess(starts[0][0], kills[0][0])
            self.assertEqual((self.state / "active-backend").read_text(), "8852")
            self.assertEqual((self.state / "current").readlink(), Path("versions/1.0.1"))
            self.assertIn(b"actual box readiness", result.stdout)

    def test_declined_hand_over_is_asked_again(self):
        # Work started between the idle health and the ask: the old server declines and keeps serving.
        (self.root / "decline").write_text("1")
        with self.front_fixture([{"runs": 0, "workers": 0, "inputs": 0}]) as fixture:
            result, calls = self.run_update(fixture)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len([c for c in calls if c[1] == "kill"]), 2)
            self.assertIn(b"declined the hand-over", result.stdout)
            self.assertEqual((self.state / "active-backend").read_text(), "8852")

    def test_old_server_that_keeps_declining_is_stopped_after_the_maximum_wait(self):
        # Behind the front the old server declines the hand-over while it counts work (every version does): past
        # the maximum wait the updater stops it with systemd's own stop, and the stand-by takes over.
        (self.root / "decline").write_text("1000")
        with self.front_fixture([{"runs": 0, "workers": 8, "inputs": 0}]) as fixture:
            result, calls = self.run_update(fixture, VC_UPDATE_BUSY_MAX_S="1")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            out = result.stdout.decode()
            self.assertEqual(out.count("updating anyway"), 1, out)
            self.assertIn("still busy after 1s (0 runs, 8 background workers, 0 surfaces in use): updating anyway", out)
            self.assertNotIn("declined the hand-over", out)
            kills = [c for c in calls if c[1] == "kill"]
            stops = [c for c in calls if c[1] == "stop"]
            self.assertEqual([c[-1] for c in kills], ["vault-chat-server@8851.service"])
            self.assertEqual([c[-1] for c in stops], ["vault-chat-server@8851.service"])
            self.assertLess(kills[0][0], stops[0][0])
            self.assertEqual((self.state / "active-backend").read_text(), "8852")
            self.assertEqual((self.state / "current").readlink(), Path("versions/1.0.1"))
            self.assertIn(b"actual box readiness", result.stdout)

    def test_new_server_that_never_stands_by_never_takes_traffic(self):
        with self.front_fixture([{"runs": 0, "workers": 0, "inputs": 0}]) as fixture:
            result, calls = self.run_update(fixture, T_NO_STANDBY="1")
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertFalse([c for c in calls if c[1] == "kill"])
            self.assertIn(["stop", "vault-chat-server@8852.service"], [c[1:] for c in calls])
            self.assertEqual((self.state / "active-backend").read_text(), "8851")
            self.assertTrue((self.active / "vault-chat-server@8851.service").exists())
            self.assertEqual((self.state / "current").readlink(), Path("versions/1.0.0"))
            self.assertIn(b"never stood by beside v1.0.0", (self.state / "failed/1.0.1").read_bytes())

    def current_is_failing_1_0_1(self, old_bundle):
        # 1.0.1 serves from slot 8851 and stops passing readiness; 1.0.0 is retained as its previous release.
        cur = self.state / "versions/1.0.1"
        cur.mkdir()
        (cur / "server-version.json").write_bytes(Fixture().meta)
        (cur / "previous.json").write_text(json.dumps({"previous": "versions/1.0.0"}))
        (self.state / "versions/1.0.0/vault-chat-server.mjs").write_text(old_bundle)
        (self.state / "current").unlink()
        (self.state / "current").symlink_to("versions/1.0.1")

    def test_fallback_never_starts_a_release_from_before_the_front(self):
        # 2026-11-16: 0.8.91 (before the front) was started in slot 8852 as the fallback and crash-looped on
        # "address already in use 127.0.0.1:8848"; `current` was left on it while 0.8.92 still served.
        self.current_is_failing_1_0_1("// listens on 8848 itself\n")
        with Fixture("front-failed") as fixture:
            result, calls = self.run_update(fixture)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertFalse([c for c in calls if c[1] in ("start", "stop", "kill", "restart")])
            self.assertEqual((self.state / "current").readlink(), Path("versions/1.0.1"))
            self.assertEqual((self.state / "active-backend").read_text(), "8851")
            self.assertIn(b"1.0.1 failed actual release readiness; retained v1.0.0 predates the front, not started; v1.0.1 stays", result.stdout)
            self.assertIn(b"while current; retained v1.0.0 predates the front", (self.state / "failed/1.0.1").read_bytes())
            self.assertEqual(fixture.posts, [])

    def test_fallback_to_a_release_that_supports_the_front(self):
        self.current_is_failing_1_0_1("// reads VC_BACKEND_PORT\n")
        with Fixture("front-failed") as fixture:
            result, calls = self.run_update(fixture)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertEqual([c[-1] for c in calls if c[1] == "start"], ["vault-chat-server@8852.service"])
            self.assertEqual((self.state / "active-backend").read_text(), "8852")
            self.assertEqual((self.state / "current").readlink(), Path("versions/1.0.0"))
            self.assertIn(b"restored healthy retained v1.0.0", result.stdout)
            self.assertIn(b"restored healthy retained v1.0.0", (self.state / "failed/1.0.1").read_bytes())

    def test_fallback_that_never_stands_by_leaves_current_on_what_serves(self):
        self.current_is_failing_1_0_1("// reads VC_BACKEND_PORT\n")
        with Fixture("front-failed") as fixture:
            result, calls = self.run_update(fixture, T_NO_STANDBY="1")
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn(["stop", "vault-chat-server@8852.service"], [c[1:] for c in calls])
            self.assertEqual((self.state / "current").readlink(), Path("versions/1.0.1"))
            self.assertEqual((self.state / "active-backend").read_text(), "8851")
            self.assertIn(b"retained v1.0.0 never stood by; v1.0.1 stays", result.stdout)

    def test_a_failed_mark_without_reason_is_retried_once_with_reason_never(self):
        # Marks from before reasons (the crash loop's 0.8.92) are retried; a mark with its reason is not.
        failed = self.state / "failed"
        failed.mkdir()
        (failed / "1.0.1").write_bytes(b"")
        records = self.state / "release-failures"
        records.mkdir()
        record = records / (hashlib.sha256(b"1.0.1").hexdigest() + ".json")
        record.write_text("{}")
        with self.front_fixture([{"runs": 0, "workers": 0, "inputs": 0}]) as fixture:
            result, _ = self.run_update(fixture)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn(b"retrying 1.0.1: its failed mark has no reason", result.stdout)
            self.assertFalse((failed / "1.0.1").exists())
            self.assertFalse(record.exists())
            self.assertEqual((self.state / "current").readlink(), Path("versions/1.0.1"))
        (self.state / "current").unlink()
        (self.state / "current").symlink_to("versions/1.0.0")
        (failed / "1.0.1").write_text("2026-11-16T08:42:55Z failed actual release readiness after install; no retained binary\n")
        self.calls.unlink()
        with self.front_fixture([{"runs": 0, "workers": 0, "inputs": 0}]) as fixture:
            result, calls = self.run_update(fixture)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn(b"skipping 1.0.1: it failed here before (2026-11-16T08:42:55Z failed actual release readiness after install", result.stdout)
            self.assertEqual(calls, [])

if __name__ == "__main__":
    unittest.main(verbosity=2)
