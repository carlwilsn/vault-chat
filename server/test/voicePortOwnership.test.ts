// Real OS sockets and compiled backend, no providers, microphone or inference.
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkVoicePort, pipelineState, stopPipeline, wantPipeline } from '../voicePipeline';
import { voicePort } from '../voicePorts';
import { cleanup, freePort, makeVault, ROOT, startServer, tmp } from './helpers';

afterEach(() => stopPipeline());
it('requires positive explicit instance ports and refuses the live ports without probing', () => {
  expect(() => voicePort(19047)).toThrow(/explicit positive/);
  for (const p of ['0', '-1', '65536', 'bad', '8848', '8857', '19047']) expect(() => voicePort(19047, p)).toThrow();
  expect(() => voicePort(19047, '19147', '19148')).toThrow(/agree/);
  expect(voicePort(19047, '19147')).toBe(19147);
  expect(voicePort(8848)).toBe(8857); // pure config, never bind/probe live
});
it('OS bind refuses an owned fixture, throws structured failure and leaves its original HTTP listener alive', async () => {
  let requests = 0;
  const fixture = createServer((_req, res) => { requests++; res.end('original-owner'); });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  const port = (fixture.address() as { port: number }).port;
  const state = tmp('voice-conflict-');
  try {
    expect([8848, 8857]).not.toContain(port);
    const opts = { stateDir: state, port, serverPort: await freePort() };
    await expect(wantPipeline(opts, true)).rejects.toMatchObject({ reason: { code: 'VOICE_PORT_CONFLICT', host: '127.0.0.1', port } });
    expect(pipelineState()).toMatchObject({ running: false, settingUp: false, failure: { code: 'VOICE_PORT_CONFLICT', port } });
    expect(requests).toBe(0); // refusal never HTTP-probes the other listener
    stopPipeline();
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('original-owner');
    // A cold/blocked asyncio import must never delay an already-known bind conflict.
    // The former import order reproduced the installed gate's null exit/3s timeout.
    const imports = join(state, 'imports'); mkdirSync(imports);
    const imported = join(state, 'asyncio-imported');
    writeFileSync(join(imports, 'asyncio.py'), `from pathlib import Path\nimport time\nPath(${JSON.stringify(imported)}).touch()\ntime.sleep(10)\nraise RuntimeError('dependency startup reached before ownership refusal')\n`);
    for (const pythonpath of [undefined, imports]) {
      const child = spawnSync('python3', ['bot.py'], { cwd: join(ROOT, 'voice-pipeline'), env: { PATH: process.env.PATH, ...(pythonpath ? { PYTHONPATH: pythonpath } : {}), VC_VOICE_PORT: String(port), VC_VOICE_HTTP_PORT: String(opts.serverPort) }, encoding: 'utf8', timeout: 3000 });
      expect(child.error).toBeUndefined(); // a timeout is a failure, not an ownership refusal
      expect(child.status).toBe(98); // actual bot binds BEFORE any paid/audio dependency imports
      expect(child.stderr).toMatch(/\[voice bind\].*errno=98/);
      expect(existsSync(imported)).toBe(false); // no unrelated startup work before the OS bind
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('original-owner');
    }
  } finally { await new Promise<void>(r => fixture.close(() => r())); cleanup(state); }
});
it('free explicit port accepts controller preflight and the reused Python exclusive listener', async () => {
  const port = await freePort(), serverPort = await freePort();
  await checkVoicePort({ stateDir: '/unused', port, serverPort });
  const r = spawnSync('python3', ['-c', 'from listener import bind_listener; s=bind_listener(); print(s.getsockname()[0],s.getsockname()[1]); s.close()'], { cwd: join(ROOT, 'voice-pipeline'), env: { PATH: process.env.PATH, VC_VOICE_PORT: String(port), VC_VOICE_HTTP_PORT: String(serverPort) }, encoding: 'utf8', timeout: 3000 });
  expect(r.status).toBe(0); expect(r.stdout.trim()).toBe(`127.0.0.1 ${port}`);
});
it('compiled backend startup failure reaches ordinary health and voice status while device mic stays OFF', async () => {
  const fixture = createServer((_req, res) => { res.writeHead(503); res.end('owned-off'); });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  const port = (fixture.address() as { port: number }).port;
  const home = tmp('voice-backend-');
  let srv: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const vault = makeVault(join(home, 'vault'));
    mkdirSync(join(home, 'state')); writeFileSync(join(home, 'state/voice-engine.json'), '{"engine":"classic","keep":true}');
    srv = await startServer({ home, vault, secrets: join(home, 'empty-credentials'), extra: { VC_ENGINE: '0', VC_VOICE_BRAIN: 'pi', VC_VOICE_PIPELINE: 'on', VC_VOICE_PORT: String(port), VC_VOICE_PIPELINE_PORT: String(port) } });
    const status = await (await fetch(srv.base + '/api/v1/brain/engine')).json();
    expect(status).toMatchObject({ engine: 'new', pipeline: false, failure: { code: 'VOICE_PORT_CONFLICT', port } });
    expect(status.error).toContain(`127.0.0.1:${port}`);
    const health = await (await fetch(srv.base + '/api/v1/health')).json();
    expect(health.voice.failure).toEqual(status.failure);
    expect(health.voice.running).toBe(false);
    expect(readFileSync(join(home, 'state/voice-engine.json'), 'utf8')).toBe('{"engine":"classic","keep":true}');
    for (const route of ['/api/v1/voice/session', '/voice']) expect((await fetch(srv.base + route)).status).toBe(404);
    const old = await fetch(srv.base + '/api/v1/brain/engine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"engine":"classic"}' });
    expect(old.status).toBe(410);
    const refused = await fetch(srv.base + '/api/v1/brain/engine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"engine":"new"}' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, error: status.error, failure: status.failure });
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('owned-off');
  } finally { await srv?.stop(); await new Promise<void>(r => fixture.close(() => r())); cleanup(home); }
});
it('source voice OFF does not start the pipeline or probe the inert endpoint on status/health', async () => {
  let probes = 0;
  const fixture = createServer((_req, res) => { probes++; res.writeHead(503); res.end(); });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  const port = (fixture.address() as { port: number }).port, home = tmp('voice-off-');
  let srv: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const vault = makeVault(join(home, 'vault'));
    mkdirSync(join(home, 'state')); writeFileSync(join(home, 'state/voice-engine.json'), '{"engine":"new"}');
    srv = await startServer({ home, vault, secrets: join(home, 'empty-credentials'), extra: { VC_ENGINE: '0', VC_VOICE_BRAIN: 'pi', VC_VOICE_PIPELINE: 'off', VC_VOICE_PORT: String(port), VC_VOICE_PIPELINE_PORT: String(port) } });
    expect(await (await fetch(srv.base + '/api/v1/brain/engine')).json()).toMatchObject({ pipeline: false, failure: null });
    expect((await (await fetch(srv.base + '/api/v1/health')).json()).voice).toMatchObject({ wanted: false, running: false });
    expect(probes).toBe(0);
  } finally { await srv?.stop(); await new Promise<void>(r => fixture.close(() => r())); cleanup(home); }
});
