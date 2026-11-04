// Reuses the built ports-on-reset-startup lifecycle test approach. Provider/audio transport is mocked;
// real TCP preflight is NOT mocked. No inference/microphone claim.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ children: [] as any[], env: null as any }));
vi.mock('node:child_process', async original => {
  const real = await original<typeof import('node:child_process')>();
  return { ...real, spawnSync: (...args: any[]) => args[0] === 'uv' ? { status: 0 } : (real.spawnSync as any)(...args),
    spawn: (_cmd: string, _args: string[], o: any) => {
      fake.env = o.env;
      const p = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
      fake.children.push(p); return p;
    } };
});
import { pipelineState, stopPipeline, wantPipeline } from '../voicePipeline';
import { cleanup, freePort, ROOT, tmp } from './helpers';
let root = '';
afterEach(() => { stopPipeline(); cleanup(root); fake.children = []; });
it('free owned port passes configured ports to child, readiness waits for actual startup marker; stale sessions cannot stop/reset the next child', async () => {
  root = tmp('voice-lifecycle-');
  const voice = join(root, 'voice'); mkdirSync(join(voice, 'venv/bin'), { recursive: true });
  writeFileSync(join(voice, 'venv/bin/python'), '');
  writeFileSync(join(voice, 'venv.stamp'), createHash('sha256').update(readFileSync(join(ROOT, 'voice-pipeline/requirements.txt'))).digest('hex').slice(0,16));
  const options = { stateDir: root, serverPort: await freePort(), port: await freePort() };
  await wantPipeline(options, true);
  await vi.waitFor(() => expect(fake.children).toHaveLength(1));
  const first = fake.children[0];
  expect(pipelineState().running).toBe(false);
  expect(fake.env).toMatchObject({ VC_VOICE_PORT: String(options.port), VC_VOICE_HTTP_PORT: String(options.serverPort) });
  first.stdout.write('[voice ready]\n'); expect(pipelineState().running).toBe(true);
  stopPipeline(); expect(first.kill).toHaveBeenCalledWith('SIGTERM');
  const next = { ...options, port: await freePort() };
  await wantPipeline(next, true); await vi.waitFor(() => expect(fake.children).toHaveLength(2));
  const second = fake.children[1]; second.stdout.write('[voice ready]\n');
  first.emit('exit', 98); first.stderr.write('[voice bind] port=1 errno=98');
  expect(pipelineState()).toMatchObject({ running: true, failure: null });
  second.stderr.write(`[voice bind] port=${next.port} errno=98\n`); second.exitCode = 98; second.emit('exit', 98);
  expect(pipelineState()).toMatchObject({ running: false, failure: { code: 'VOICE_PORT_CONFLICT', port: next.port } });
  await expect(wantPipeline(next, true)).rejects.toMatchObject({ reason: { code: 'VOICE_PORT_CONFLICT' } });
  stopPipeline(); expect(second.kill).not.toHaveBeenCalled();
  expect(fake.children).toHaveLength(2); // No hidden fallback/retry child
});
