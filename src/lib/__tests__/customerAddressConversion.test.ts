import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleLegacyAddress, convertCustomerAddress } from '../customerAddressConversion';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: {
  getSession: async () => ({ data: { session: { access_token: 'test-token' } } }),
} } }));
afterEach(() => vi.unstubAllGlobals());
describe('customer address conversion', () => {
  it('keeps house numbers, wards and districts distinct even when their numbers match', () => {
    expect(assembleLegacyAddress('3', ['Phường 3', 'Quận 3', 'Thành phố Hồ Chí Minh']))
      .toBe('3, Phường 3, Quận 3, Thành phố Hồ Chí Minh');
  });
  it('builds an old address using names instead of codes and keeps slash house numbers', () => {
    expect(assembleLegacyAddress('12/3 Đường Mẫu', ['Phường 1', 'Quận 3', 'Thành phố Hồ Chí Minh']))
      .toBe('12/3 Đường Mẫu, Phường 1, Quận 3, Thành phố Hồ Chí Minh');
    expect(assembleLegacyAddress('12/3 Đường Mẫu, Phường 1, Quận 3, TP. Hồ Chí Minh', ['Phường 1', 'Quận 3', 'Thành phố Hồ Chí Minh']))
      .toBe('12/3 Đường Mẫu, Phường 1, Quận 3, TP. Hồ Chí Minh');
  });
  it('sends only the address to the authenticated same-origin endpoint', async () => {
    const fetcher = vi.fn(async () => Response.json({ source: 'goong-v2', candidates: [] }));
    vi.stubGlobal('fetch', fetcher);
    const signal = new AbortController().signal;
    await expect(convertCustomerAddress('Địa chỉ mẫu', signal)).resolves.toEqual({ source: 'goong-v2', candidates: [] });
    expect(fetcher).toHaveBeenCalledWith('/api/customer-address-conversion', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ address: 'Địa chỉ mẫu' }), signal,
    });
  });
  it('rejects legacy or malformed responses rather than labeling them current', async () => {
    for (const body of [{ source: 'goong', candidates: [] }, { source: 'goong-v2', candidates: [{ province: 'A' }] }]) {
      vi.stubGlobal('fetch', async () => Response.json(body));
      await expect(convertCustomerAddress('Địa chỉ mẫu', new AbortController().signal)).rejects.toThrow('không hợp lệ');
    }
  });
  it('does not send requests after cancellation', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController(); controller.abort();
    await expect(convertCustomerAddress('Địa chỉ mẫu', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
