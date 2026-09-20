import { afterEach, expect, it, vi } from 'vitest';
import type { Page, Request } from '@playwright/test';
import { trackAccountingBrowserAccess } from '../../.e2e-fleet/specs/accounting-browser-access';

const actorId = '10000000-0000-4000-8000-000000000001';
const accountId = '30000000-0000-4000-8000-000000000001';
const account = { id: accountId, organization_id: 'dddd0000-0000-4000-8000-000000000001', is_virtual: false, deleted_at: null };
function harness() {
  let listener: (request: Request) => void;
  const page = { on: (_event: string, fn: typeof listener) => { listener = fn; } } as unknown as Page;
  const verify = trackAccountingBrowserAccess(page, 'expectedproject', actorId);
  const request = (project = 'expectedproject', actor = actorId) => listener({
    url: () => `https://${project}.supabase.co/rest/v1/buildings`,
    headers: () => ({ apikey: 'public-test-key', authorization: `Bearer header.${Buffer.from(JSON.stringify({ sub: actor })).toString('base64url')}.signature` }),
  } as unknown as Request);
  return { verify, request };
}
afterEach(() => vi.unstubAllGlobals());

it('requires the actual DEMO browser session, with the expected project and actor', async () => {
  const { verify, request } = harness();
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  request('otherproject'); request('expectedproject', 'another-actor');
  await expect(verify(accountId)).rejects.toThrow(/phiên DEMO/);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([[], [{ ...account, is_virtual: true }], [{ ...account, organization_id: 'other-org' }], [{ ...account, deleted_at: '2026-09-20' }], [{ ...account, id: 'other-account' }]].map(rows => ({ rows })))(
  'rejects an unreadable or invalid receiving account: $rows', async ({ rows }) => {
    const { verify, request } = harness(); request();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(rows))));
    await expect(verify(accountId)).rejects.toThrow(/không đọc được sổ TT/);
  },
);
it('confirms the exact real DEMO account through the browser bearer, never admin credentials', async () => {
  const { verify, request } = harness(); request();
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe('https://expectedproject.supabase.co');
    expect(url.searchParams.get('id')).toBe(`eq.${accountId}`);
    expect(init.headers).toMatchObject({ apikey: 'public-test-key', Authorization: expect.stringMatching(/^Bearer header\./), 'Accept-Profile': 'public' });
    return new Response(JSON.stringify([account]));
  });
  await expect(verify(accountId)).resolves.toBeUndefined();
});
