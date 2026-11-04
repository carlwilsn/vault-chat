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
    p.add_argument('--check-plans', action='store_true', help='Exercise ordinary input and local Clear/reopen on the frozen original thread; inference stays blocked')
    p.add_argument('--check-empty-chat', action='store_true', help='Read the actual empty chat after local Clear/reopen; never generate an assistant answer')
    p.add_argument('--check-voice-only', action='store_true', help='Verify the one voice control and no Classic/engine selector in native settings; microphone stays off')
    p.add_argument('--voice-conflict', action='store_true', help='Hold an owned inert listener; prove real startup refusal and mic-OFF health UI')
    p.add_argument('--server-bundle', type=Path)
    p.add_argument('--out', type=Path, required=True, help='Plain result JSON outside the vault')
    p.add_argument('--work', type=Path, help='New private work directory; retained for ordinary build logs')
    p.add_argument('--nixpkgs', help='Optional local nixpkgs source for dependency provisioning')
    p.add_argument('--check-images', action='store_true', help='Paste owned PNG through the native clipboard; inspect outgoing bytes without inference')
    p.add_argument('--check-status-dot', action='store_true', help='Observe native pi running rows with a gated local zero-cost provider, then switch only the viewer vault')
    p.add_argument('--check-video', type=Path, help='Owned synthetic VP8/Vorbis clip; append two private media-only test entries, never publish them')
    p.add_argument('--inside-nix', action='store_true', help=argparse.SUPPRESS)
    a = p.parse_args()
    os.umask(0o077)
    if sys.platform != 'linux':
        p.error('This measures Linux/WebKitGTK only')
    if a.conversation != 'main' and not a.conversation.startswith('project-'):
        p.error('Use an original main/project thread (older read-only chats cannot measure composer input)')
    if a.check_voice_only and not a.voice_conflict:
        p.error('--check-voice-only requires --voice-conflict for genuine startup Health')
    if a.min_messages < 1:
        p.error('--min-messages must be positive')
    tools = ['Xvfb', 'xdotool', 'openbox', 'dbus-daemon', 'WebKitWebDriver', 'node', 'npm', 'flock']
    if a.check_images:
        tools.append('xclip')
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
        expr = 'with import <nixpkgs> {}; mkShell { packages = [ nodejs_22 rustc cargo pkg-config gcc gtk3 webkitgtk_4_1 libsoup_3 alsa-lib openssl librsvg libayatana-appindicator xorg-server xdotool xclip openbox dbus python3 util-linux ]; LD_LIBRARY_PATH = lib.makeLibraryPath [ libayatana-appindicator ]; }'
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
    master = work / 'master'
    vault = master / 'vaults/vault-chat' if a.check_status_dot else work / 'vault-chat'
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
        if a.check_video:
            fixture_dir = vault / 'video-fixtures'
            fixture_dir.mkdir()
            shutil.copyfile(a.check_video.resolve(strict=True), fixture_dir / 'synthetic.webm')
            (fixture_dir / 'unsupported.webm').write_bytes(b'Not a supported media container')
            prepare_video = r"""import {ConvLog} from './server/convlog/log.ts';
              import {newSessionFile,appendEntries} from './server/convlog/piSession.ts';
              import {writeFileSync} from 'node:fs';import {join} from 'node:path';
              const v=process.argv[1],id=process.argv[2],log=new ConvLog(v),before=log.picture(id);
              if(before.items.length!==3819 || before.items.filter(i=>['user','assistant'].includes(i.kind)).length!==1329)throw Error('Wrong approved history');
              writeFileSync(process.argv[3],JSON.stringify(before.items));
              const file=newSessionFile(join(v,'.vault-chat/events/sessions/video-fixture.jsonl'),v);
              for(const entry of appendEntries(file,[{type:'message',message:{role:'assistant',content:[{type:'text',text:'![local video fixture](video-fixtures/synthetic.webm)\n\n![unsupported local fixture](video-fixtures/unsupported.webm)'}],timestamp:Date.now()}}]))log.emit(id,{type:'entry',file,entry});
              log.checkpointNow(id);log.close();"""
            build(['node', '--import', 'tsx', '--input-type=module', '-e', prepare_video,
                   str(vault), a.conversation, str(work / 'original-video-prefix.json')], 'private-video-append')
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
                          VC_VOICE_PIPELINE='off', VC_VOICE_PORT=str(voice.server_port), VC_VOICE_PIPELINE_PORT=str(voice.server_port))
        if a.check_status_dot:
            # Only a local unpaid provider; no credentials or external inference.
            released = threading.Event()
            released.set()  # Let any original interrupted turn finish locally before measuring.
            provider_calls = []
            class LocalProvider(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    body = json.dumps({'data': [{'id': 'test/fake-model', 'context_length': 400000, 'architecture': {'input_modalities': ['text']}, 'pricing': {}}]}).encode()
                    self.send_response(200); self.end_headers(); self.wfile.write(body)
                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                    if not self.path.endswith('/chat/completions') or not body.get('stream'):
                        self.send_response(503); self.end_headers(); return
                    provider_calls.append(True)  # Never record original thread text.
                    if not released.wait(90):
                        self.send_response(503); self.end_headers(); return
                    self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                    for delta, reason in [({'role': 'assistant', 'content': 'Local status fixture complete.'}, None), ({}, 'stop')]:
                        chunk = {'id': 'local-status', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': body['model'], 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
                        self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                    self.wfile.write(b'data: [DONE]\n\n')
                def log_message(self, *_): pass
            provider = http.server.ThreadingHTTPServer(('127.0.0.1', 0), LocalProvider)
            servers.append(provider)
            threading.Thread(target=provider.serve_forever, daemon=True).start()
            provider_url = 'http://127.0.0.1:' + str(provider.server_port) + '/api/v1'
            network = work / 'local-network.mjs'
            network.write_text("const f=globalThis.fetch;globalThis.fetch=(i,o)=>{const u=new URL(typeof i==='string'?i:i instanceof URL?i.href:i.url);if(u.href==='https://openrouter.ai/api/v1/models')return f(" + json.dumps(provider_url + '/models') + ",o);if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))return f(i,o);throw Error('External fetch refused');};")
            server_env.update(VC_ENGINE='pi', VC_PI_DIR=os.environ['VC_TEST_PI_DIR'], VC_ENGINE_MODEL='test/fake-model',
                              VC_PI_UNSAFE='1', VC_BWRAP=str(work / 'absent-bwrap'), VC_MASTER=str(master),
                              VC_OPENROUTER_BASE=provider_url, NODE_OPTIONS='--import ' + str(network), PI_OFFLINE='1', PI_SKIP_VERSION_CHECK='1')
            viewer = master / 'vaults/status-viewer'
            (viewer / '.vault-chat').mkdir(parents=True)
        if a.voice_conflict:
            state.mkdir(parents=True, exist_ok=True)
            (state / 'voice-engine.json').write_text('{"engine":"classic"}' if a.check_voice_only else '{"engine":"new"}')
            server_env.update(VC_VOICE_PIPELINE='on', VC_VOICE_BRAIN='pi')
        spawn(['node', str(a.server_bundle)], 'server', server_env)
        base = 'http://127.0.0.1:' + str(server_port)
        wait_for(lambda: request(base + '/api/v1/health'), 'owned genuine box server')
        if a.check_status_dot:
            wait_for(lambda: request(base + '/api/v1/health').get('engine', {}).get('pi', {}).get('state') == 'up', 'real pinned pi boot')
            request(base + '/api/v1/vaults', {'name': 'status-viewer'})
            if not any(v['name'] == 'status-viewer' for v in request(base + '/api/v1/vaults')['vaults']):
                raise RuntimeError('Viewer fixture is not registered with the genuine server')
            agent = state / 'pi/agent'
            (agent / 'settings.json').write_text(json.dumps({'compaction': {'enabled': False}, 'retry': {'enabled': False}}))
            (agent / 'models.json').write_text(json.dumps({'providers': {'openrouter': {'baseUrl': provider_url, 'apiKey': 'synthetic-local-only', 'api': 'openai-completions', 'models': [{'id': 'test/fake-model', 'name': 'Local unpaid status fixture', 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 400000, 'maxTokens': 1000}]}}}))
            registered = request(base + '/projects', {'folder': str(vault)})
            if registered.get('convId') != a.conversation:
                raise RuntimeError('Original project slug not preserved in disposable registration')
        if a.voice_conflict:
            conflict_status = wait_for(lambda: (s if (s := request(base + '/api/v1/brain/engine')).get('failure') else None), 'actual startup conflict')
            if conflict_status['failure']['code'] != 'VOICE_PORT_CONFLICT' or conflict_status['failure']['port'] != voice.server_port or conflict_status['pipeline']:
                raise RuntimeError('Compiled backend did not report owned socket conflict')
            health = request(base + '/api/v1/health')
            if health.get('voice', {}).get('failure') != conflict_status['failure']:
                raise RuntimeError('Health lost the structured startup conflict')
            # The original listener must still answer after refusal. It is intentionally not voice.
            try:
                request('http://127.0.0.1:' + str(voice.server_port) + '/health')
            except urllib.error.HTTPError as e:
                if e.code != 503:
                    raise RuntimeError('Original inert listener was disturbed')
            result['voiceConflict'] = {'socketRefused': True, 'originalListenerStillResponds503': True, 'healthCode': conflict_status['failure']['code']}
        checkpoint_path = '/api/v2/conversations/' + urllib.parse.quote(a.conversation, safe='') + '/checkpoint'
        checkpoint = request(base + checkpoint_path)
        picture = checkpoint.get('picture', checkpoint)
        items = picture.get('items', [])
        count = sum(i.get('kind') in ('user', 'assistant') for i in items)
        if picture.get('id') != a.conversation or count < a.min_messages:
            raise RuntimeError('Wrong/short original thread: expected minimum message count not met')
        result['thread'] = {'messages': count, 'items': len(items), 'exactOriginalSelected': False}
        if a.check_video:
            prefix = json.loads((work / 'original-video-prefix.json').read_text())
            if items[:len(prefix)] != prefix or len(items) != len(prefix) + 1:
                raise RuntimeError('Private media append changed the original history prefix')
            result['thread']['originalPrefix'] = {'messages': 1329, 'items': 3819, 'unchanged': True, 'privateAppendedItems': 1}

        observed = []
        photo_intents = []
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
                if a.check_images and path == '/api/v2/intent' and self.command == 'POST':
                    with lock:
                        photo_intents.append(json.loads(data))
                # No models, side threads, sends, voice, git, or copied history writes.
                if path.startswith('/git/') or self.command != 'GET' and path != '/api/v1/laptop-perf':
                    if a.check_plans and path == '/api/v2/intent':
                        # Observe the native pending-input UI before rejecting;
                        # never forward this turn to a provider or invent a reply.
                        time.sleep(2)
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
        if a.check_status_dot:
            (viewer / '.vault-chat/sync.json').write_text(json.dumps({'box': 'http://127.0.0.1:' + str(relay.server_port), 'vault': 'status-viewer'}))
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
                # Let the empty profile finish its own initialization before
                # seeding preferences; otherwise startup can overwrite the thread
                # selection between this write and the measured second launch.
                wait_for(lambda: js('return document.readyState === "complete" && !document.getElementById("vault-splash");'), 'empty native profile initialized')
                js('localStorage.setItem("vault_chat_last_vault",arguments[0]); localStorage.setItem("vault_chat_active_conv",arguments[1]);', str(vault), a.conversation)
                if a.check_status_dot:
                    js('localStorage.setItem("vault_chat_master_path",arguments[0]);', str(master))
                # WebKit persists localStorage asynchronously; let the seeded clean
                # profile reach disk before the driver tears its process down.
                time.sleep(1)
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
                def sample_delivered(metric):
                    with lock:
                        return any(s.get('metric') == metric
                                   for b, _ in observed[start_batch:]
                                   for s in b.get('samples', []))
                # Fast current UI can produce a full queue before the first flush.
                wait_for(lambda: sample_delivered('launch-interactive'), 'native launch telemetry delivery')
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
                # Loopback telemetry is deliberately rejected, so its bounded retry
                # queue can evict this single sample during the next typing burst.
                # Observe its real IPC delivery before producing more samples.
                wait_for(lambda: sample_delivered('file-open'), 'native file-open telemetry delivery')
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
                plan_lifecycle = None
                empty_chat = None
                if a.check_plans or a.check_empty_chat:
                    def plans_on_screen():
                        return js('''const cards=[...document.querySelectorAll('[data-el="todos"],[data-el="todos-done"]')];
                          return {mounted:cards.length, visible:cards.filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight;}).length,
                            oldFourRowPlan:cards.filter(e=>e.textContent.includes('Fix conversation-owned Ctrl+K routing') && e.textContent.includes('Delete shipping UI and notifications')).length};''')
                    initial_plans = plans_on_screen()
                    after_input = initial_plans
                    if a.check_plans:
                        # No fabricated assistant reply: an actual OS-entered question
                        # is rejected by the read-safe relay before any provider call.
                        click('[data-perf-target="composer"]')
                        run('xdotool', 'type', '--clearmodifiers', '--delay', '80', 'where do asks stand', env=childenv, stdout=subprocess.DEVNULL)
                        key('Return')
                        wait_for(lambda: js("return document.querySelector('[data-perf-target=\"composer\"]')?.value === '';"), 'ordinary question submitted to blocked relay')
                        time.sleep(.3)
                        after_input = plans_on_screen()
                        time.sleep(2)  # the deliberately blocked send settles before Clear
                        result['runs'][label] = {'planLifecycle': {'initial': initial_plans, 'afterOrdinaryInput': after_input}}
                    # The unreachable-reason footer can crowd a narrow split
                    # after the deliberate 503. Open the real full chat first.
                    key('ctrl+shift+f')
                    wait_for(lambda: exists('[data-perf-view="fullscreen"]'), 'full chat for local Clear')
                    clear_selector = '[data-el="clear-thread"],button[title^="Clear this view"]'
                    wait_for(lambda: exists(clear_selector) and js('return !document.querySelector(arguments[0]).disabled;', clear_selector), 'local Clear control reachable', seconds=10)
                    click(clear_selector)
                    time.sleep(.5)
                    after_clear = plans_on_screen()
                    def empty_state():
                        return js('''const e=document.querySelector('[data-el="greeting"]');
                          return {automaticGreeting:e?.textContent?.trim()||'',
                            composerReady:!!document.querySelector('[data-perf-target="composer"]:not(:disabled)')};''')
                    cleared_empty = empty_state()
                    # A real native process reconnect, not injected app state.
                    delete_session()
                    time.sleep(1)
                    session()
                    wait_for(lambda: js("return !document.getElementById('vault-splash') && !!document.querySelector('[data-perf-target=\"composer\"]');"), 'native reopened after local Clear')
                    windows = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--name', '^vault-chat$'], env=childenv, text=True).split()
                    if len(windows) != 1:
                        raise RuntimeError('Expected exactly one owned reopened native application window')
                    run('xdotool', 'windowmove', windows[0], '0', '0', 'windowsize', windows[0], '1440', '1000', 'windowactivate', '--sync', windows[0], env=childenv, stdout=subprocess.DEVNULL)
                    time.sleep(1)
                    after_reopen = plans_on_screen()
                    if a.check_empty_chat:
                        empty_chat = {'afterClear': cleared_empty, 'afterNativeReopen': empty_state()}
                        if label != 'before' and any(x['automaticGreeting'] or not x['composerReady'] for x in empty_chat.values()):
                            raise RuntimeError('Automatic greeting present or composer unavailable in empty native chat')
                    plan_lifecycle = {'initial': initial_plans, 'afterOrdinaryInput': after_input,
                                      'afterClear': after_clear, 'afterNativeReopen': after_reopen,
                                      'inference': 'blocked 503 after 2s observing native pending input; no assistant reply or synthetic TodoWrite' if a.check_plans else 'no inference request',
                                      'history': 'original server conversation unchanged; Clear is local only'}
                    if label != 'before' and (after_clear['mounted'] or after_reopen['mounted'] or after_input['oldFourRowPlan']):
                        raise RuntimeError('Stale plan resurrected after ordinary input, local Clear or native reopen')
                if a.check_voice_only:
                    if not exists('[data-perf-view="fullscreen"]'):
                        key('ctrl+shift+f')
                        wait_for(lambda: exists('[data-perf-view="fullscreen"]'), 'full chat single voice control')
                    voice_controls = js('''return {oneComposerVoiceButton:document.querySelectorAll('button[title="Voice (Ctrl+D)"]').length===1,
                        microphoneOff:!document.querySelector('[data-el=voice-waves-mute]')};''')
                if a.voice_conflict or a.check_voice_only:
                    # Settings lives in the ordinary app toolbar, not FullscreenChat.
                    if exists('[data-perf-view="fullscreen"]'):
                        key('ctrl+shift+f')
                        wait_for(lambda: not exists('[data-perf-view="fullscreen"]'), 'ordinary toolbar for mic-OFF Health')
                    click('button[title="Settings"]')
                    # The health control lives in ordinary Voice settings, reachable without opening the mic.
                    wait_for(lambda: js('return !!document.querySelector("[data-el=voice-health-open]");'), 'voice settings status')
                    for _ in range(12):
                        if exists('[data-el="voice-health-open"]'):
                            break
                        run('xdotool', 'mousemove', '1300', '700', 'click', '5', env=childenv, stdout=subprocess.DEVNULL)
                        time.sleep(.15)
                    if a.check_voice_only:
                        voice_only = js('''return {noClassic:!document.body.innerText.includes('Classic'),
                            noEngineSelector:!document.querySelector('[data-el=voice-engine]'),
                            healthAvailable:!!document.querySelector('[data-el=voice-health-open]')};''')
                        voice_only.update(voice_controls)
                        voice_only['legacyChoiceUntouched'] = (state / 'voice-engine.json').read_text() == '{"engine":"classic"}'
                        if not all(voice_only.values()):
                            raise RuntimeError('Native settings still offer Classic or lost mic-OFF Health')
                        result['voiceOnly'] = voice_only
                    click('[data-el="voice-health-open"]')
                    health_ui = wait_for(lambda: js('''const d=document.querySelector('[role="dialog"][aria-label="Voice health"]');
                        if(!d)return null;return {microphoneOff:d.textContent.includes('Microphone off'),
                        codeVisible:d.textContent.includes('VOICE_PORT_CONFLICT'),
                        exactServerError:d.querySelector('[data-el="voice-health-status"]')?.textContent===arguments[0],
                        ordinaryVoiceError:document.querySelector('[data-el="voice-startup-error"]')?.textContent===arguments[0]};''', conflict_status['error']), 'native Health dialog')
                    if not all(health_ui.values()):
                        raise RuntimeError('Native mic-OFF health/normal Voice UI lost the genuine startup failure')
                    result['voiceConflict']['nativeMicOffUI'] = health_ui
                    click('[data-el="voice-health-close"]')
                    click('button[title="Settings"]')
                video_check = None
                if a.check_video:
                    if not exists('[data-perf-view="fullscreen"]'):
                        key('ctrl+shift+f')
                        wait_for(lambda: exists('[data-perf-view="fullscreen"]'), 'full chat for native media controls')
                    selector = 'video[title="local video fixture"]'
                    wait_for(lambda: js('const v=document.querySelector(arguments[0]);return v?.readyState>=2 && v.videoWidth===320;', selector), 'actual native video metadata and decoded initial frame')
                    # Instrument decoded audio before a ZERO gain output. No DOM play,
                    # pause, seek, focus or source mutation: all control input is XTest.
                    js(r"""const v=document.querySelector(arguments[0]);
                      window.__videoRms=0;window.__videoFrames=0;
                      document.addEventListener('pointerdown',function start(e){
                        if(!e.isTrusted)return;
                        const c=new AudioContext(),source=c.createMediaElementSource(v),a=c.createAnalyser(),g=c.createGain();
                        g.gain.value=0;source.connect(a);a.connect(g);g.connect(c.destination);c.resume();
                        window.__videoAudio=c;const b=new Float32Array(a.fftSize);
                        setInterval(()=>{a.getFloatTimeDomainData(b);window.__videoRms=Math.max(window.__videoRms,Math.sqrt(b.reduce((s,x)=>s+x*x,0)/b.length));},30);
                      },{once:true,capture:true});
                      if(v.requestVideoFrameCallback){const f=()=>{window.__videoFrames++;v.requestVideoFrameCallback(f);};v.requestVideoFrameCallback(f);}
                      return true;""", selector)
                    def video_state():
                        return js(r"""const v=document.querySelector(arguments[0]),c=document.createElement('canvas');c.width=16;c.height=9;
                          const x=c.getContext('2d');x.drawImage(v,0,0,16,9);const d=x.getImageData(0,0,16,9).data;
                          return {time:v.currentTime,duration:v.duration,paused:v.paused,muted:v.muted,autoplay:v.autoplay,
                            width:v.videoWidth,height:v.videoHeight,error:v.error?.code||null,
                            frames:v.getVideoPlaybackQuality?.().totalVideoFrames||v.webkitDecodedFrameCount||window.__videoFrames,
                            hash:d.reduce((s,x,i)=>(s+x*(i+1))%1000000007,0),rms:window.__videoRms,
                            audioState:window.__videoAudio?.state||null};""", selector)
                    initial = video_state()
                    if initial['muted'] or initial['autoplay'] or not initial['paused']:
                        raise RuntimeError('Native video is force-muted or autoplaying before user input')
                    def video_point(fraction, bottom):
                        xy=js('const r=document.querySelector(arguments[0]).getBoundingClientRect();return [(screenX+r.x+r.width*arguments[1])*devicePixelRatio,(screenY+r.bottom-arguments[2])*devicePixelRatio];', selector, fraction, bottom)
                        run('xdotool','mousemove',str(round(xy[0])),str(round(xy[1])),'click','1',env=childenv,stdout=subprocess.DEVNULL)
                    # Standard native UA controls, never a fabricated page button.
                    video_point(.06, 16)
                    wait_for(lambda: not video_state()['paused'] and video_state()['time']>.25, 'native Play gesture starts media')
                    first=video_state();time.sleep(1);playing=video_state()
                    if playing['frames']<=first['frames'] or playing['hash']==first['hash'] or playing['rms']<.01:
                        raise RuntimeError('Native video frames or actual pre-output audio samples did not decode')
                    video_point(.06,16)
                    wait_for(lambda: video_state()['paused'], 'native Pause gesture')
                    paused=video_state();time.sleep(.25)
                    if abs(video_state()['time']-paused['time'])>.1: raise RuntimeError('Native Pause did not hold')
                    video_point(.6,38)
                    wait_for(lambda: abs(video_state()['time']-paused['time'])>1, 'native timeline Seek gesture')
                    seeked=video_state()
                    bad=js('const v=document.querySelector(\'video[title="unsupported local fixture"]\');const a=v?.parentElement.querySelector(\'[data-el="video-fallback"]\');return {code:v?.error?.code||null,download:!!a?.hasAttribute("download"),link:!!a?.getAttribute("href")};')
                    if bad['code'] not in (3,4) or not bad['download'] or not bad['link']:
                        raise RuntimeError('Unsupported native format has no honest download fallback')
                    video_check={'initial':initial,'playing':playing,'paused':paused,'seeked':seeked,'unsupported':bad,
                      'audioOutput':'AudioContext analyser -> gain=0; ALSA null/Pulse nonexistent; no speakers',
                      'input':'native UA controls via XTest; no play/pause/currentTime injection'}
                image_check = None
                if a.check_images:
                    if not exists('[data-perf-target="composer"]'):
                        key('ctrl+shift+f')
                        wait_for(lambda: exists('[data-perf-target="composer"]'), 'native image composer visible')
                    # Owned nonsensitive PNG, not a fabricated conversation.
                    # The native clipboard and paste shortcut use private XTest input.
                    import base64, struct, zlib
                    def chunk(t, d):
                        return struct.pack('!I', len(d)) + t + d + struct.pack('!I', zlib.crc32(t + d))
                    pixels = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 32, 32, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\0' + b'\x24\x70\xc0' * 32) * 32)) + chunk(b'IEND', b'')
                    fixture = work / 'owned-photo.png'
                    fixture.write_bytes(pixels)
                    js('''window.__imagePaste=[];window.addEventListener('paste',e=>window.__imagePaste.push({trusted:e.isTrusted,target:e.target.tagName,htmlLength:e.clipboardData.getData('text/html').length,types:[...e.clipboardData.types],items:[...e.clipboardData.items].map(i=>({kind:i.kind,type:i.type,size:i.getAsFile()?.size}))}),true);''')
                    clipboard = work / 'owned-photo-clipboard.html'
                    clipboard.write_text('<img src="data:image/png;base64,' + base64.b64encode(pixels).decode() + '">')
                    producer = spawn(['xclip', '-selection', 'clipboard', '-target', 'text/html',
                                      '-i', str(clipboard), '-quiet'], 'image-clipboard', childenv)
                    # Popen only starts the producer: it does not establish X11 selection
                    # ownership. Never paste until the private server advertises our
                    # target AND serves our exact bytes, with the producer still alive.
                    def owned_clipboard():
                        if producer.poll() is not None:
                            raise RuntimeError('Owned clipboard producer exited before paste')
                        targets = subprocess.run(['xclip', '-selection', 'clipboard', '-out', '-target', 'TARGETS'],
                                                 env=childenv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
                        if targets.returncode or b'text/html' not in targets.stdout.splitlines():
                            return False
                        content = subprocess.run(['xclip', '-selection', 'clipboard', '-out', '-target', 'text/html'],
                                                 env=childenv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
                        return content.returncode == 0 and content.stdout == clipboard.read_bytes()
                    wait_for(owned_clipboard, 'private clipboard target and exact owned HTML bytes', seconds=10)
                    result['clipboardProducer'] = {'aliveBeforePaste': producer.poll() is None,
                                                   'advertisedHtml': True, 'exactHtmlBytes': True}
                    click('[data-perf-target="composer"]')
                    key('ctrl+v')
                    expected = 'data:image/png;base64,' + base64.b64encode(pixels).decode()
                    wait_for(lambda: js('return [...document.images].some(i=>{const r=i.getBoundingClientRect();return i.src===arguments[0] && i.complete && i.naturalWidth===32 && i.naturalHeight===32 && r.width>0 && r.height>0 && r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===i;});', expected), 'native pasted image decodes with exact source bytes')
                    native_paste = js('return window.__imagePaste;')
                    if not any(e.get('trusted') and e.get('target') == 'TEXTAREA' and
                               'text/html' in e.get('types', []) and e.get('htmlLength', 0) > 0
                               for e in native_paste):
                        raise RuntimeError('Image appeared without a trusted native HTML paste')
                    time.sleep(1)  # let the decoded visible native thumbnail render before the existing screenshot
                    shot = request(driver + '/session/' + sid + '/screenshot')['value']
                    (work / (label + '-image.png')).write_bytes(base64.b64decode(shot))
                    key('Return')
                    wait_for(lambda: any(b.get('images') for b in photo_intents), 'native photo upload intent')
                    image_check = {'nativePastedImageDecoded': True, 'trustedNativePaste': native_paste,
                                   'producerAliveAfterPaste': producer.poll() is None,
                                   'clipboardFormat': 'text/html with inline PNG pixels (not bitmap clipboard)', 'outgoingBytesAndMime': any(i.get('mime') == 'image/png' and i.get('dataBase64') == expected.split(',', 1)[1] for b in photo_intents for i in b.get('images', [])),
                                   'inference': 'relay blocks intent 503; genuine Pi/provider byte check is a separate unpaid server test'}
                    if not image_check['outgoingBytesAndMime']:
                        raise RuntimeError('Native preview appeared but outgoing image bytes were missing')
                time.sleep(3)
                with lock:
                    batches = observed[start_batch:]
                samples = collections.defaultdict(list)
                seen = set()
                metadata = None
                status_dot = None
                if a.check_status_dot and label == 'after':
                    key('ctrl+shift+f')
                    wait_for(lambda: exists('[data-el="chats-sidebar"]'), 'real Main/project rows')
                    project_row = '[data-thread="' + a.conversation + '"]'
                    def geometry(thread):
                        return js('''const row=document.querySelector('[data-thread="'+arguments[0]+'"]'),dot=row?.querySelector('[title="Working…"]');if(!row||!dot)return null;
                          const r=row.getBoundingClientRect(),d=dot.getBoundingClientRect(),name=row.querySelector('button > span').getBoundingClientRect();
                          const actions=[...row.querySelectorAll('[data-el="project-notes"],[data-el="project-menu"]')].map(e=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,width:b.width,height:b.height};});
                          return {rem:parseFloat(getComputedStyle(document.documentElement).fontSize),rightGap:r.right-d.right,centerError:Math.abs((d.top+d.bottom-r.top-r.bottom)/2),dotLeft:d.left,dotRight:d.right,dotWidth:d.width,nameRight:name.right,white:getComputedStyle(dot.lastElementChild).backgroundColor,actions};''', thread)
                    dot_rows = []
                    for thread in ['main', a.conversation]:
                        released.clear()
                        request(base + '/api/v2/intent', {'type': 'send', 'convId': thread, 'client': 'laptop', 'clientId': 'local-status-' + thread, 'text': 'LOCAL-UNPAID-STATUS-DOT'})
                        try:
                            g = wait_for(lambda: geometry(thread), 'event-derived running dot')
                            if abs(g['rightGap'] - g['rem']) > 1 or g['centerError'] > 1 or g['nameRight'] >= g['dotLeft'] or any(b['right'] >= g['dotLeft'] or b['width'] < 28 or b['height'] < 28 for b in g['actions']):
                                raise RuntimeError('Running dot overlaps text/actions or misses fixed trailing gutter')
                            # Switch the focused conversation, not the turn owner.
                            other = a.conversation if thread == 'main' else 'main'
                            click('[data-thread="' + other + '"] > button')
                            wait_for(lambda: js('return localStorage.getItem("vault_chat_active_conv")===arguments[0];', other), 'different focused thread')
                            wait_for(lambda: geometry(thread), 'unfocused owner remains running')
                            key('ctrl+shift+f')
                            wait_for(lambda: exists('[data-el="vault-picker"]'), 'ordinary vault picker')
                            click('[data-el="vault-picker"]')
                            wait_for(lambda: exists('[data-el="vault-picker-item"][data-rel="vaults/status-viewer"] button'), 'viewer vault listed')
                            picker_rows = js('return [...document.querySelectorAll("[data-el=vault-picker-item]")].map(e=>e.dataset.rel);')
                            if sorted(picker_rows) != ['vaults/status-viewer', 'vaults/vault-chat']:
                                raise RuntimeError('Picker contains project ownership/non-vault rows')
                            click('[data-el="vault-picker-item"][data-rel="vaults/status-viewer"] button')
                            wait_for(lambda: js('return localStorage.getItem("vault_chat_last_vault")===arguments[0];', str(viewer)), 'real viewer vault switch')
                            if js('return localStorage.getItem("vault_chat_active_conv");') != other:
                                raise RuntimeError('Vault switch changed focused conversation')
                            key('ctrl+shift+f')
                            wait_for(lambda: geometry(thread), 'owner dot survives vault switch')
                            dot_rows.append({'thread': thread, 'geometry': g, 'unfocusedAndViewerIndependent': True})
                        finally:
                            released.set()
                        wait_for(lambda: not geometry(thread), 'native pi running to idle')
                        if thread == 'main':
                            key('ctrl+shift+f')
                            click('[data-el="vault-picker"]')
                            wait_for(lambda: exists('[data-el="vault-picker-item"][data-rel="vaults/vault-chat"] button'), 'original viewer vault')
                            click('[data-el="vault-picker-item"][data-rel="vaults/vault-chat"] button')
                            key('ctrl+shift+f')
                            wait_for(lambda: exists(project_row), 'project rows after restoring viewer')
                    after_items = request(base + checkpoint_path).get('picture', {}).get('items', [])
                    if after_items[:len(items)] != items:
                        raise RuntimeError('Status fixture altered original history prefix')
                    status_dot = {'rows': dot_rows, 'localProviderCalls': len(provider_calls), 'originalHistoryPrefixUnchanged': True, 'runningToIdle': True}
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
                return {'works': not interaction_failures, 'videoCheck': video_check, 'imageCheck': image_check, 'statusDot': status_dot, 'interactionFailures': interaction_failures, 'planLifecycle': plan_lifecycle, 'emptyChat': empty_chat, 'native': metadata, 'telemetryHttpStatuses': sorted(statuses),
                        'telemetryNote': 'Observed real Rust IPC batches; loopback is not authenticated Tailscale laptop telemetry',
                        'launchProcessToDomUpperBoundMs': round(launch_upper, 3),
                        'timings': [{'metric': m, 'method': method, **stats(values)} for (m, method), values in sorted(samples.items())]}
            except Exception:
                with contextlib.suppress(Exception):
                    result['nativeFailureDom'] = js('''return {
                      attachError:document.querySelector('[data-el="attach-error"]')?.textContent,paste:window.__imagePaste,active:document.activeElement?.tagName,images:[...document.images].map(i=>({w:i.naturalWidth,h:i.naturalHeight,scheme:i.src.split(':')[0],len:i.src.length})),
                      splash:!!document.getElementById('vault-splash'),
                      composer:!!document.querySelector('[data-perf-target="composer"]'),
                      composerDisabled:document.querySelector('[data-perf-target="composer"]')?.disabled,
                      exactThread:localStorage.getItem('vault_chat_active_conv')===arguments[0],
                      clearButtons:[...document.querySelectorAll('button')].filter(e=>e.textContent.trim()==='Clear').map(e=>{
                        const r=e.getBoundingClientRect();return {el:e.dataset.el,title:e.title,disabled:e.disabled,x:r.x,y:r.y,w:r.width,h:r.height};})};''', a.conversation)
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
        if a.check_plans or a.check_images or a.check_empty_chat or a.check_video:
            again = request(base + checkpoint_path)
            again = again.get('picture', again)
            preserved = again.get('items', []) == items
            result['thread']['originalItemsUnchangedAfterClear'] = preserved
            if not preserved:
                raise RuntimeError('Local Clear changed the original conversation items')
        if a.check_video:
            # Same compiled backend and same original 3819-item prefix as native.
            phone_script = r"""
              import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';
              const {chromium}=await import(process.argv[1]);const base=process.argv[2],conv=process.argv[3];
              const b=await chromium.launch({executablePath:'/run/current-system/sw/bin/chromium',headless:true,args:['--mute-audio','--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync']});
              const results={surface:'production compiled phone',osAudio:'Chromium --mute-audio AND analyser -> gain=0',ranges:[],permissions:0,mic:0,subscribe:0};
              try {
                const c=await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,permissions:[]});
                await c.addInitScript(()=>{
                  window.__calls={permissions:0,mic:0,subscribe:0};
                  Notification.requestPermission=()=>{__calls.permissions++;throw Error('OS permissions forbidden');};
                  PushManager.prototype.subscribe=()=>{__calls.subscribe++;throw Error('Push forbidden');};
                  navigator.mediaDevices.getUserMedia=()=>{__calls.mic++;throw Error('Mic forbidden');};
                });
                const p=await c.newPage();
                await p.route('**/*',r=>{const u=new URL(r.request().url());return u.origin===base && (r.request().method()==='GET'||u.pathname==='/api/v1/attention')?r.continue():r.abort();});
                p.on('response',async r=>{if(new URL(r.url()).pathname==='/file' && r.request().headers().range && new URL(r.url()).searchParams.get('path')==='video-fixtures/synthetic.webm')results.ranges.push({status:r.status(),range:r.headers()['content-range']||null,mime:r.headers()['content-type']});});
                const begin=Date.now();await p.goto(base+'/phone?conv='+encodeURIComponent(conv));
                const v=p.locator('video[title="local video fixture"]');await v.waitFor();
                await p.waitForFunction(()=>document.querySelector('video[title="local video fixture"]')?.readyState>=2);
                results.readyMs=Date.now()-begin;
                await v.evaluate(v=>{
                  window.__rms=0;window.__frames=0;
                  document.addEventListener('pointerdown',function(e){if(!e.isTrusted)return;
                    const c=new AudioContext(),s=c.createMediaElementSource(v),a=c.createAnalyser(),g=c.createGain();g.gain.value=0;
                    s.connect(a);a.connect(g);g.connect(c.destination);c.resume();window.__audio=c;
                    const b=new Float32Array(a.fftSize);setInterval(()=>{a.getFloatTimeDomainData(b);window.__rms=Math.max(__rms,Math.sqrt(b.reduce((s,x)=>s+x*x,0)/b.length));},30);
                  },{once:true,capture:true});
                  if(v.requestVideoFrameCallback){const f=()=>{__frames++;v.requestVideoFrameCallback(f);};v.requestVideoFrameCallback(f);}
                });
                const state=()=>v.evaluate(v=>{const c=document.createElement('canvas');c.width=16;c.height=9;const x=c.getContext('2d');x.drawImage(v,0,0,16,9);const d=x.getImageData(0,0,16,9).data;return {time:v.currentTime,duration:v.duration,paused:v.paused,muted:v.muted,autoplay:v.autoplay,width:v.videoWidth,height:v.videoHeight,error:v.error?.code||null,frames:v.getVideoPlaybackQuality().totalVideoFrames,hash:d.reduce((s,x,i)=>(s+x*(i+1))%1000000007,0),rms:__rms,audioState:__audio?.state||null};});
                results.initial=await state();assert(results.initial.paused&&!results.initial.muted&&!results.initial.autoplay);
                // Read native UA shadow geometry; all input is actual mouse/touch.
                const cdp=await c.newCDPSession(p);await cdp.send('DOM.enable');
                async function control(pseudo,f=.5){
                  const doc=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});const nodes=[];
                  function walk(n){if(n.attributes?.includes(pseudo))nodes.push(n);for(const x of [...(n.children||[]),...(n.shadowRoots||[])])walk(x);}walk(doc.root);
                  const box=await v.boundingBox();
                  for(const n of nodes){try{const {model}=await cdp.send('DOM.getBoxModel',{backendNodeId:n.backendNodeId});const q=model.content,x=q[0]+(q[2]-q[0])*f,y=(q[1]+q[5])/2;
                    if(x>=box.x&&x<=box.x+box.width&&y>=box.y&&y<=box.y+box.height&&y>0&&y<844){await p.mouse.click(x,y);return;}
                  }catch{}}
                  throw Error('Native UA control not visible: '+pseudo);
                }
                // Scroll with real wheel input if a control is below the viewport.
                let box=await v.boundingBox();if(box.y+box.height>740){await p.mouse.move(190,450);await p.mouse.wheel(0,box.y+box.height-700);await p.waitForTimeout(200);}
                await control('-webkit-media-controls-play-button');
                await p.waitForFunction(()=>{const v=document.querySelector('video[title="local video fixture"]');return !v.paused&&v.currentTime>.25;});
                const first=await state();await p.waitForTimeout(1000);results.playing=await state();
                assert(results.playing.frames>first.frames&&results.playing.hash!==first.hash&&results.playing.rms>.01,'Phone must actually decode advancing picture AND audio samples');
                await control('-webkit-media-controls-play-button');await p.waitForFunction(()=>document.querySelector('video[title="local video fixture"]').paused);
                results.paused=await state();await p.waitForTimeout(250);assert(Math.abs((await state()).time-results.paused.time)<.1);
                await control('-webkit-media-controls-timeline',.6);await p.waitForFunction(t=>Math.abs(document.querySelector('video[title="local video fixture"]').currentTime-t)>1,results.paused.time);
                results.seeked=await state();await control('-webkit-media-controls-play-button');await p.waitForTimeout(300);results.resumed=await state();assert(!results.resumed.paused&&results.resumed.time>results.seeked.time);
                results.unsupported=await p.locator('video[title="unsupported local fixture"]').evaluate(v=>({code:v.error?.code||null,download:!!v.parentElement.querySelector('[data-el="video-fallback"][download]')}));
                assert([3,4].includes(results.unsupported.code)&&results.unsupported.download);
                Object.assign(results,await p.evaluate(()=>__calls));assert(!results.permissions&&!results.mic&&!results.subscribe);
                assert(results.ranges.some(r=>r.status===206&&r.mime==='video/webm'));
                const q=new URLSearchParams({path:'video-fixtures/synthetic.webm',convId:conv});const r=await fetch(base+'/file?'+q,{headers:{range:'bytes=100-199'}});assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,100);
                results.works=true;
              } catch(e){results.works=false;results.error=String(e);} finally {await b.close();writeFileSync(process.argv[4],JSON.stringify(results,null,2));}
              if(!results.works)process.exitCode=1;
            """
            phone_file = work / 'phone-video.json'
            # Playwright is existing test tooling, never a fake UI/backend or a new dependency.
            pw = os.environ.get('VC_PLAYWRIGHT', '/tmp/global-workspace-ui-09ed10ad-r1/source/preview/node_modules/playwright-core/index.mjs')
            child = spawn(['node', '--input-type=module', '-e', phone_script, pw, base, a.conversation, str(phone_file)], 'phone-video')
            child.wait(timeout=120)
            if phone_file.exists():
                result['phoneVideo'] = json.loads(phone_file.read_text())
            if child.returncode:
                raise RuntimeError('Production phone video check failed; see retained scalar metrics')
        result['works'] = all(r['works'] for r in result['runs'].values())
        if a.check_video:
            result['works'] = result['works'] and result.get('phoneVideo', {}).get('works', False)
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
