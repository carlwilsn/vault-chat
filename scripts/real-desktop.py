#!/usr/bin/env python3
"""One real Linux desktop run (not the browser preview).

  scripts/real-desktop.py --copy-vault /owned/approved/vault-chat-copy \
    --conversation project-vault-chat --min-messages 1000 --out /tmp/desktop.json

Builds this checkout's production frontend, native Tauri executable and genuine
box server; --app/--server-bundle reuse explicitly supplied builds. --before-app
runs a second native executable against the SAME frozen thread copy for comparison.
Never point --copy-vault at a live vault: supply the already approved selected copy.
Only conversation event files are copied, never config, keys, .git or other vaults.

All OS input goes to our own Xvfb + private D-Bus/HOME. WebKitWebDriver only reads
DOM, seeds the new profile's non-secret preferences, and installs a small trusted
keydown observer for NOTE (not yet covered by laptopPerf). It never sends input,
replaces IPC, or renders a substitute page. The app uses its real Rust HTTP IPC.
The loopback relay forwards reads to the real compiled server on an owned port;
blocks all inference/voice/git/writes; observes the EXISTING laptopPerf batches.
Those native batches get 403 from the server's Tailscale-only telemetry gate on
loopback. We retain that fact, not fake Tailscale headers or call it paired laptop
telemetry. Linux results do NOT replace Carl's Windows laptop probe numbers.
"""
import argparse
import collections
import contextlib
import http.client
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def request(url, body=None, method=None, timeout=90):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def wait_for(fn, what, seconds=90):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            value = fn()
            if value:
                return value
        except (OSError, ValueError, KeyError, RuntimeError):
            pass
        time.sleep(.1)
    raise RuntimeError('Timed out: ' + what)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--copy-vault', type=Path, required=True)
    p.add_argument('--conversation', required=True, help='Exact original main/project thread ID; never a lookalike Main')
    p.add_argument('--min-messages', type=int, required=True, help='Refuse an empty/wrong/short control thread')
    p.add_argument('--app', type=Path)
    p.add_argument('--before-app', type=Path)
    p.add_argument('--server-bundle', type=Path)
    p.add_argument('--out', type=Path, required=True, help='Plain result JSON outside the vault')
    p.add_argument('--work', type=Path, help='New private work directory; retained for ordinary build logs')
    p.add_argument('--nixpkgs', help='Optional local nixpkgs source for dependency provisioning')
    p.add_argument('--inside-nix', action='store_true', help=argparse.SUPPRESS)
    a = p.parse_args()
    os.umask(0o077)
    if sys.platform != 'linux':
        p.error('This measures Linux/WebKitGTK only')
    if a.conversation != 'main' and not a.conversation.startswith('project-'):
        p.error('Use an original main/project thread (older read-only chats cannot measure composer input)')
    if a.min_messages < 1:
        p.error('--min-messages must be positive')
    tools = ['Xvfb', 'xdotool', 'openbox', 'dbus-daemon', 'WebKitWebDriver', 'node', 'npm']
    if not a.app:
        tools += ['cargo', 'rustc', 'pkg-config', 'cc']
    import ctypes
    try:
        ctypes.CDLL('libayatana-appindicator3.so.1')
        indicator_ready = True
    except OSError:
        indicator_ready = False
    if any(not shutil.which(t) for t in tools) or not indicator_ready:
        if a.inside_nix or not shutil.which('nix-shell'):
            p.error('Missing native dependencies: ' + ', '.join(t for t in tools if not shutil.which(t)) + ('' if indicator_ready else ' libayatana-appindicator3'))
        pkgs = a.nixpkgs or subprocess.check_output(['nix', 'eval', '--raw', 'nixpkgs#path'], text=True).strip()
        expr = 'with import <nixpkgs> {}; mkShell { packages = [ nodejs_22 rustc cargo pkg-config gcc gtk3 webkitgtk_4_1 libsoup_3 alsa-lib openssl librsvg libayatana-appindicator xorg-server xdotool openbox dbus python3 ]; LD_LIBRARY_PATH = lib.makeLibraryPath [ libayatana-appindicator ]; }'
        # exec, not an unattended job: one command owns its children to completion.
        import shlex
        os.execvp('nix-shell', ['nix-shell', '-I', 'nixpkgs=' + pkgs, '-E', expr, '--run',
                              shlex.join([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], '--inside-nix'])])
    a.out = a.out.resolve()
    if a.out.exists():
        p.error('--out already exists; choose a fresh result, do not overwrite an earlier run')
    if a.out.is_relative_to(ROOT) or a.out.is_relative_to(a.copy_vault.resolve()):
        p.error('--out must be outside source and copied vault')
    work = a.work.resolve() if a.work else Path(tempfile.mkdtemp(prefix='vc-real-desktop-'))
    if a.work:
        work.mkdir(mode=0o700, parents=True, exist_ok=False)
    work.chmod(0o700)
    source = a.copy_vault.resolve()
    if source == ROOT or source == Path.home() or not source.is_dir():
        p.error('--copy-vault must be an approved disposable conversation copy')
    # The selected copy is the only input. No traversal of sibling vaults/private stores.
    events = source / '.vault-chat' / 'events'
    if not events.is_dir() or events.is_symlink():
        p.error('Selected copy has no regular .vault-chat/events directory')
    vault = work / 'vault-chat'
    dest = vault / '.vault-chat' / 'events'
    dest.mkdir(parents=True)
    for f in events.iterdir():
        if f.is_symlink():
            p.error('Refusing symlink in selected events')
        if f.is_file() and (f.suffix in ('.jsonl', '.json') or f.name in ('_seq', '_epoch')):
            shutil.copyfile(f, dest / f.name)
    note = vault / 'desktop-timing-note.md'
    note.write_text('# Private desktop timing note\n\nSelect this text for Ctrl+K.\n')
    # Explicit tiny home, no inherited credentials, live display, D-Bus, or service env.
    keep = ('PATH', 'LD_LIBRARY_PATH', 'LIBRARY_PATH', 'PKG_CONFIG_PATH', 'PKG_CONFIG_LIBDIR',
            'NIX_LDFLAGS', 'NIX_CFLAGS_COMPILE', 'NIX_CC', 'NIX_BINTOOLS', 'SSL_CERT_FILE',
            'FONTCONFIG_FILE', 'FONTCONFIG_PATH', 'XDG_DATA_DIRS')
    env = {k: os.environ[k] for k in keep if k in os.environ}
    home = work / 'server-home'
    home.mkdir()
    env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / 'config'), XDG_DATA_HOME=str(home / 'data'),
               XDG_CACHE_HOME=str(home / 'cache'), XDG_STATE_HOME=str(home / 'state'),
               TMPDIR=str(work), __ETC_PROFILE_DONE='1', GIT_CONFIG_GLOBAL='/dev/null',
               GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0', LANG='C.UTF-8')
    children = []
    servers = []
    result = {'schema': 1, 'platform': 'linux-webkitgtk', 'works': False,
              'input': 'XTest OS input on private Xvfb; no WebDriver input',
              'connection': 'owned compiled box server + frozen approved thread copy; not live 8848',
              'graphics': 'software rendering on private Xvfb',
              'timingNote': 'Double-rAF estimates straddle a rendering opportunity, not physical paint; absent Event Timing is unsupported, not zero',
              'laptopComparison': None, 'runs': {}}

    def spawn(args, name, childenv=env, **kw):
        log = open(work / (name + '.log'), 'wb')
        child = subprocess.Popen(args, env=childenv, stdout=log, stderr=subprocess.STDOUT,
                                 start_new_session=True, **kw)
        log.close()
        children.append(child)
        return child

    def build(args, name, childenv=env):
        child = spawn(args, name, childenv, cwd=ROOT)
        if child.wait() != 0:
            raise RuntimeError(name + ' failed; see private work directory')

    try:
        # Cargo's package version in older released lockfiles can lag package.json.
        # Preserve the tracked lock, including on a failed Linux build.
        if not a.app:
            build(['npm', 'run', 'predev:tauri'], 'tectonic-resource')
            build(['npm', 'run', 'build'], 'frontend-build')
            buildenv = dict(env, CARGO_HOME=str(work / 'cargo'), CARGO_TARGET_DIR=str(work / 'target'))
            lock = ROOT / 'src-tauri/Cargo.lock'
            original_lock = lock.read_bytes()
            try:
                build(['cargo', 'build', '--release', '--manifest-path', 'src-tauri/Cargo.toml',
                       '--features', 'tauri/custom-protocol'], 'native-build', buildenv)
            finally:
                lock.write_bytes(original_lock)
            a.app = work / 'target/release/vault-chat'
        a.app = a.app.resolve(strict=True)
        if a.before_app:
            a.before_app = a.before_app.resolve(strict=True)
        if not a.server_bundle:
            build(['npm', 'run', 'build:server'], 'server-build')
            a.server_bundle = ROOT / 'dist-server/vault-chat-server.mjs'
        a.server_bundle = a.server_bundle.resolve(strict=True)
        # Copying creates new inodes. Rebind ONLY inode metadata on our disposable
        # copy using the production reader; preserve the original picture/seq/offset.
        # This is not recovery/compaction and never touches the input or live logs.
        rebind = '''import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
          import {join} from 'node:path'; import {pathToFileURL} from 'node:url';
          const {position,validatePosition}=await import(pathToFileURL(process.argv[1]).href);
          const dir=process.argv[2];
          for(const name of readdirSync(dir).filter(n=>n.endsWith('.ckpt.json'))){
            const file=join(dir,name), c=JSON.parse(readFileSync(file,'utf8'));
            if(!c.position)continue;
            const log=join(dir,name.replace(/\\.ckpt\\.json$/,'.jsonl'));
            c.position=position(log,c.position.offset,c.seq);
            validatePosition(log,c.position,c.seq);
            writeFileSync(file,JSON.stringify(c)+'\\n');
          }'''
        build(['node', '--import', 'tsx', '--input-type=module', '-e', rebind,
               str(ROOT / 'server/convlog/reader.ts'), str(dest)], 'copy-inode-rebind')
        server_port = port()
        state = work / 'server-state'
        # Even OFF has an owned inert 503 voice endpoint; never falls back to 8857.
        class Inert(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(503); self.end_headers()
            do_POST = do_GET
            def log_message(self, *_):
                pass
        voice = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Inert)
        servers.append(voice)
        threading.Thread(target=voice.serve_forever, daemon=True).start()
        server_env = dict(env, VC_HOST='127.0.0.1', VC_PORT=str(server_port), VC_VAULT=str(vault),
                          VC_VAULT_NAME='vault-chat', VC_STATE_DIR=str(state), VC_SYNC='0', VC_ENGINE='0',
                          VC_SECRETS_DIR=str(home / 'empty-secrets'), VC_TOKEN_FILE=str(home / 'new-token'),
                          VC_LOCALSTORAGE=str(home / 'storage'), VC_PUSH_SUBS=str(home / 'push'),
                          VC_VOICE_PIPELINE='off', VC_VOICE_PIPELINE_PORT=str(voice.server_port))
        spawn(['node', str(a.server_bundle)], 'server', server_env)
        base = 'http://127.0.0.1:' + str(server_port)
        wait_for(lambda: request(base + '/api/v1/health'), 'owned genuine box server')
        checkpoint_path = '/api/v2/conversations/' + urllib.parse.quote(a.conversation, safe='') + '/checkpoint'
        checkpoint = request(base + checkpoint_path)
        picture = checkpoint.get('picture', checkpoint)
        items = picture.get('items', [])
        count = sum(i.get('kind') in ('user', 'assistant') for i in items)
        if picture.get('id') != a.conversation or count < a.min_messages:
            raise RuntimeError('Wrong/short original thread: expected minimum message count not met')
        result['thread'] = {'messages': count, 'items': len(items), 'exactOriginalSelected': False}
        observed = []
        opened = []
        lock = threading.Lock()

        class Relay(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.forward()
            def do_POST(self):
                self.forward()
            def forward(self):
                path = urllib.parse.urlsplit(self.path).path
                data = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                # No models, side threads, sends, voice, git, or copied history writes.
                if path.startswith('/git/') or self.command != 'GET' and path != '/api/v1/laptop-perf':
                    self.send_response(503); self.end_headers(); return
                conn = http.client.HTTPConnection('127.0.0.1', server_port, timeout=40)
                try:
                    conn.request(self.command, self.path, body=data, headers={'Content-Type': 'application/json'})
                    r = conn.getresponse()
                    body = r.read()
                    with lock:
                        if self.command == 'GET' and path == checkpoint_path and r.status == 200:
                            opened.append(True)
                        if path == '/api/v1/laptop-perf' and self.command == 'POST':
                            batch = json.loads(data)
                            # Original native metadata, never invented capability/identity headers.
                            observed.append((batch, r.status))
                    self.send_response(r.status)
                    self.send_header('Content-Type', r.getheader('Content-Type', 'application/json'))
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers(); self.wfile.write(body)
                except (OSError, ValueError):
                    with contextlib.suppress(OSError):
                        self.send_response(502); self.end_headers()
                finally:
                    conn.close()
            def log_message(self, *_):
                pass
        relay = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Relay)
        servers.append(relay)
        threading.Thread(target=relay.serve_forever, daemon=True).start()
        (vault / '.vault-chat/sync.json').write_text(json.dumps({'box': 'http://127.0.0.1:' + str(relay.server_port), 'vault': 'vault-chat'}))
        # Only our new socket; never use DISPLAY from the caller or scan live displays.
        readfd, writefd = os.pipe()
        xvfb = spawn(['Xvfb', '-displayfd', str(writefd), '-screen', '0', '1440x1000x24',
                      '-dpi', '96', '-nolisten', 'tcp', '-noreset'], 'xvfb', pass_fds=(writefd,))
        os.close(writefd)
        import select
        if not select.select([readfd], [], [], 20)[0]:
            raise RuntimeError('Private Xvfb did not start')
        display = ':' + os.read(readfd, 32).decode().strip()
        os.close(readfd)
        if xvfb.poll() is not None:
            raise RuntimeError('Private Xvfb exited')
        bus = subprocess.check_output(['dbus-daemon', '--session', '--fork', '--print-address=1', '--print-pid=1'], env=env, text=True).splitlines()
        buspid = int(bus[1])
        env.update(DISPLAY=display, DBUS_SESSION_BUS_ADDRESS=bus[0], GDK_BACKEND='x11',
                   TAURI_WEBVIEW_AUTOMATION='true', LIBGL_ALWAYS_SOFTWARE='1',
                   ALSOFT_DRIVERS='null', PULSE_SERVER='unix:/nonexistent-vc-desktop-audio')
        # All audio is routed to no devices (including accidental native media playback).
        alsa = work / 'alsa.conf'
        alsa.write_text('pcm.!default { type null }\nctl.!default { type null }\n')
        env['ALSA_CONFIG_PATH'] = str(alsa)
        spawn(['openbox'], 'window-manager')

        def exercise(app, label):
            profile = work / (label + '-home')
            profile.mkdir()
            childenv = dict(env, HOME=str(profile), XDG_CONFIG_HOME=str(profile / 'config'),
                            XDG_DATA_HOME=str(profile / 'data'), XDG_CACHE_HOME=str(profile / 'cache'),
                            XDG_STATE_HOME=str(profile / 'state'))
            wdport = port()
            spawn(['WebKitWebDriver', '--host=127.0.0.1', '--port=' + str(wdport)], label + '-webdriver', childenv)
            driver = 'http://127.0.0.1:' + str(wdport)
            wait_for(lambda: request(driver + '/status'), 'native WebKit driver')
            sid = None

            def session():
                nonlocal sid
                r = request(driver + '/session', {'capabilities': {'alwaysMatch': {
                    'webkitgtk:browserOptions': {'binary': str(app), 'args': []}}}})
                sid = r['value']['sessionId']

            def js(code, *args):
                r = request(driver + '/session/' + sid + '/execute/sync', {'script': code, 'args': list(args)})
                if isinstance(r.get('value'), dict) and 'error' in r['value']:
                    raise RuntimeError('Native DOM observation failed')
                return r['value']

            def delete_session():
                nonlocal sid
                if sid:
                    request(driver + '/session/' + sid, method='DELETE')
                    sid = None

            def key(chord):
                run('xdotool', 'key', '--clearmodifiers', chord, env=childenv, stdout=subprocess.DEVNULL)

            def click(selector):
                xy = js('const e=document.querySelector(arguments[0]);if(!e)return null;const r=e.getBoundingClientRect();for(const f of [.15,.5,.85]){const x=r.x+r.width*f,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(r.width&&r.height&&(hit===e||e.contains(hit)))return [(screenX+x)*devicePixelRatio,(screenY+y)*devicePixelRatio];}return null;', selector)
                if not xy:
                    raise RuntimeError('Native control not visible: ' + selector)
                # Native undecorated window; convert CSS coordinates to actual X pixels.
                run('xdotool', 'mousemove', str(round(xy[0])), str(round(xy[1])), 'click', '1', env=childenv, stdout=subprocess.DEVNULL)

            def exists(selector):
                return js('const e=document.querySelector(arguments[0]);if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&[.15,.5,.85].some(f=>{const hit=document.elementFromPoint(r.x+r.width*f,r.y+r.height/2);return hit===e||e.contains(hit);});', selector)

            try:
                # First launch only seeds a clean native profile; no tokens, no fake IPC.
                session()
                wait_for(lambda: js('return !!window.__TAURI_INTERNALS__;'), 'real Tauri IPC')
                js('localStorage.setItem("vault_chat_last_vault",arguments[0]); localStorage.setItem("vault_chat_active_conv",arguments[1]);', str(vault), a.conversation)
                delete_session()
                time.sleep(1)
                with lock:
                    start_batch = len(observed)
                    opened.clear()
                began = time.monotonic()
                session()
                wait_for(lambda: js('const e=document.querySelector(\'[data-perf-target="composer"]\');return !document.getElementById("vault-splash") && e && !e.disabled;'), 'native selected thread composer after splash')
                # WebDriver only observes; focus/position/mouse/keyboard are real OS input.
                windows = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--name', '^vault-chat$'], env=childenv, text=True).split()
                if len(windows) != 1:
                    raise RuntimeError('Expected exactly one owned native application window')
                run('xdotool', 'windowmove', windows[0], '0', '0', 'windowsize', windows[0], '1440', '1000', 'windowactivate', '--sync', windows[0], env=childenv, stdout=subprocess.DEVNULL)
                time.sleep(.3)
                if exists('button[title="Dismiss"]'):
                    click('button[title="Dismiss"]')
                if not exists('[data-perf-target="composer"]'):
                    key('ctrl+shift+b')
                    wait_for(lambda: exists('[data-perf-target="composer"]'), 'initial chat panel opens')
                selected = js('return localStorage.getItem("vault_chat_active_conv")===arguments[0];', a.conversation)
                if not selected or not opened:
                    raise RuntimeError('Native app did not load the specified original thread')
                launch_upper = (time.monotonic() - began) * 1000
                result['thread']['exactOriginalSelected'] = True
                # Observe NOTE on trusted native keyboard events. No values/keys/paths retained.
                js('''window.__desktopNoteSamples=[];
                    window.addEventListener('keydown',e=>{
                      if(!e.isTrusted || !(e.target instanceof HTMLTextAreaElement) ||
                         !e.target.placeholder.startsWith('What are you stuck on?'))return;
                      const t=e.timeStamp>=performance.timeOrigin?e.timeStamp-performance.timeOrigin:e.timeStamp;
                      requestAnimationFrame(()=>requestAnimationFrame(()=>{
                        window.__desktopNoteSamples.push(performance.now()-t);
                      }));
                    },true);''')
                text = 'desktop input timing'
                interaction_failures = []

                def type_and_assert(selector):
                    click(selector)
                    run('xdotool', 'type', '--clearmodifiers', '--delay', '80', text, env=childenv, stdout=subprocess.DEVNULL)
                    try:
                        wait_for(lambda: js('return document.activeElement===document.querySelector(arguments[0]) && document.activeElement.value===arguments[1];', selector, text), 'typed native input settles', seconds=5)
                    except RuntimeError:
                        diagnostic = js('const e=document.querySelector(arguments[0]);return {control:arguments[0],focused:document.activeElement===e,characters:e?.value.length,expectedCharacters:arguments[1]};', selector, len(text))
                        interaction_failures.append(diagnostic)

                type_and_assert('[data-perf-target="composer"]')
                key('ctrl+a'); key('BackSpace')
                for _ in range(3):
                    key('ctrl+shift+f')
                    wait_for(lambda: exists('[data-perf-view="fullscreen"]'), 'Ctrl+Shift+F enters fullscreen')
                    key('ctrl+shift+f')
                    wait_for(lambda: not exists('[data-perf-view="fullscreen"]'), 'Ctrl+Shift+F returns')
                key('ctrl+n')
                note_selector = 'textarea[placeholder^="What are you stuck on?"]'
                wait_for(lambda: exists(note_selector), 'new NOTE')
                type_and_assert(note_selector)
                time.sleep(.2)
                note_samples = js('return window.__desktopNoteSamples;')
                key('Escape')  # never saves/submits a model turn
                # Open only our private note from the real file tree.
                click('[data-tree-root] [data-tree-path$="/desktop-timing-note.md"]')
                wait_for(lambda: exists('[data-look-pane][data-file$="/desktop-timing-note.md"]'), 'real private note viewer')
                key('ctrl+e')
                wait_for(lambda: exists('.cm-content[contenteditable="true"]'), 'real private note editor')
                click('.cm-content[contenteditable="true"]')
                key('ctrl+Home'); key('ctrl+shift+End'); key('ctrl+k')
                wait_for(lambda: exists('[data-perf-target="ctrl-k"]'), 'Ctrl+K opens edit prompt')
                type_and_assert('[data-perf-target="ctrl-k"]')
                key('Escape')
                for _ in range(3):
                    key('ctrl+shift+b')
                    wait_for(lambda: not exists('[data-perf-target="composer"]'), 'chat panel closes')
                    key('ctrl+shift+b')
                    wait_for(lambda: exists('[data-perf-target="composer"]'), 'chat panel opens')
                time.sleep(3)
                with lock:
                    batches = observed[start_batch:]
                samples = collections.defaultdict(list)
                seen = set()
                metadata = None
                statuses = set()
                for b, status in batches:
                    if b.get('runtime') != 'webkitgtk' or b.get('surface') != 'tauri-production':
                        raise RuntimeError('Not a genuine production Linux Tauri measurement')
                    metadata = {k: b.get(k) for k in ('runtime', 'runtimeVersion', 'surface', 'version', 'revision', 'eventTiming', 'clockQuantumMs')}
                    statuses.add(status)
                    for s in b.get('samples', []):
                        identity = (b.get('session'), s['at'], s['metric'], s['method'])
                        if identity not in seen:
                            seen.add(identity)
                            samples[(s['metric'], s['method'])].append(s['durationMs'])
                if note_samples:
                    samples[('note-key', 'double-raf-estimate-from-trusted-event')] = note_samples
                required = {'launch-interactive', 'composer-key', 'note-key', 'fullscreen-transition', 'ctrl-k-key', 'file-open', 'chat-panel-open'}
                if required - {k[0] for k in samples}:
                    raise RuntimeError('Missing genuine native timing samples: ' + ', '.join(sorted(required - {k[0] for k in samples})))

                def stats(values):
                    v = sorted(values)
                    return {'n': len(v), 'p50Ms': round(v[len(v)//2], 3), 'p95Ms': round(v[min(len(v)-1, int(len(v)*.95))], 3), 'maxMs': round(max(v), 3)}
                return {'works': not interaction_failures, 'interactionFailures': interaction_failures, 'native': metadata, 'telemetryHttpStatuses': sorted(statuses),
                        'telemetryNote': 'Observed real Rust IPC batches; loopback is not authenticated Tailscale laptop telemetry',
                        'launchProcessToDomUpperBoundMs': round(launch_upper, 3),
                        'timings': [{'metric': m, 'method': method, **stats(values)} for (m, method), values in sorted(samples.items())]}
            except Exception:
                # One failure-only native screenshot for debugging, never per-key profiling.
                with contextlib.suppress(Exception):
                    import base64
                    shot = request(driver + '/session/' + sid + '/screenshot')['value']
                    (work / (label + '-failure.png')).write_bytes(base64.b64decode(shot))
                raise
            finally:
                with contextlib.suppress(Exception):
                    delete_session()

        if a.before_app:
            result['runs']['before'] = exercise(a.before_app, 'before')
        result['runs']['after'] = exercise(a.app, 'after')
        result['works'] = all(r['works'] for r in result['runs'].values())
    except Exception as e:
        # No raw driver response/DOM/credentials/text/path identifiers in telemetry.
        result['error'] = str(e) if isinstance(e, RuntimeError) else type(e).__name__
    finally:
        for child in reversed(children):
            if child.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGTERM)
        for child in reversed(children):
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGKILL)
        if 'buspid' in locals():
            with contextlib.suppress(ProcessLookupError):
                os.kill(buspid, signal.SIGTERM)
        for server in servers:
            server.server_close()
        a.out.parent.mkdir(parents=True, exist_ok=True)
        a.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    return 0 if result['works'] else 1


if __name__ == '__main__':
    sys.exit(main())
