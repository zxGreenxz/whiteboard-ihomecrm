import { afterEach, expect, it, vi } from 'vitest';
import { choApiSanSang } from '../test-env/hau-ky.mjs';

afterEach(() => vi.unstubAllGlobals());
it.each([401, 403, 404, 500])('HTTP %i cannot certify TEST API ready', async status => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status }));
  expect(await choApiSanSang('https://test.invalid', 'sb_test', { toiDaGiay: 0 })).toBe(false);
});
it('successful data response certifies readiness', async () => {
  vi.stubGlobal('fetch', async () => new Response('[{"id":"org"}]', { status: 200 }));
  expect(await choApiSanSang('https://test.invalid', 'sb_test', { toiDaGiay: 0 })).toBe(true);
});
