// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HermesConnectionsPage from './HermesConnectionsPage';

const identity = vi.hoisted(() => ({ userId: '11111111-1111-4111-8111-111111111111', email: 'fixture@example.invalid',
  organizationId: '22222222-2222-4222-8222-222222222222' as string | null, authLoading: false, orgLoading: false }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: identity.userId ? { id: identity.userId, email: identity.email } : null,
  isLoading: identity.authLoading, isError: false }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: identity.organizationId,
  organization: { name: identity.organizationId === '22222222-2222-4222-8222-222222222222' ? 'Công ty A' : 'Công ty B' },
  isLoading: identity.orgLoading, isError: false }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: async () => ({
  data: { session: identity.userId ? { user: { id: identity.userId }, access_token: 'browser.session.signature' } : null }, error: null,
}) } } }));
vi.mock('@/components/layout/MainLayout', () => ({ default: ({ children, title, subtitle }: { children: ReactNode; title: string; subtitle: string }) =>
  <main><h1>{title}</h1><p>{subtitle}</p>{children}</main> }));

const USER = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333', ASSISTANT = '44444444-4444-4444-8444-444444444444';
const SCOPE = '55555555-5555-4555-8555-555555555555', OTHER = '66666666-6666-4666-8666-666666666666';
const NEW = '77777777-7777-4777-8777-777777777777', OPAQUE = `hc_${'a'.repeat(43)}`;
const row = (id = CONNECTION, organizationId = ORG, userId = USER) => ({ id, assistantId: ASSISTANT, organizationId, userId,
  state: 'active', epoch: 2, restrictions: { read: ['assistant.context.read', 'rooms.view'], action: ['rooms.edit'] }, scopeIds: [SCOPE] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const pending = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let rows: ReturnType<typeof row>[];
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let writeClipboard: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
async function respond(path: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const input = JSON.parse(init!.body as string), operation = String(path).split('/').at(-1);
  if (String(path).startsWith('/api/hermes/zalo/')) return json({ userId: identity.userId, organizationId: input.organizationId,
    status: 'listed', nextCursor: null, ...(operation === 'bots' ? { bots: [] } : { bindings: [] }) });
  const own = rows.filter(value => value.userId === identity.userId && value.organizationId === input.organizationId);
  if (operation === 'list') return json({ connections: own });
  if (operation === 'context') {
    const item = own.find(value => value.id === input.connectionId)!;
    return json({ context: { ...item, membershipId: OTHER, authorizationVersion: 1, isSuperadmin: false, policyVersion: 1,
      companyCeilings: row().restrictions, effective: { read: item.restrictions.read, action: [] } } });
  }
  if (operation === 'connect') {
    const item = { ...row(NEW, input.organizationId, identity.userId), epoch: 1, restrictions: input.restrictions, scopeIds: input.scopeIds };
    rows.push(item);
    return json({ status: 'active', connection: item, token: OPAQUE, tokenExpiresAt: Date.now() + 900_000 });
  }
  if (operation === 'restrict') {
    const item = { ...own.find(value => value.id === input.connectionId)!, epoch: input.expectedEpoch + 1, restrictions: input.restrictions, scopeIds: input.scopeIds };
    rows = rows.map(value => value.id === item.id ? item : value);
    return json({ ok: true, connection: item });
  }
  if (operation === 'revoke') {
    rows = rows.map(value => value.id === input.connectionId ? { ...value, state: 'revoked' } : value);
    return json({ ok: true, status: 'revoked', connectionId: input.connectionId });
  }
  throw new Error('unexpected_fixture_route');
}
const calls = (operation: string) => fetchMock.mock.calls.filter(([path]) => path === `/api/hermes/connections/${operation}`);
async function ready() { await screen.findByRole('article', { name: 'Kết nối 33333333' }); }
function submitPassword() {
  fireEvent.change(screen.getByLabelText('Xác nhận mật khẩu CRM'), { target: { value: 'ephemeral-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo kết nối' }));
}
beforeEach(() => {
  identity.userId = USER; identity.email = 'fixture@example.invalid'; identity.organizationId = ORG;
  identity.authLoading = false; identity.orgLoading = false;
  rows = [row()]; fetchMock = vi.fn<typeof globalThis.fetch>(respond); vi.stubGlobal('fetch', fetchMock);
  writeClipboard = vi.fn(async () => {}); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: writeClipboard } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Hermes self-connection page with the real typed client and fake HTTP', () => {
  it('withdraws a pending Zalo challenge and reloads available bots after company configuration changes', async () => {
    let enabled = true;
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path), base = { userId: USER, organizationId: ORG };
      const bot = { accountId: ASSISTANT, name: 'Nick phụ', zaloUid: '12345' };
      if (url.endsWith('/zalo/bots')) return json({ ...base, status: 'listed', nextCursor: null, bots: enabled ? [bot] : [] });
      if (url.endsWith('/zalo/begin')) return json({ ...base, status: 'waiting', challengeId: NEW, challenge: 'hz_' + 'a'.repeat(64),
        accountId: ASSISTANT, connectionId: CONNECTION, expiresAt: Date.now() + 300000 });
      if (url.endsWith('/zalo/manageBots')) return json({ ...base, status: 'listed', nextCursor: null, bots: [{ ...bot, connected: true, enabled, version: 1 }] });
      if (url.endsWith('/zalo/setBot')) { enabled = false; return json({ ...base, status: 'configured', accountId: ASSISTANT, enabled, version: 2 }); }
      return respond(path, init);
    });
    render(<StrictMode><HermesConnectionsPage /></StrictMode>); await ready();
    await screen.findByRole('option', { name: 'Nick phụ · 12345' });
    fireEvent.change(screen.getByLabelText('1. Chọn kết nối Hermes'), { target: { value: CONNECTION } });
    fireEvent.change(screen.getByLabelText('Bot nhận tin nhắn'), { target: { value: ASSISTANT } });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo mã liên kết Zalo' })); await screen.findByLabelText('Nội dung gửi cho bot');
    const admin = within(screen.getByRole('region', { name: 'Quản trị bot Zalo của công ty' }));
    fireEvent.click(admin.getByRole('button', { name: 'Cấu hình bot của công ty' }));
    fireEvent.click(await admin.findByRole('button', { name: 'Tắt bot' })); fireEvent.click(admin.getByRole('checkbox'));
    fireEvent.click(admin.getByRole('button', { name: 'Xác nhận đổi cấu hình' }));
    await admin.findByText('Đã tắt bot Hermes và ngắt các liên kết đang dùng bot này.');
    await waitFor(() => expect(screen.queryByLabelText('Nội dung gửi cho bot')).toBe(null));
    await screen.findByText(/Công ty chưa có bot sẵn sàng/);
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/zalo/setBot'))).toHaveLength(1);
  });
  it('shows stored connection state and self/company context, without claiming runtime health', async () => {
    render(<HermesConnectionsPage />); await ready();
    expect(screen.getByText('Kết nối của tôi tại Công ty A')).toBeTruthy();
    expect(screen.getByText(/Đã cấp kết nối · 2 quyền đọc · 1 quyền thao tác/)).toBeTruthy();
    expect(screen.getByText(/chưa xác nhận Hermes đang chạy/)).toBeTruthy();
    expect(screen.getByText(/Chưa cấp đọc phòng hay thao tác CRM/)).toBeTruthy();
    expect(screen.queryByText(/^Đang chạy$/)).toBeNull();
    expect(calls('list')).toHaveLength(1);
  });

  it('does not call HTTP or render a credential form without a selected company or finished Auth loading', async () => {
    identity.organizationId = null; const view = render(<HermesConnectionsPage />);
    expect(screen.getByText(/Chọn công ty/)).toBeTruthy(); expect(screen.queryByLabelText('Xác nhận mật khẩu CRM')).toBeNull();
    identity.organizationId = ORG; identity.authLoading = true; view.rerender(<HermesConnectionsPage />);
    expect(screen.getByText('Đang kiểm tra tài khoản và công ty…')).toBeTruthy();
    await act(async () => {}); expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows service unavailable honestly for an undeployed API and never turns that into an empty list', async () => {
    fetchMock.mockResolvedValue(new Response('<html>not deployed, private diagnostics</html>', { status: 404 }));
    render(<HermesConnectionsPage />);
    await screen.findByText(/Chưa kết nối được dịch vụ Hermes/);
    expect(screen.queryByText(/Chưa có kết nối Hermes/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Tạo kết nối' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain('private diagnostics'); expect(calls('list')).toHaveLength(1);
    fetchMock.mockImplementation(respond); fireEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' }));
    await ready(); expect(calls('list')).toHaveLength(2);
  });

  it('clears the password on submit, connects only context-read with empty scopes, and copies only on explicit click', async () => {
    render(<HermesConnectionsPage />); await ready(); submitPassword();
    expect((screen.getByLabelText('Xác nhận mật khẩu CRM') as HTMLInputElement).value).toBe('');
    const handoff = await screen.findByLabelText('Mã kết nối');
    expect((handoff as HTMLInputElement).value).toBe(OPAQUE); expect(writeClipboard).not.toHaveBeenCalled();
    expect(JSON.parse(calls('connect')[0][1]!.body as string)).toEqual({ email: identity.email, password: 'ephemeral-secret',
      organizationId: ORG, restrictions: { read: ['assistant.context.read'], action: [] }, scopeIds: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Sao chép mã' }));
    await screen.findByText('Đã sao chép mã kết nối.'); expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(OPAQUE);
    fireEvent.click(screen.getByRole('button', { name: 'Đã lưu, ẩn mã' })); expect(screen.queryByLabelText('Mã kết nối')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' }));
    await screen.findByRole('article', { name: 'Kết nối 77777777' }); expect(screen.queryByLabelText('Mã kết nối')).toBeNull();
    expect(calls('connect')).toHaveLength(1);
  });

  it.each(['company', 'account'] as const)('clears a typed password and existing handoff when switching %s', async kind => {
    const view = render(<HermesConnectionsPage />); await ready(); submitPassword(); await screen.findByLabelText('Mã kết nối');
    const oldInput = screen.getByLabelText('Xác nhận mật khẩu CRM') as HTMLInputElement;
    fireEvent.change(oldInput, { target: { value: 'not-submitted' } });
    if (kind === 'company') identity.organizationId = OTHER;
    else { identity.userId = OTHER; identity.email = 'other@example.invalid'; }
    view.rerender(<HermesConnectionsPage />);
    expect(screen.queryByLabelText('Mã kết nối')).toBeNull();
    expect(oldInput.value).toBe('');
    await screen.findByText('Chưa có kết nối Hermes trong công ty này.');
    expect((screen.getByLabelText('Xác nhận mật khẩu CRM') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('article', { name: 'Kết nối 33333333' })).toBeNull();
  });

  it('drops an in-flight connect result across A -> B -> A even when the request ignores abort', async () => {
    const delayed = pending<Response>(); let transportSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (path, init) => {
      if (String(path).endsWith('/connect')) { transportSignal = init!.signal as AbortSignal; return delayed.promise; }
      return respond(path, init);
    });
    const view = render(<HermesConnectionsPage />); await ready(); submitPassword();
    await waitFor(() => expect(calls('connect')).toHaveLength(1));
    identity.organizationId = OTHER; view.rerender(<HermesConnectionsPage />); await screen.findByText('Chưa có kết nối Hermes trong công ty này.');
    identity.organizationId = ORG; view.rerender(<HermesConnectionsPage />); await ready();
    await act(async () => { delayed.resolve(json({ status: 'active', connection: { ...row(NEW), epoch: 1, restrictions: { read: ['assistant.context.read'], action: [] }, scopeIds: [] }, token: OPAQUE, tokenExpiresAt: Date.now() + 900_000 })); });
    expect(transportSignal?.aborted).toBe(true);
    expect(screen.queryByLabelText('Mã kết nối')).toBeNull(); expect(screen.queryByRole('article', { name: 'Kết nối 77777777' })).toBeNull();
    expect(calls('connect')).toHaveLength(1);
  });

  it('aborts pending work and clears password input on unmount; remount never recovers an old opaque result', async () => {
    const delayed = pending<Response>(); let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (path, init) => { if (String(path).endsWith('/connect')) { signal = init!.signal as AbortSignal; return delayed.promise; } return respond(path, init); });
    const view = render(<HermesConnectionsPage />); await ready(); submitPassword();
    await waitFor(() => expect(calls('connect')).toHaveLength(1));
    const input = screen.getByLabelText('Xác nhận mật khẩu CRM') as HTMLInputElement;
    view.unmount(); expect(input.value).toBe(''); expect(signal?.aborted).toBe(true);
    await act(async () => { delayed.resolve(json({ status: 'active', connection: { ...row(NEW), epoch: 1, restrictions: { read: ['assistant.context.read'], action: [] }, scopeIds: [] }, token: OPAQUE, tokenExpiresAt: Date.now() + 900_000 })); });
    render(<HermesConnectionsPage />); await ready(); expect(screen.queryByLabelText('Mã kết nối')).toBeNull();
  });

  it('keeps an unknown write blocked until a manual list read, never retries it or retains the password', async () => {
    fetchMock.mockImplementation(async (path, init) => { if (String(path).endsWith('/connect')) throw new Error('lost response secret'); return respond(path, init); });
    render(<HermesConnectionsPage />); await ready(); submitPassword();
    await screen.findByText(/Chưa xác định thao tác đã hoàn tất/);
    expect(calls('connect')).toHaveLength(1); expect(calls('list')).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Tạo kết nối' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Xác nhận mật khẩu CRM') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain('lost response secret');
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' })); await ready();
    expect((screen.getByRole('button', { name: 'Tạo kết nối' }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls('connect')).toHaveLength(1); expect(calls('list')).toHaveLength(2);
  });

  it('shows read/action separately and can only narrow existing sets while keeping scope IDs and CAS epoch', async () => {
    render(<HermesConnectionsPage />); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Xem quyền' }));
    const rights = await screen.findByRole('region', { name: 'Quyền kết nối' });
    const reads = within(rights).getByRole('group', { name: 'Đọc dữ liệu' });
    const actions = within(rights).getByRole('group', { name: 'Thao tác dữ liệu' });
    expect(within(reads).getAllByRole('checkbox')).toHaveLength(2); expect(within(actions).getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(within(reads).getAllByRole('checkbox')[1]); fireEvent.click(within(actions).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu giới hạn' }));
    await screen.findByText('Đã lưu giới hạn mới. Mở lại quyền để xem hiệu lực hiện tại.');
    expect(JSON.parse(calls('restrict')[0][1]!.body as string)).toEqual({ connectionId: CONNECTION, expectedEpoch: 2,
      organizationId: ORG, restrictions: { read: ['assistant.context.read'], action: [] }, scopeIds: [SCOPE] });
    fireEvent.click(screen.getByRole('button', { name: 'Xem quyền' }));
    await screen.findByRole('region', { name: 'Quyền kết nối' }); expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryByDisplayValue(SCOPE)).toBeNull();
  });

  it('discards a late context response on account switch rather than rendering old rights', async () => {
    const delayed = pending<Response>();
    fetchMock.mockImplementation(async (path, init) => String(path).endsWith('/context') ? delayed.promise : respond(path, init));
    const view = render(<HermesConnectionsPage />); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Xem quyền' }));
    await waitFor(() => expect(calls('context')).toHaveLength(1));
    identity.userId = OTHER; view.rerender(<HermesConnectionsPage />); await screen.findByText('Chưa có kết nối Hermes trong công ty này.');
    await act(async () => { delayed.resolve(json({ context: { ...row(), membershipId: OTHER, authorizationVersion: 1, isSuperadmin: false,
      policyVersion: 1, companyCeilings: row().restrictions, effective: { read: row().restrictions.read, action: [] } } })); });
    expect(screen.queryByRole('region', { name: 'Quyền kết nối' })).toBeNull();
  });

  it('sends one explicit revoke using the row epoch, preventing double clicks while waiting', async () => {
    const delayed = pending<Response>();
    fetchMock.mockImplementation(async (path, init) => String(path).endsWith('/revoke') ? delayed.promise : respond(path, init));
    render(<HermesConnectionsPage />); await ready(); const button = screen.getByRole('button', { name: 'Thu hồi' });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(calls('revoke')).toHaveLength(1));
    expect(JSON.parse(calls('revoke')[0][1]!.body as string)).toEqual({ connectionId: CONNECTION, expectedEpoch: 2, organizationId: ORG });
    await act(async () => { delayed.resolve(json({ ok: true, status: 'revoked', connectionId: CONNECTION })); });
    await screen.findByText('Đã thu hồi kết nối.'); expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not silently sign in or write twice under React StrictMode effects', async () => {
    render(<StrictMode><HermesConnectionsPage /></StrictMode>); await ready();
    expect(calls('connect')).toHaveLength(0); submitPassword(); await screen.findByLabelText('Mã kết nối');
    expect(calls('connect')).toHaveLength(1);
  });

  it('shows a safe clipboard failure without provider details or automatic copying', async () => {
    writeClipboard.mockRejectedValueOnce(new Error('private clipboard diagnostics'));
    render(<HermesConnectionsPage />); await ready(); submitPassword(); await screen.findByLabelText('Mã kết nối');
    fireEvent.click(screen.getByRole('button', { name: 'Sao chép mã' }));
    await screen.findByText(/Chưa sao chép được/); expect(document.body.textContent).not.toContain('private clipboard diagnostics');
    expect(writeClipboard).toHaveBeenCalledTimes(1);
  });

  it('cannot carry a late clipboard confirmation or an old handoff into another company', async () => {
    const copied = pending<void>(); writeClipboard.mockReturnValueOnce(copied.promise);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const view = render(<HermesConnectionsPage />); await ready(); submitPassword(); await screen.findByLabelText('Mã kết nối');
    fireEvent.click(screen.getByRole('button', { name: 'Sao chép mã' }));
    identity.organizationId = OTHER; view.rerender(<HermesConnectionsPage />);
    await screen.findByText('Chưa có kết nối Hermes trong công ty này.');
    await act(async () => { copied.resolve(); });
    expect(screen.queryByLabelText('Mã kết nối')).toBeNull(); expect(screen.queryByText('Đã sao chép mã kết nối.')).toBeNull();
    expect(storage).not.toHaveBeenCalled(); expect(writeClipboard).toHaveBeenCalledTimes(1);
  });
});
