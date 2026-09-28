// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePhongTrong } from '../usePhongTrong';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
const empty = { data: { buildings: [], rooms: [] }, error: null };
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();rpc.mockReset();focusManager.setFocused(true);onlineManager.setOnline(true);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
});
afterEach(() => {
  cleanup();client.clear();focusManager.setFocused(undefined);onlineManager.setOnline(true);vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
function load() {
  return renderHook(() => usePhongTrong('valid-link'), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}
const advance = async (time: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(time); }); };

describe('live public availability refresh', () => {
  it('polls at five seconds, pauses while hidden, then refreshes on focus/reconnect', async () => {
    rpc.mockResolvedValue(empty);load();await advance(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    await advance(5000);expect(rpc).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    focusManager.setFocused(false);await advance(20000);expect(rpc).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { focusManager.setFocused(true);await vi.advanceTimersByTimeAsync(1); });
    expect(rpc).toHaveBeenCalledTimes(3);
    await act(async () => { onlineManager.setOnline(false);onlineManager.setOnline(true);await vi.advanceTimersByTimeAsync(1); });
    expect(rpc).toHaveBeenCalledTimes(4);
  });
  it('backs off repeated errors and resumes five-second refresh after success', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('Offline') })
      .mockResolvedValueOnce({ data: null, error: new Error('Offline again') }).mockResolvedValue(empty);
    load();await advance(1);expect(rpc).toHaveBeenCalledTimes(1);
    await advance(9999);expect(rpc).toHaveBeenCalledTimes(2);
    await advance(19999);expect(rpc).toHaveBeenCalledTimes(2);
    await advance(1);expect(rpc).toHaveBeenCalledTimes(3);
    await advance(5000);expect(rpc).toHaveBeenCalledTimes(4);
  });
  it('does not repeatedly poll a revoked token', async () => {
    rpc.mockResolvedValue({ data: null, error: null });load();await advance(1);
    await advance(60000);expect(rpc).toHaveBeenCalledTimes(1);
  });
});
