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
                    if mode == "old":
                        data["rev"] = "b" * 40
                    if mode == "oldversion":
                        data["version"] = "1.0.0"
                    if mode == "wrongbody":
                        data = {"listening": True}
                    if mode in ("pending", "failed"):
                        data["releaseReadiness"] = {"status": mode}
                    body = b"not-json" if mode == "invalid" else json.dumps(data).encode()
                    if mode == "500":
                        self.send_response(500)
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
                        "time.sleep(float(os.environ.get('TEST_START_DELAY','0')))\n")
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
            self.assertEqual((state / "failed/1.0.1").read_bytes(), b"")
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
                    self.assertEqual((state / "failed/1.0.1").read_bytes(), b"")
                    self.assertEqual(json.loads(next((state / "release-failures").glob("*.json")).read_text())["revision"], REV)
                for call in self.calls.read_text().splitlines():
                    self.assertEqual(json.loads(call), ["--user", "--no-block", "restart", "owned-fixture.service"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
