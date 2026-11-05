import { describe, expect, it } from 'vitest';
import { webFixture } from './webFixture';
import { createWebTools, publicAddress, publicLookup, publicUrl } from '../engine/webTools';

describe('bounded shared web transport', () => {
  it('recovers 429 Retry-After and paces concurrent voice/worker searches in one shared scope', async () => {
    const f = await webFixture();
    const web = createWebTools(f.client, { searchUrl: f.base + '/search', interval: 100 });
    const results = await Promise.all(['voice', 'worker1', 'worker2'].map(q => web.search(q, 'local-fixture-only', 'unchanged-model')));
    expect(results.every(r => r.includes('research-fixture.example.org/primary'))).toBe(true);
    expect(results.join('')).not.toContain('HTTP 429');
    expect(f.attempts()).toBe(4); expect(f.peak()).toBe(1);
    expect(f.times[1] - f.times[0]).toBeGreaterThanOrEqual(950);
  });
  it.each(['503', 'date429'])('recovers transient %s with provider-compatible retry', async mode => {
    const f = await webFixture(); f.mode = mode;
    const result = await createWebTools(f.client, { searchUrl: f.base + '/search' }).search('q', 'local', 'same');
    expect(result).toContain('sources'); expect(f.attempts()).toBe(2);
  });
  it.each([['quota', 1, 'quota'], ['long429', 1, 'rate-limited'], ['rate', 3, 'rate-limited']])('stops %s without switch/spend escalation', async (mode, count, reason) => {
    const f = await webFixture(); f.mode = mode as string;
    const result = await createWebTools(f.client, { searchUrl: f.base + '/search' }).search('q', 'local', 'same');
    expect(result).toContain(reason); expect(result).not.toContain('secret-provider-body'); expect(f.attempts()).toBe(count);
  });
  it('cancels in-flight body and queued work without later requests', async () => {
    const f = await webFixture(); f.mode = 'hang';
    const web = createWebTools(f.client, { searchUrl: f.base + '/search', deadline: 300 });
    const ac = new AbortController();
    const first = web.search('voice', 'local', 'same', ac.signal);
    await new Promise(r => setTimeout(r, 30));
    const queued = web.search('worker', 'local', 'same', ac.signal); ac.abort();
    expect((await Promise.all([first, queued])).every(r => /cancelled|timed out/.test(r))).toBe(true);
    await new Promise(r => setTimeout(r, 40)); expect(f.attempts()).toBe(1);
  });
  it('deadline covers headers plus unfinished body', async () => {
    const f = await webFixture(); f.mode = 'hang'; const start = Date.now();
    const r = await createWebTools(f.client, { searchUrl: f.base + '/search', deadline: 100 }).search('q', 'local', 'same');
    expect(r).toContain('timed out'); expect(Date.now() - start).toBeLessThan(1000);
  });
  it('reads actual primary text, follows relative links/redirects, returns provenance and never executes scripts', async () => {
    const f = await webFixture(); const web = createWebTools(f.client);
    const text = await web.fetch({ url: 'http://research-fixture.example.org/redirect' });
    expect(text).toContain('28.75'); expect(text).toContain('http://research-fixture.example.org/primary');
    expect(text).toContain('http://research-fixture.example.org/method'); expect(text).toContain('Untrusted web DATA');
    expect(text).not.toContain('globalThis'); expect((globalThis as any).untrustedExecuted).toBeUndefined();
    expect(f.paths).toEqual(['/redirect', '/primary']);
  });
  it.each(['/binary', '/large', '/loop', '/redirect-private', '/slow'])('bounds unsafe/unreadable page %s', async path => {
    const f = await webFixture();
    const result = await createWebTools(f.client, { deadline: 200 }).fetch({ url: 'http://research-fixture.example.org' + path });
    expect(result).toMatch(/could not read|cancelled|timed out/); expect(f.paths).not.toContain('/private');
  });
  it('blocks private/literal/mapped/link-local/credentials/non-http/port URLs and private DNS', async () => {
    for (const url of ['file:///etc/passwd', 'http://127.1', 'http://2130706433', 'http://169.254.169.254', 'http://10.0.0.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://user:pass@example.org', 'http://example.org:8080', 'http://localhost', 'not a URL']) expect(() => publicUrl(url)).toThrow();
    for (const ip of ['127.0.0.1', '169.254.169.254', '10.1.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:192.168.1.1']) expect(publicAddress(ip)).toBe(false);
    expect(publicAddress('1.1.1.1')).toBe(true);
    const error = await new Promise<any>(resolve => publicLookup('localhost', { all: true }, e => resolve(e)));
    expect(error?.code).toBe('ERR_WEB_PRIVATE');
  });
});
