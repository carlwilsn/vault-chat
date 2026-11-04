// Actual loopback sockets/processes; inert 503 only, no Pipecat/media/provider imports.
// A release restart must distinguish a live foreign owner from retired TCP connections.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { checkVoicePort } from '../voicePipeline';
import { freePort, ROOT } from './helpers';

const owned = new Set<ChildProcess>();
afterEach(async () => {
  for (const p of owned) {
    if (p.exitCode === null && p.signalCode === null) {
      const exited = once(p, 'exit');
      p.kill('SIGTERM');
      await exited;
    }
  }
  owned.clear();
});
const fixture = String.raw`
import os,signal,socket,sys
sys.path.insert(0,'voice-pipeline')
if sys.argv[1]=='legacy':
    s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
    s.bind(('127.0.0.1',int(os.environ['VC_VOICE_PORT'])));s.listen(128)
else:
    from listener import bind_listener
    s=bind_listener();s.setblocking(True)
def stop(*_): raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
print('ready',flush=True)
try:
    while True:
        c,_=s.accept()
        with c:
            c.recv(4096)
            c.sendall(b'HTTP/1.0 503 Unavailable\r\nContent-Length: 0\r\n\r\n')
            # The server actively closes; its accepted connection enters TIME_WAIT.
            c.shutdown(socket.SHUT_WR)
finally: s.close()
`;
async function start(port: number, http: number, legacy = false): Promise<ChildProcess> {
  const p = spawn('python3', ['-u', '-c', fixture, legacy ? 'legacy' : 'exclusive'], {
    cwd: ROOT, env: { PATH: process.env.PATH, VC_VOICE_PORT: String(port), VC_VOICE_HTTP_PORT: String(http) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  owned.add(p);
  await new Promise<void>((resolve, reject) => {
    p.stdout!.once('data', b => String(b).trim() === 'ready' ? resolve() : reject(new Error('unexpected fixture output')));
    p.once('error', reject);
    p.once('exit', () => reject(new Error('owned inert listener could not bind')));
  });
  return p;
}

it('release restart rebinds the same port after the old owned child exits, despite retired HTTP connections; a live second owner is still refused', async () => {
  const port = await freePort();
  let http = await freePort();
  while (http === port) http = await freePort();
  const options = { stateDir: '/unused', port, serverPort: http };
  for (let n = 0; n < 4; n++) {
    await checkVoicePort(options);
    const p = await start(port, http, n === 0); // first listener is the pre-17 aiohttp-style socket
    await expect(checkVoicePort(options)).rejects.toMatchObject({ reason: { code: 'VOICE_PORT_CONFLICT', port } });
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Connection: 'close' } });
    expect(response.status).toBe(503); // explicitly NOT readiness, inference, or voice quality
    await response.text();
    const exited = once(p, 'exit');
    p.kill('SIGTERM'); // ONLY the exact ChildProcess this test spawned
    await exited;
    owned.delete(p);
    expect(p.exitCode).toBe(0);
    if (process.platform === 'linux') {
      const retired = readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1).some(line => {
        const fields = line.trim().split(/\s+/);
        return parseInt(fields[1]!.split(':')[1]!, 16) === port && fields[3] === '06';
      });
      expect(retired).toBe(true); // proves actual kernel TIME_WAIT, not just a mock/restart delay
    }
    // Next iteration repeats the actual OS bind immediately, never waits out TIME_WAIT,
    // adopts an incumbent, changes port or kills by port/PID lookup.
  }
});
