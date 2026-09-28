// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePhongTrong } from '../usePhongTrong';
import { PublicRoomLinkError } from '../supabaseData';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
afterEach(cleanup);

function load() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return renderHook(() => usePhongTrong('test-link'), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}

describe('public availability response', () => {
  it('distinguishes a revoked link from a valid empty result', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    const invalid = load();
    await waitFor(() => expect(invalid.result.current.isError).toBe(true));
    expect(invalid.result.current.error).toBeInstanceOf(PublicRoomLinkError);
    invalid.unmount();

    rpc.mockResolvedValueOnce({ data: { buildings: [], rooms: [] }, error: null });
    const empty = load();
    await waitFor(() => expect(empty.result.current.isSuccess).toBe(true));
    expect(empty.result.current.data).toEqual([]);
  });

  it('does not treat a malformed or unavailable response as no rooms', async () => {
    rpc.mockResolvedValueOnce({ data: { rooms: [] }, error: null });
    const malformed = load();
    await waitFor(() => expect(malformed.result.current.isError).toBe(true));
    expect(malformed.result.current.error).not.toBeInstanceOf(PublicRoomLinkError);
    malformed.unmount();

    rpc.mockResolvedValueOnce({ data: null, error: new Error('Failed to fetch') });
    const offline = load();
    await waitFor(() => expect(offline.result.current.isError).toBe(true));
    expect(offline.result.current.error).not.toBeInstanceOf(PublicRoomLinkError);
  });
});
