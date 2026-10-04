// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailBill, GmailBillPage, GmailSession } from '@/lib/emailBills/types';

const external = vi.hoisted(() => ({ load: vi.fn(), authorize: vi.fn(), profile: vi.fn(), list: vi.fn(), lookup: vi.fn() }));
vi.mock('@/lib/emailBills/googleAuth', () => ({ loadGoogleAuth: external.load, authorizeGmail: external.authorize }));
vi.mock('@/lib/emailBills/gmail', () => ({ readGmailProfile: external.profile, listGmailBills: external.list }));
vi.mock('@/lib/emailBills/importRpc', () => ({ emailBillRepository: { lookup: external.lookup }, emailBillKey: (source: { provider: string; receipt_id: string }) => `${source.provider}:${source.receipt_id}` }));
import { useEmailBillImport } from '../useEmailBillImport';

const range = { from: '2026-10-01', to: '2026-10-04' };
const access = (): GmailSession => ({ accessToken: 'synthetic-token', expiresAt: Date.now() + 3600_000 });
const bill: EmailBill = {
  source: { provider: 'grab', mailbox: 'fixture@example.test', message_id: 'one', receipt_id: 'GRAB-12345' },
  subject: 'Synthetic receipt', description: 'Grab - GRAB-12345', date: '2026-10-04', amount: 85000,
  text: 'Synthetic test text', warnings: [], blocked: false,
};
const page: GmailBillPage = { bills: [bill], nextPageToken: 'next/+==', failedCount: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function hook() { return renderHook(({ org, user }) => useEmailBillImport(org, user), { initialProps: { org: 'org-one', user: 'user-one' } }); }
type Hook = ReturnType<typeof hook>;
async function ready(instance: Hook) { await waitFor(() => expect(instance.result.current.authReady).toBe(true)); }
async function connect(instance: Hook) { await ready(instance); await act(async () => { await instance.result.current.connect(); }); }
async function search(instance: Hook) { await act(async () => { await instance.result.current.search(range); }); }

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('VITE_GMAIL_CLIENT_ID', 'synthetic.apps.googleusercontent.com');
  external.load.mockResolvedValue(undefined); external.authorize.mockImplementation(async () => access());
  external.profile.mockResolvedValue('fixture@example.test'); external.list.mockResolvedValue(page);
  external.lookup.mockResolvedValue(new Set(['grab:GRAB-12345']));
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('useEmailBillImport lifecycle', () => {
  it('does not authorize or read Gmail before the user connects and searches', async () => {
    const instance = hook(); await ready(instance);
    expect(external.authorize).not.toHaveBeenCalled(); expect(external.profile).not.toHaveBeenCalled(); expect(external.list).not.toHaveBeenCalled();
    await connect(instance);
    expect(instance.result.current.connected).toBe(true); expect(external.list).not.toHaveBeenCalled();
    await search(instance);
    expect(instance.result.current.bills).toEqual([bill]); expect(instance.result.current.imported.has('grab:GRAB-12345')).toBe(true);
  });
  it('shows missing configuration without reading Gmail', async () => {
    vi.stubEnv('VITE_GMAIL_CLIENT_ID', ''); const instance = hook();
    await act(async () => { await instance.result.current.connect(); });
    expect(instance.result.current.configured).toBe(false); expect(instance.result.current.authReady).toBe(false);
    expect(external.load).not.toHaveBeenCalled(); expect(external.profile).not.toHaveBeenCalled();
  });
  it('keeps script failure actionable and does not enable authorize', async () => {
    external.load.mockRejectedValueOnce(new Error('synthetic-script-error')); const instance = hook();
    await waitFor(() => expect(instance.result.current.error).toMatch(/Đóng màn hình.*mở lại/));
    expect(instance.result.current.authReady).toBe(false); expect(external.profile).not.toHaveBeenCalled();
  });
  it('does not read/store a late OAuth result after dialog unmount', async () => {
    const authorization = deferred<GmailSession>(); external.authorize.mockReturnValueOnce(authorization.promise);
    const storage = vi.spyOn(Storage.prototype, 'setItem'); const instance = hook(); await ready(instance);
    let pending!: Promise<void>;
    act(() => { pending = instance.result.current.connect(); }); instance.unmount();
    await act(async () => { authorization.resolve(access()); await pending; });
    expect(external.profile).not.toHaveBeenCalled(); expect(external.list).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
  });
  it('aborts and ignores a Gmail search arriving after unmount', async () => {
    const listing = deferred<GmailBillPage>(); external.list.mockReturnValueOnce(listing.promise);
    const instance = hook(); await connect(instance); let pending!: Promise<void>;
    act(() => { pending = instance.result.current.search(range); });
    const signal = external.list.mock.calls[0][4] as AbortSignal;
    instance.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { listing.resolve(page); await pending; });
    expect(external.lookup).not.toHaveBeenCalled();
  });
  it.each(['org', 'user'] as const)('clears all mailbox state when %s changes', async (changed) => {
    const instance = hook(); await connect(instance); await search(instance);
    expect(instance.result.current.bills).toHaveLength(1);
    instance.rerender(changed === 'org' ? { org: 'org-two', user: 'user-one' } : { org: 'org-one', user: 'user-two' });
    expect(instance.result.current).toMatchObject({ connected: false, mailbox: '', bills: [], busy: false, searched: false, failedCount: 0, nextPageToken: null });
    expect(instance.result.current.imported.size).toBe(0);
    await act(async () => { await instance.result.current.search(range); });
    expect(instance.result.current.error).toMatch(/Kết nối Gmail trước/);
    expect(external.list).toHaveBeenCalledOnce();
  });
  it('scope change discards a late search and unlocks a new connection', async () => {
    const listing = deferred<GmailBillPage>(); external.list.mockReturnValueOnce(listing.promise);
    const instance = hook(); await connect(instance); let old!: Promise<void>;
    act(() => { old = instance.result.current.search(range); });
    expect(instance.result.current.busy).toBe(true);
    instance.rerender({ org: 'org-two', user: 'user-one' }); await ready(instance);
    expect(instance.result.current.busy).toBe(false);
    await act(async () => { await instance.result.current.connect(); });
    expect(external.authorize).toHaveBeenCalledTimes(2);
    await act(async () => { listing.resolve(page); await old; });
    expect(instance.result.current.bills).toEqual([]); expect(external.lookup).not.toHaveBeenCalled();
  });
  it('scope change ignores an old OAuth result while a new popup can connect', async () => {
    const authorization = deferred<GmailSession>(); external.authorize.mockReturnValueOnce(authorization.promise);
    const instance = hook(); await ready(instance); let old!: Promise<void>;
    act(() => { old = instance.result.current.connect(); });
    instance.rerender({ org: 'org-one', user: 'user-two' }); await ready(instance);
    await connect(instance);
    await act(async () => { authorization.resolve(access()); await old; });
    expect(external.authorize).toHaveBeenCalledTimes(2); expect(external.profile).toHaveBeenCalledOnce();
  });
  it('continues with the saved date range and original cursor despite changed inputs', async () => {
    const second: EmailBill = { ...bill, source: { ...bill.source, message_id: 'two', receipt_id: 'GRAB-54321' } };
    external.list.mockResolvedValueOnce(page).mockResolvedValueOnce({ bills: [second], nextPageToken: null, failedCount: 2 });
    const instance = hook(); await connect(instance); await search(instance);
    await act(async () => { await instance.result.current.search({ from: '2026-09-01', to: '2026-09-02' }, true); });
    expect(external.list.mock.calls[1]).toEqual([expect.objectContaining({ accessToken: 'synthetic-token' }), 'fixture@example.test', range, 'next/+==', expect.any(AbortSignal)]);
    expect(instance.result.current.bills).toEqual([bill, second]); expect(instance.result.current.failedCount).toBe(3); expect(instance.result.current.nextPageToken).toBeNull();
  });
  it('does not publish unverified bills as unimported when lookup fails', async () => {
    external.lookup.mockRejectedValueOnce(new Error('Chưa kiểm tra được các hóa đơn đã nhập. Hãy thử tìm lại.'));
    const instance = hook(); await connect(instance); await search(instance);
    expect(instance.result.current.error).toMatch(/kiểm tra.*đã nhập/); expect(instance.result.current.bills).toEqual([]);
    expect(instance.result.current.searched).toBe(false); expect(instance.result.current.busy).toBe(false);
    await search(instance); expect(instance.result.current.bills).toEqual([bill]);
  });
  it('reports popup closure and permits another explicit connect', async () => {
    external.authorize.mockRejectedValueOnce(new Error('Bạn đã đóng cửa sổ kết nối Gmail.'));
    const instance = hook(); await connect(instance);
    expect(instance.result.current.error).toMatch(/đóng cửa sổ/); expect(instance.result.current.connected).toBe(false); expect(instance.result.current.busy).toBe(false);
    await connect(instance); expect(instance.result.current.connected).toBe(true);
  });
  it('prevents duplicate authorization requests from double click', async () => {
    const authorization = deferred<GmailSession>(); external.authorize.mockReturnValueOnce(authorization.promise);
    const instance = hook(); await ready(instance); let first!: Promise<void>;
    act(() => { first = instance.result.current.connect(); void instance.result.current.connect(); });
    expect(external.authorize).toHaveBeenCalledOnce();
    await act(async () => { authorization.resolve(access()); await first; });
    expect(instance.result.current.connected).toBe(true);
  });
  it('prevents duplicate list requests while a search is pending', async () => {
    const listing = deferred<GmailBillPage>(); external.list.mockReturnValueOnce(listing.promise);
    const instance = hook(); await connect(instance); let first!: Promise<void>;
    act(() => { first = instance.result.current.search(range); void instance.result.current.search(range); });
    expect(external.list).toHaveBeenCalledOnce();
    await act(async () => { listing.resolve(page); await first; });
    expect(instance.result.current.bills).toEqual([bill]);
  });
  it('clears token and prior bill data on session expiry before a search', async () => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    external.authorize.mockResolvedValueOnce({ accessToken: 'synthetic-token', expiresAt: now + 100 });
    const instance = hook(); await connect(instance); await search(instance);
    vi.mocked(Date.now).mockReturnValue(now + 101);
    await search(instance);
    expect(instance.result.current).toMatchObject({ connected: false, mailbox: '', bills: [], searched: false, failedCount: 0, nextPageToken: null });
    expect(instance.result.current.error).toMatch(/hết hạn.*kết nối lại/); expect(external.list).toHaveBeenCalledOnce();
  });
  it('ignores a registry lookup resolving after organization change', async () => {
    const lookup = deferred<Set<string>>(); external.lookup.mockReturnValueOnce(lookup.promise);
    const instance = hook(); await connect(instance); let old!: Promise<void>;
    act(() => { old = instance.result.current.search(range); });
    await waitFor(() => expect(external.lookup).toHaveBeenCalledOnce());
    instance.rerender({ org: 'org-two', user: 'user-one' });
    await act(async () => { lookup.resolve(new Set(['grab:GRAB-12345'])); await old; });
    expect(instance.result.current.bills).toEqual([]); expect(instance.result.current.imported.size).toBe(0); expect(instance.result.current.connected).toBe(false);
  });
  it('ignores an old script failure after a new scope became ready', async () => {
    const script = deferred<void>(); external.load.mockReturnValueOnce(script.promise);
    const instance = hook();
    instance.rerender({ org: 'org-two', user: 'user-one' }); await ready(instance);
    await act(async () => { script.reject(new Error('old-scope-script-error')); await script.promise.catch(() => {}); });
    expect(instance.result.current.authReady).toBe(true); expect(instance.result.current.error).toBeNull();
  });
  it('does not reuse readiness from a previous organization while its new preparation is pending', async () => {
    const instance = hook(); await ready(instance);
    const script = deferred<void>(); external.load.mockReturnValueOnce(script.promise);
    instance.rerender({ org: 'org-two', user: 'user-one' });
    expect(instance.result.current.authReady).toBe(false);
    await act(async () => { await instance.result.current.connect(); }); expect(external.authorize).not.toHaveBeenCalled();
    await act(async () => { script.resolve(); await script.promise; }); expect(instance.result.current.authReady).toBe(true);
  });
  it('resets cursor and failure metadata when a different Gmail account connects', async () => {
    const instance = hook(); await connect(instance); await search(instance);
    external.profile.mockResolvedValueOnce('fixture-two@example.test'); await connect(instance);
    expect(instance.result.current).toMatchObject({ mailbox: 'fixture-two@example.test', bills: [], failedCount: 0, searched: false, nextPageToken: null });
    expect(instance.result.current.imported.size).toBe(0);
  });
  it('shows a rejected Gmail session with an explicit reconnection path', async () => {
    external.list.mockRejectedValueOnce(new Error('Google không chấp nhận phiên Gmail. Vui lòng kết nối lại.'));
    const instance = hook(); await connect(instance); await search(instance);
    expect(instance.result.current.error).toMatch(/kết nối lại/); expect(instance.result.current.busy).toBe(false);
    await connect(instance); expect(instance.result.current.error).toBeNull();
    await search(instance); expect(instance.result.current.bills).toEqual([bill]);
  });
  it('discards a pending search when the session expires on a later user action', async () => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    external.authorize.mockResolvedValueOnce({ accessToken: 'synthetic-token', expiresAt: now + 100 });
    const listing = deferred<GmailBillPage>(); external.list.mockReturnValueOnce(listing.promise);
    const instance = hook(); await connect(instance); let old!: Promise<void>;
    act(() => { old = instance.result.current.search(range); });
    const signal = external.list.mock.calls[0][4] as AbortSignal;
    vi.mocked(Date.now).mockReturnValue(now + 101); await search(instance);
    expect(signal.aborted).toBe(true); expect(instance.result.current.busy).toBe(false);
    await act(async () => { listing.resolve(page); await old; });
    expect(instance.result.current.bills).toEqual([]); expect(external.lookup).not.toHaveBeenCalled();
  });
});
