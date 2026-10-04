// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../../api/bank-email/oauth/start.js';

const connectionId = '00000000-0000-4000-8000-000000000001';
const request = (body: unknown = { connectionId }) => ({ method: 'POST', headers: { authorization: 'Bearer synthetic-session' }, body });
function response() {
  return { statusCode: 200, headers: {} as Record<string, string>, body: null as unknown,
    setHeader(key: string, value: string) { this.headers[key] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const configure = () => {
  vi.stubEnv('BANK_EMAIL_WORKER_URL', 'https://bank-worker.example.test');
  vi.stubEnv('APP_ORIGIN', 'https://crm.example.test');
};

describe('same-origin Gmail OAuth bridge', () => {
  it('forwards only validated connection and bearer to the configured worker, without following redirects', async () => {
    configure();
    const fetcher = vi.fn().mockResolvedValue(Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' }));
    vi.stubGlobal('fetch', fetcher);
    const res = response();
    await handler(request({ connectionId, destination: 'https://attacker.example' }), res);
    expect(res.statusCode).toBe(200);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://bank-worker.example.test/oauth/start');
    expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toBe('Bearer synthetic-session');
    expect(init.headers.Origin).toBe('https://crm.example.test');
    expect(JSON.parse(init.body)).toEqual({ connectionId });
    expect(res.headers['Cache-Control']).toContain('no-store');
  });

  it.each([
    ['missing authorization', { ...request(), headers: {} }, 401],
    ['oversized authorization', { ...request(), headers: { authorization: `Bearer ${'x'.repeat(9000)}` } }, 401],
    ['wrong method', { ...request(), method: 'GET' }, 405],
    ['invalid id', request({ connectionId: 'bad' }), 400],
    ['malformed JSON', request('{'), 400],
  ])('rejects %s before any upstream request', async (_label, req, status) => {
    configure(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const res = response(); await handler(req, res);
    expect(res.statusCode).toBe(status); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['', 'http://worker.example', 'https://user:secret@worker.example', 'https://worker.example/unexpected'])('fails closed for invalid server endpoint %s', async endpoint => {
    configure(); vi.stubEnv('BANK_EMAIL_WORKER_URL', endpoint);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const res = response(); await handler(request(), res);
    expect(res.statusCode).toBe(503); expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not expose upstream error bodies or arbitrary redirect targets', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('private-error-detail', { status: 500 }))
      .mockResolvedValueOnce(Response.json({ url: 'https://attacker.example' })));
    const failure = response(); await handler(request(), failure);
    expect(failure.statusCode).toBe(502); expect(JSON.stringify(failure.body)).not.toContain('private-error');
    const malicious = response(); await handler(request(), malicious); expect(malicious.statusCode).toBe(502);
  });
});
