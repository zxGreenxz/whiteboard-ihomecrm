// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProvinces } from '../useAddressData';

afterEach(() => vi.restoreAllMocks());

describe('useAddressData', () => {
  it('exposes an HTTP failure and can recover when the user retries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('upstream down', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ code: 1, name: 'Thành phố Hà Nội' }]), { status: 200 }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useProvinces(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.provinces).toEqual([]);

    await result.current.retry();
    await waitFor(() => expect(result.current.provinces).toEqual([{ code: 1, name: 'Thành phố Hà Nội' }]));
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
