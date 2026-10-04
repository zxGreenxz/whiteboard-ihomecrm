import { afterEach, describe, expect, it, vi } from 'vitest';
import { listGmailBills, readGmailProfile } from '../gmail';

const session = () => ({ accessToken: 'synthetic-token', expiresAt: Date.now() + 60_000 });
const range = { from: '2026-10-01', to: '2026-10-04' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Gmail REST boundary', () => {
  it('distinguishes Gmail 401 from an empty mailbox', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { message: 'must not leak' } }, 401)));
    await expect(listGmailBills(session(), 'fixture@example.test', range)).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('retains pagination cursor and caller cursor verbatim', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ messages: [], nextPageToken: 'next/+==' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await listGmailBills(session(), 'fixture@example.test', range, 'old/+==')).toEqual({ bills: [], nextPageToken: 'next/+==', failedCount: 0 });
    const url = new URL(fetcher.mock.calls[0][0]);
    expect(url.searchParams.get('pageToken')).toBe('old/+==');
    expect(url.searchParams.get('q')).toContain('from:(grab.com)');
    expect(url.searchParams.get('q')).toContain('from:(shopee.vn)');
  });
  it('counts individual message errors instead of reporting successful empty results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ messages: [{ id: 'one' }, { id: 'two' }] })).mockResolvedValue(json({}, 500)));
    expect(await listGmailBills(session(), 'fixture@example.test', range)).toMatchObject({ bills: [], failedCount: 2 });
  });
  it('propagates individual 401 instead of swallowing auth failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ messages: [{ id: 'one' }] })).mockResolvedValue(json({}, 401)));
    await expect(listGmailBills(session(), 'fixture@example.test', range)).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('rejects malformed list response instead of false empty success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ messages: 'bad' })));
    await expect(listGmailBills(session(), 'fixture@example.test', range)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('rejects expired session before network request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(readGmailProfile({ accessToken: 'synthetic-token', expiresAt: Date.now() - 1 })).rejects.toMatchObject({ code: 'expired' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates date range before querying Gmail', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(listGmailBills(session(), 'fixture@example.test', { from: '2026-02-30', to: '2026-10-04' })).rejects.toMatchObject({ code: 'invalid_range' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns a validated mailbox profile', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ emailAddress: 'fixture@example.test', messagesTotal: 0, threadsTotal: 0, historyId: '1' })));
    expect(await readGmailProfile(session())).toBe('fixture@example.test');
  });
  it('aborts a pending request and exposes cancellation', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
    const result = readGmailProfile(session(), controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'aborted' });
  });
  it('times out stalled requests', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
    const result = readGmailProfile(session());
    const assertion = expect(result).rejects.toMatchObject({ code: 'timeout' });
    void assertion.catch(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
  it('returns the parsed paid bill while counting malformed individual messages', async () => {
    const text = 'Receipt ID: GRAB-12345\nPayment completed\nTotal: 85.000đ';
    const fetcher = vi.fn().mockResolvedValueOnce(json({ messages: [{ id: 'one' }, { id: 'two' }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(json({ id: 'one', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'receipts@grab.com' }], body: { data: Buffer.from(text).toString('base64url') } } }))
      .mockResolvedValueOnce(json({ id: 'two', payload: { headers: 'invalid' } }));
    vi.stubGlobal('fetch', fetcher);
    const page = await listGmailBills(session(), 'fixture@example.test', range);
    expect(page.bills[0]).toMatchObject({ amount: 85000, source: { receipt_id: 'GRAB-12345' } });
    expect(page.failedCount).toBe(1);
    expect(page.nextPageToken).toBe('next');
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('format')).toBe('full');
  });
  it('does not expose server response details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { message: 'private-email-body' } }, 403)));
    try { await readGmailProfile(session()); throw Error('Expected failure'); } catch (error) {
      expect(error).toMatchObject({ code: 'forbidden' });
      expect(String(error)).not.toContain('private-email-body');
    }
  });
  it('never sends tokens through query strings or browser cookies', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ emailAddress: 'fixture@example.test' }));
    vi.stubGlobal('fetch', fetcher);
    await readGmailProfile(session());
    expect(fetcher.mock.calls[0][0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Authorization: 'Bearer synthetic-token' } });
  });
});
