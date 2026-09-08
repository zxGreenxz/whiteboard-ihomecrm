// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../../../api/customer-address-conversion.js';

function response() {
  return { statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
const request = (body = { address: '91 Trung Kính, Trung Hòa, Cầu Giấy, Hà Nội' }) => ({
  method: 'POST', headers: { authorization: 'Bearer test-session' }, body,
});
function configure() {
  vi.stubEnv('GOONG_API_KEY', 'server-only-test-key');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'test-public-key');
}
const candidate = {
  place_id: 'test-place', formatted_address: '91 Trung Kính, Yên Hòa, Hà Nội',
  compound: { province: 'Hà Nội', commune: 'Yên Hòa' },
  deprecated_compound: { province: 'Hà Nội', district: 'Cầu Giấy', commune: 'Trung Hòa' },
};
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('customer address conversion endpoint', () => {
  it('bounds repeated authenticated requests before they consume provider quota', async () => {
    configure(); let providerCalls = 0;
    vi.stubGlobal('fetch', async url => {
      if (String(url).includes('/auth/v1/user')) return Response.json({ id: 'fixture-rate-limit' });
      providerCalls++; return Response.json({ status: 'ZERO_RESULTS', results: [] });
    });
    for (let i = 0; i < 30; i++) {
      const res = response(); await handler(request(), res); expect(res.statusCode).toBe(200);
    }
    const limited = response(); await handler(request(), limited);
    expect(limited.statusCode).toBe(429); expect(providerCalls).toBe(30);
    expect(limited.headers['Retry-After']).toBeTruthy();
  });
  it('rejects anonymous requests before contacting either provider', async () => {
    configure(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const res = response(); await handler({ ...request(), headers: {} }, res);
    expect(res.statusCode).toBe(401); expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects a forged session and never calls Goong', async () => {
    configure(); const calls = [];
    vi.stubGlobal('fetch', async (url) => { calls.push(String(url)); return new Response('{}', { status: 401 }); });
    const res = response(); await handler(request(), res);
    expect(res.statusCode).toBe(401); expect(calls).toEqual(['https://test-project.supabase.co/auth/v1/user']);
  });
  it('accepts POST only and rejects empty, non-string and overlong addresses', async () => {
    configure(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const res = response(); await handler({ ...request(), method: 'GET' }, res);
    expect(res.statusCode).toBe(405);
    for (const address of ['', '   ', {}, 'x'.repeat(601)]) {
      const r = response(); await handler(request({ address }), r); expect(r.statusCode).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports missing server configuration explicitly without exposing credentials', async () => {
    configure(); vi.stubEnv('GOONG_API_KEY', '');
    const res = response(); await handler(request(), res);
    expect(res.statusCode).toBe(503); expect(res.body.code).toBe('NOT_CONFIGURED');
    expect(JSON.stringify(res.body)).not.toContain('test-public-key');
  });
  it('uses V2 only, separates new units from old reference, and never returns the secret', async () => {
    configure(); const calls = [];
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(calls.length === 1 ? { id: 'fixture-user' } : { status: 'OK', results: [candidate] });
    });
    const res = response(); await handler(request(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ source: 'goong-v2', candidates: [{
      id: 'test-place', formattedAddress: candidate.formatted_address,
      province: 'Hà Nội', ward: 'Yên Hòa', oldAddress: 'Trung Hòa, Cầu Giấy, Hà Nội',
    }] });
    const url = new URL(calls[1].url);
    expect(url.origin + url.pathname).toBe('https://rsapi.goong.io/v2/geocode');
    expect(url.searchParams.get('has_deprecated_administrative_unit')).toBe('true');
    expect(calls.every(call => call.init.signal instanceof AbortSignal)).toBe(true);
    expect(res.headers['Cache-Control']).toContain('no-store');
    expect(JSON.stringify(res.body)).not.toContain('server-only-test-key');
  });
  it('returns distinct candidates for review instead of silently selecting the first', async () => {
    configure(); let count = 0;
    vi.stubGlobal('fetch', async () => Response.json(++count === 1 ? { id: 'fixture-user' } : {
      status: 'OK', results: [candidate, candidate, { ...candidate, place_id: 'second-place', formatted_address: 'Địa chỉ khác' }],
    }));
    const res = response(); await handler(request(), res);
    expect(res.body.candidates).toHaveLength(2);
  });
  it('does not promote deprecated fields to new units or retry V1 on failure', async () => {
    configure();
    for (const upstream of [Response.json({ status: 'ZERO_RESULTS', results: [] }),
      Response.json({ status: 'OK', results: [{ ...candidate, compound: {} }] }),
      new Response('provider error server-only-test-key', { status: 500 })]) {
      let calls = 0;
      vi.stubGlobal('fetch', async () => ++calls === 1 ? Response.json({ id: 'fixture-user' }) : upstream);
      const res = response(); await handler(request(), res);
      expect(calls).toBe(2);
      expect(res.body.candidates ?? []).toHaveLength(0);
      expect(JSON.stringify(res.body)).not.toContain('server-only-test-key');
    }
  });
  it('handles provider/network failures without leaking address or upstream URL', async () => {
    configure(); let calls = 0;
    vi.stubGlobal('fetch', async () => {
      if (++calls === 1) return Response.json({ id: 'fixture-user' });
      throw new Error('private URL api_key=server-only-test-key');
    });
    const res = response(); await handler(request(), res);
    expect(res.statusCode).toBe(502); expect(res.body.code).toBe('PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('private URL');
  });
});
