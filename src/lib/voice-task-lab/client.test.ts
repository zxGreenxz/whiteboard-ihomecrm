// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { labClient } from './client';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('capability discovery timeout', () => {
  it('rejects a malformed session response instead of treating login as successful', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>upstream error</html>', { status: 200 }));
    await expect(labClient.session('test-code')).rejects.toMatchObject({ name: 'LabApiError' });
  });
  it('allows provider discovery to finish after its sixty-second upstream deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = window.setTimeout(() => resolve(new Response(JSON.stringify({ authenticated: true, chatModels: [], sttModels: [], defaultChatModel: null, defaultSttModel: null, providerReady: false, capabilityError: '9Router chưa sẵn sàng' }), { status: 200 })), 65_000);
      options.signal?.addEventListener('abort', () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); });
    }));
    const outcome = labClient.status().then(value => ({ ok: true, value }), () => ({ ok: false }));
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await outcome).toMatchObject({ ok: true, value: { authenticated: true, providerReady: false } });
  });

  it('still aborts a status request when the server never responds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const outcome = labClient.status().then(() => null, error => error as Error);
    await vi.advanceTimersByTimeAsync(75_000);
    expect((await outcome)?.message).toContain('phản hồi quá lâu');
  });
});
