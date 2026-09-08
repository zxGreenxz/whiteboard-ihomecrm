// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDistricts, useProvinces, useWards } from '../useAddressData';

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

  it('does not fetch child levels before their parent code exists', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    renderHook(() => ({ districts: useDistricts(), wards: useWards(null) }), { wrapper });
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed districts envelope and recovers on retry', async () => {
    const validPayload = { districts: [{ code: 760, name: 'Quận 1', province_code: 79 }] };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(validPayload), { status: 200 }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useDistricts('79'), { wrapper });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    await result.current.retry();
    await waitFor(() => expect(result.current.districts).toEqual(validPayload.districts));
  });

  it('rejects a malformed wards envelope and recovers on retry', async () => {
    const validPayload = { wards: [{ code: 26734, name: 'Phường Bến Nghé', district_code: 760 }] };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(validPayload), { status: 200 }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useWards('760'), { wrapper });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    await result.current.retry();
    await waitFor(() => expect(result.current.wards).toEqual(validPayload.wards));
  });
});
