"""Clipboard-only real X11 checks; no app, live display, or UI capture."""
import importlib.util
import os
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location('real_desktop', Path(__file__).with_name('real-desktop.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class ClipboardReadiness(unittest.TestCase):
    def setUp(self):
        readfd, writefd = os.pipe()
        self.xvfb = subprocess.Popen(['Xvfb', '-displayfd', str(writefd), '-screen', '0', '100x100x24', '-nolisten', 'tcp'],
                                     pass_fds=(writefd,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.close(writefd)
        with os.fdopen(readfd) as display:
            number = display.readline().strip()
        self.assertTrue(number)
        self.env = dict(os.environ, DISPLAY=':' + number)
        self.owners = []

    def tearDown(self):
        for owner in self.owners:
            if owner.poll() is None:
                owner.terminate()
            owner.wait(timeout=5)
            if owner.stdin and not owner.stdin.closed:
                owner.stdin.close()
        self.xvfb.terminate()
        self.xvfb.wait(timeout=5)

    def owner(self, target, payload=None):
        owner = subprocess.Popen(['xclip', '-selection', 'clipboard', '-target', target, '-quiet'],
                                 env=self.env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.owners.append(owner)
        if payload is not None:
            owner.stdin.write(payload)
            owner.stdin.close()
        return owner

    def ready(self, owner, target, payload):
        return driver.owned_clipboard_ready(owner, self.env, target, payload)

    def test_utf8_handshake_and_exact_bytes_without_legacy_string(self):
        payload = 'Exact café λ 🎹\n'.encode('utf-8')
        owner = self.owner('UTF8_STRING')
        # Deterministically hold stdin open: producer exists but has not acquired
        # CLIPBOARD. This reproduced the misleading STRING error in the old read.
        old = subprocess.run(['xclip', '-selection', 'clipboard', '-target', 'UTF8_STRING', '-o'],
                             env=self.env, capture_output=True, timeout=5)
        self.assertNotEqual(old.returncode, 0)
        self.assertIn(b'target STRING not available', old.stderr)
        self.assertFalse(self.ready(owner, 'UTF8_STRING', payload))
        owner.stdin.write(payload)
        owner.stdin.close()
        driver.wait_for(lambda: self.ready(owner, 'UTF8_STRING', payload), 'UTF8 owner handshake', seconds=5)
        self.assertFalse(self.ready(owner, 'STRING', payload))
        self.assertFalse(self.ready(owner, 'text/html', payload))
        self.assertFalse(self.ready(owner, 'UTF8_STRING', payload + b'changed'))

    def test_html_target_and_exact_inline_photo_bytes(self):
        payload = b'<img src="data:image/png;base64,owned-fixture">'
        owner = self.owner('text/html', payload)
        driver.wait_for(lambda: self.ready(owner, 'text/html', payload), 'HTML owner handshake', seconds=5)
        self.assertFalse(self.ready(owner, 'UTF8_STRING', payload))
        self.assertFalse(self.ready(owner, 'text/html', payload + b'changed'))

    def test_owner_exit_fails_immediately_instead_of_polling_to_timeout(self):
        owner = self.owner('UTF8_STRING', b'owned')
        driver.wait_for(lambda: self.ready(owner, 'UTF8_STRING', b'owned'), 'owner handshake', seconds=5)
        owner.terminate()
        owner.wait(timeout=5)
        with self.assertRaises(driver.ClipboardOwnerExited):
            driver.wait_for(lambda: self.ready(owner, 'UTF8_STRING', b'owned'), 'must fail fast', seconds=5)

    def test_lost_selection_never_accepts_another_owners_bytes(self):
        first = self.owner('UTF8_STRING', b'first')
        driver.wait_for(lambda: self.ready(first, 'UTF8_STRING', b'first'), 'first owner', seconds=5)
        second = self.owner('UTF8_STRING', b'second')
        driver.wait_for(lambda: self.ready(second, 'UTF8_STRING', b'second'), 'second owner', seconds=5)
        # xclip may exit on SelectionClear; either way the old owner cannot pass.
        try:
            self.assertFalse(self.ready(first, 'UTF8_STRING', b'first'))
        except driver.ClipboardOwnerExited:
            pass


if __name__ == '__main__':
    unittest.main()
