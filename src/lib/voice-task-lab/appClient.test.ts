// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppLabClient } from './appClient';
beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());
const session = { access_token: 'session-token', user: { id: 'user-a' } };
describe('authenticated voice lab adapter', () => {
  it('preserves cancellation while reading a response body', async () => {
    const response = new Response('{}');
    vi.spyOn(response, 'json').mockRejectedValue(new DOMException('Đã hủy', 'AbortError'));
    const client = createAppLabClient({ userId: 'user-a', organizationId: 'org-a', getSession: async () => session, storage: localStorage, fetcher: async () => response });
    await expect(client.status()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('retains the HTTP auth status when its error body is not JSON', async () => {
    const client = createAppLabClient({ userId: 'user-a', organizationId: 'org-a', getSession: async () => session, storage: localStorage, fetcher: async () => new Response('Unauthorized', { status: 401 }) });
    await expect(client.status()).rejects.toMatchObject({ name: 'LabApiError', status: 401 });
  });
  it('uses the CRM bearer and selected organization without an access-code session', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ authenticated: true, providerReady: false, chatModels: [], sttModels: [] })));
    const client = createAppLabClient({ userId: 'user-a', organizationId: 'org-a', getSession: async () => session, storage: localStorage, fetcher });
    await client.status();
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/voice-task-lab');
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer session-token');
    expect(JSON.parse(options.body as string)).toEqual({ action: 'status', organizationId: 'org-a' });
    expect(client.session).toBeUndefined();
  });
  it('rejects an identity change or cancellation while obtaining the token before any request', async () => {
    const fetcher = vi.fn();
    let resolve!: (value: typeof session) => void;
    const client = createAppLabClient({ userId: 'user-a', organizationId: 'org-a', getSession: () => new Promise(done => { resolve = done; }), storage: localStorage, fetcher });
    const controller = new AbortController(); const pending = client.status(controller.signal);
    controller.abort(); resolve(session);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const changed = createAppLabClient({ userId: 'user-a', organizationId: 'org-a', getSession: async () => ({ ...session, user: { id: 'user-b' } }), storage: localStorage, fetcher });
    await expect(changed.status()).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects audio above the deployed API limit before calling the server', async () => {
    const fetcher = vi.fn();
    const client = createAppLabClient({ userId: 'user-a', organizationId: 'org-a', getSession: async () => session, storage: localStorage, fetcher });
    await expect(client.transcribe(new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'audio/mp4' }), 'stt-a')).rejects.toThrow(/2 MiB/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('aborts a stalled deployed request after the function budget plus a bounded margin', async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Đã hủy', 'AbortError')));
    });
    const client = createAppLabClient({ userId: 'user-a', organizationId: 'org-a', getSession: async () => session, storage: localStorage, fetcher });
    const result = client.status().then(() => null, error => error as Error);
    await vi.advanceTimersByTimeAsync(95_000);
    expect((await result)?.message).toContain('phản hồi quá lâu');
  });
});
