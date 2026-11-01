import { expect, it } from 'vitest';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeChat, chatText } from './fakeChat';

it('captures exact UTF-8 across HTTP chunks split inside two- and four-byte characters', async () => {
  const provider = await fakeChat();
  try {
    const text = 'café 🧪 𐐀' + '𐐀café'.repeat(20000);
    const body = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: text }] }));
    const cuts = ['é', '🧪', '𐐀'].map(char => body.indexOf(Buffer.from(char)) + 1);
    const chunks = [0, ...cuts, body.length].slice(1).map((end, i) => body.subarray([0, ...cuts][i], end));
    await new Promise<void>((resolve, reject) => {
      const req = request(provider.url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
        res.resume();
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
      // Separate HTTP chunks, deliberately ending within UTF-8 code points.
      const write = (i: number) => {
        if (i === chunks.length) { req.end(); return; }
        req.write(chunks[i], () => setImmediate(() => write(i + 1)));
      };
      write(0);
    });
    expect(provider.calls).toHaveLength(1);
    expect(chatText(provider.calls[0])).toBe(text);
  } finally { await provider.close(); }
});

it('genuine pi SessionManager custom history survives SDK/provider conversion and HTTP capture in full', async () => {
  const pi = join(process.env.VC_TEST_PI_DIR ?? join(homedir(), '.local/state/vault-chat-server/pi/1.1.0'), 'node_modules/@earendil-works');
  const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(join(pi, file)).href);
  const { SessionManager } = await load('pi-coding-agent/dist/core/session-manager.js');
  const { convertToLlm } = await load('pi-coding-agent/dist/core/messages.js');
  const { streamSimple } = await load('pi-ai/dist/api/openai-completions.js');
  const provider = await fakeChat();
  try {
    const text = 'PEER-ORIGINAL-MAIN 🧪 ' + '𐐀café'.repeat(20000);
    const record = { type: 'message', id: 'original-peer-id', message: { role: 'user', content: text + '\nSecond line\n"quoted" \\ original' } };
    const label = 'Full original JSON follows:\n';
    const manager = SessionManager.inMemory('/synthetic-history');
    manager.appendCustomMessageEntry('vc-imported-main', label + JSON.stringify(record), false);
    const model = { id: 'test/fake-model', name: 'local', provider: 'openrouter', api: 'openai-completions', baseUrl: provider.url,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 1000 };
    const result = await streamSimple(model, { messages: convertToLlm(manager.buildSessionContext().messages) }, { apiKey: 'synthetic-local-only' }).result();
    expect(result.stopReason).toBe('stop');
    expect(provider.calls).toHaveLength(1);
    const captured = chatText(provider.calls[0]);
    expect(captured).toContain(text); // Exact full >64KiB body, not a substring sample.
    expect(JSON.parse(captured.slice(label.length))).toEqual(record); // Decode JSON escapes, not lossy body rendering.
  } finally { await provider.close(); }
});
