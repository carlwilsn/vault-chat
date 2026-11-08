import { describe, expect, it } from 'vitest';
import { webFixture } from './webFixture';
import { createWebTools, publicAddress, publicLookup, publicUrl } from '../engine/webTools';

// WebFetch: one public page, read through vault-chat's own guards. The search
// that used to share this transport went with the OpenRouter key it needed —
// the agent searches with Claude Code's own WebSearch now.
describe('bounded web reading', () => {
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
