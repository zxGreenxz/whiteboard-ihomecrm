import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFinancialModelEndpoint } from '../../../.e2e-fleet/specs/copilotFinancialReadOracle';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'controlled-session' } } }) } },
}));

const apiOrigin = 'https://financial-transport.test';
const endpoint = `${apiOrigin}/functions/v1/llm-proxy/chat/completions`;
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('financial model wire endpoint', () => {
  it('accepts the actual goiModelMotLuot request through the financial guard', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', apiOrigin);
    const requests: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), init });
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"controlled response"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
    });
    const { goiModelMotLuot } = await import('../llmClient');
    await goiModelMotLuot({ providerModel: '9router:controlled-model', organizationId: 'dddd0000-0000-4000-8000-000000000001', messages: [{ role: 'user', content: 'controlled request' }], tools: [], signal: new AbortController().signal });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.url).toBe(endpoint);
    expect(isFinancialModelEndpoint(apiOrigin, request.init!.method!, request.url)).toBe(true);
    const headers = new Headers(request.init!.headers);
    expect(headers.get('authorization')).toBe('Bearer controlled-session');
    expect(headers.get('x-organization-id')).toBe('dddd0000-0000-4000-8000-000000000001');
    expect(JSON.parse(String(request.init!.body)).model).toBe('9router:controlled-model');
  });

  it.each([
    ['wrong origin', 'POST', 'https://other.test/functions/v1/llm-proxy/chat/completions'],
    ['wrong method', 'GET', endpoint],
    ['bare proxy path', 'POST', `${apiOrigin}/functions/v1/llm-proxy`],
    ['path prefix', 'POST', `${apiOrigin}/extra/functions/v1/llm-proxy/chat/completions`],
    ['path suffix', 'POST', `${endpoint}/extra`],
    ['trailing slash', 'POST', `${endpoint}/`],
    ['query', 'POST', `${endpoint}?other=1`],
    ['hash', 'POST', `${endpoint}#other`],
    ['malformed URL', 'POST', 'not-a-url'],
  ])('rejects %s', (_name, method, url) => {
    expect(isFinancialModelEndpoint(apiOrigin, method, url)).toBe(false);
  });
});
