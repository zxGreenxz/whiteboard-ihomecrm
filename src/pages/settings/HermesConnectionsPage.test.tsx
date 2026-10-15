// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HermesConnectionsPage from './HermesConnectionsPage';
import type { HermesOrgPolicySnapshot } from '@/hermes/orgPolicyClient';

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
const STARTED = Date.UTC(2026, 9, 15, 1, 0, 0), SUCCESS = Date.UTC(2026, 9, 15, 2, 0, 0), TOOL = Date.UTC(2026, 9, 15, 2, 5, 0), FAILED = Date.UTC(2026, 9, 15, 2, 10, 0);
const at = (value: number) => new Date(value).toLocaleString('vi-VN');
const statusFixture = (connections: object[] = []) => ({ connector: { version: '1.4.0', startedAt: STARTED, observedAt: FAILED + 1000 }, connections });
let statusBody: ReturnType<typeof statusFixture> | null;
let rows: ReturnType<typeof row>[];
let companyPolicy: HermesOrgPolicySnapshot;
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let writeClipboard: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
async function respond(path: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const input = JSON.parse(init!.body as string), operation = String(path).split('/').at(-1);
  if (['hermes_org_policy_options_v7', 'hermes_org_policy_options_v6', 'hermes_org_policy_options_v5', 'hermes_org_policy_options_v4', 'hermes_org_policy_options_v3', 'hermes_org_policy_options_v2', 'hermes_org_policy_options_v1'].includes(operation ?? '')) return json(companyPolicy);
  if (operation === 'hermes_set_org_policy_v1') {
    companyPolicy.policy = { organizationId: ORG, version: input.p_expected_version + 1,
      enabled: input.p_enabled, read: input.p_read, action: input.p_action, scopeIds: input.p_scope_ids };
    return json(companyPolicy.policy);
  }
  if (String(path).startsWith('/api/hermes/zalo/')) return json({ userId: identity.userId, organizationId: input.organizationId,
    status: 'listed', nextCursor: null, ...(operation === 'bots' ? { bots: [] } : { bindings: [] }) });
  const own = rows.filter(value => value.userId === identity.userId && value.organizationId === input.organizationId);
  if (operation === 'list') return json({ connections: own });
  if (operation === 'status') return statusBody === null ? json({ error: 'not_found' }, 404) : json(statusBody);
  if (operation === 'options') return json({ options: { userId: identity.userId, organizationId: input.organizationId, membershipId: OTHER,
    authorizationVersion: 1, isSuperadmin: false, policyVersion: companyPolicy.policy.version, enabled: companyPolicy.policy.enabled,
    read: companyPolicy.policy.enabled ? companyPolicy.policy.read : [], action: companyPolicy.policy.enabled ? companyPolicy.policy.action : [],
    scopes: companyPolicy.policy.enabled && (companyPolicy.policy.read.includes('rooms.view') || companyPolicy.policy.action.includes('sale_phong.manage_pass_listings') || companyPolicy.policy.action.includes('tasks.create') || companyPolicy.policy.action.includes('customers.create')) ? companyPolicy.choices.scopes.filter(scope => companyPolicy.policy.scopeIds.includes(scope.scopeId)) : [] } });
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
  companyPolicy = { userId: USER, organizationId: ORG, membershipId: OTHER, authorizationVersion: 1, isSuperadmin: false,
    policy: { organizationId: ORG, version: 1, enabled: true, read: ['assistant.context.read', 'rooms.view'], action: [], scopeIds: [SCOPE] },
    choices: { read: ['assistant.context.read', 'rooms.view'], action: [],
      scopes: [{ scopeId: SCOPE, scopeType: 'BUILDING', label: 'Toà: Nhà A', buildingId: ASSISTANT, areaId: null, cashbookId: null }] },
    storedScopes: [{ scopeId: SCOPE, label: 'Toà: Nhà A', available: true }] };
  statusBody = statusFixture(); rows = [row()]; fetchMock = vi.fn<typeof globalThis.fetch>(respond); vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_fixture');
  writeClipboard = vi.fn(async () => {}); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: writeClipboard } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Hermes self-connection page with the real typed client and fake HTTP', () => {
  it('creates a connection under neutral policy without opening or writing company settings', async () => {
    companyPolicy.policy.version = 0;
    render(<HermesConnectionsPage />); await ready();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo kết nối' }) as HTMLButtonElement).disabled).toBe(false));
    submitPassword(); await screen.findByLabelText('Mã kết nối');
    expect(calls('connect')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([path]) => /hermes_(set_org_policy|org_policy_options)_v[12]$/.test(String(path)))).toBe(false);
    expect(companyPolicy.policy.version).toBe(0);
  });
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
    expect(screen.getByText(`Connector CRM phiên bản 1.4.0 đang chạy từ ${at(STARTED)}. Thời điểm Hermes gọi CRM chỉ tính từ lần khởi động này.`)).toBeTruthy();
    expect(screen.queryByText(/chưa xác nhận Hermes đang chạy/)).toBeNull();
    expect(screen.getByText('Chưa ghi nhận Hermes gọi CRM kể từ khi connector khởi động.')).toBeTruthy();
    expect(screen.getByText(/Quyền đọc và thao tác được chọn độc lập/)).toBeTruthy();
    expect(screen.queryByText(/^Đang chạy$/)).toBeNull();
    expect(calls('list')).toHaveLength(1); expect(calls('status')).toHaveLength(1);
    expect(JSON.parse(calls('status')[0][1]!.body as string)).toEqual({ organizationId: ORG });
  });

  it('shows the last Hermes call, tool call and last error from connector memory, ignoring ids outside the list', async () => {
    statusBody = statusFixture([
      { id: CONNECTION, lastSuccessAt: SUCCESS, lastToolCallAt: TOOL, lastErrorCode: 'rate_limited', lastErrorAt: FAILED },
      { id: OTHER, lastSuccessAt: SUCCESS, lastToolCallAt: null, lastErrorCode: null, lastErrorAt: null },
    ]);
    render(<HermesConnectionsPage />); await ready();
    const card = within(screen.getByRole('article', { name: 'Kết nối 33333333' }));
    expect(card.getByText(`Hermes gọi CRM lần cuối lúc ${at(SUCCESS)} · dùng công cụ CRM lần cuối lúc ${at(TOOL)}`)).toBeTruthy();
    expect(card.getByText(`Lỗi gần nhất lúc ${at(FAILED)}: gọi quá nhiều lần trong một phút`)).toBeTruthy();
    expect(card.queryByText(/Chưa ghi nhận Hermes gọi CRM/)).toBeNull();
    expect(screen.getAllByText(/Hermes gọi CRM lần cuối lúc/)).toHaveLength(1);
  });

  it('labels outcome-unknown and unmapped error codes without inventing a success time', async () => {
    statusBody = statusFixture([{ id: CONNECTION, lastSuccessAt: null, lastToolCallAt: null, lastErrorCode: 'rooms_update_outcome_unknown', lastErrorAt: FAILED }]);
    const view = render(<HermesConnectionsPage />); await ready();
    expect(screen.getByText(`Lỗi gần nhất lúc ${at(FAILED)}: chưa xác định kết quả thao tác`)).toBeTruthy();
    expect(screen.getByText('Chưa ghi nhận Hermes gọi CRM kể từ khi connector khởi động.')).toBeTruthy();
    statusBody = statusFixture([{ id: CONNECTION, lastSuccessAt: null, lastToolCallAt: null, lastErrorCode: 'weird_code', lastErrorAt: FAILED }]);
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' }));
    await screen.findByText(`Lỗi gần nhất lúc ${at(FAILED)}: weird_code`); view.unmount();
  });

  it('falls back to stored records when the connector has no status operation, keeping the list and grant form usable', async () => {
    statusBody = null;
    render(<HermesConnectionsPage />); await ready();
    expect(screen.getByText('Chưa đọc được trạng thái connector CRM; trạng thái dưới đây là hồ sơ đã lưu.')).toBeTruthy();
    expect(screen.queryByText(/Chưa ghi nhận Hermes gọi CRM/)).toBeNull();
    expect(screen.getByText(/Đã cấp kết nối · 2 quyền đọc · 1 quyền thao tác/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo kết nối' }) as HTMLButtonElement).disabled).toBe(false));
    statusBody = statusFixture(); fireEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' }));
    await screen.findByText(/Connector CRM phiên bản 1.4.0/);
    expect(screen.queryByText(/Chưa đọc được trạng thái connector CRM/)).toBeNull();
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
    fireEvent.change(within(reads).getByPlaceholderText(/Tìm quyền/), { target: { value: 'rooms.view' } });
    fireEvent.change(within(actions).getByPlaceholderText(/Tìm quyền/), { target: { value: 'rooms.edit' } });
    expect(within(reads).getAllByRole('checkbox')).toHaveLength(2); expect(within(actions).getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(within(reads).getAllByRole('checkbox')[1]); fireEvent.click(within(actions).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu giới hạn' }));
    await screen.findByText('Đã lưu giới hạn mới. Mở lại quyền để xem hiệu lực hiện tại.');
    expect(JSON.parse(calls('restrict')[0][1]!.body as string)).toEqual({ connectionId: CONNECTION, expectedEpoch: 2,
      organizationId: ORG, restrictions: { read: ['assistant.context.read'], action: [] }, scopeIds: [SCOPE] });
    fireEvent.click(screen.getByRole('button', { name: 'Xem quyền' }));
    const narrowed = await screen.findByRole('region', { name: 'Quyền kết nối' });
    expect(within(within(narrowed).getByRole('group', { name: 'Đọc dữ liệu' })).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(within(narrowed).getByRole('group', { name: 'Thao tác dữ liệu' })).queryByRole('checkbox')).toBeNull();
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

describe('Hermes permission choices use shared pickers without changing CRM permissions', () => {
  it('selects rooms and a real allowed scope, and picker buttons never accidentally submit credentials', async () => {
    render(<HermesConnectionsPage />); await ready();
    const form = within(screen.getByRole('region', { name: 'Cấp quyền Hermes mới' }));
    const reads = within(form.getByRole('group', { name: 'Đọc dữ liệu' }));
    fireEvent.change(reads.getByPlaceholderText(/Tìm quyền/), { target: { value: 'rooms.view' } });
    fireEvent.click(reads.getAllByRole('checkbox')[1]);
    expect((form.getByRole('button', { name: 'Tạo kết nối' }) as HTMLButtonElement).disabled).toBe(true);
    expect(form.getByText(/Chọn ít nhất một phạm vi/)).toBeTruthy();
    fireEvent.click(form.getByRole('checkbox', { name: 'Nhà A' }));
    expect((form.getByRole('button', { name: 'Tạo kết nối' }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls('connect')).toHaveLength(0);
    expect(within(form.getByRole('group', { name: 'Thao tác dữ liệu' })).queryByRole('checkbox')).toBeNull();
    submitPassword(); await screen.findByLabelText('Mã kết nối');
    expect(JSON.parse(calls('connect')[0][1]!.body as string)).toMatchObject({
      restrictions: { read: ['assistant.context.read', 'rooms.view'], action: [] }, scopeIds: [SCOPE],
    });
  });
  it('narrows the stored scope using the current connection epoch without changing CRM role APIs', async () => {
    render(<HermesConnectionsPage />); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Xem quyền' }));
    const rights = within(await screen.findByRole('region', { name: 'Quyền kết nối' }));
    fireEvent.click(rights.getByRole('checkbox', { name: 'Nhà A' }));
    fireEvent.click(rights.getByRole('button', { name: 'Lưu giới hạn' }));
    await screen.findByText('Đã lưu giới hạn mới. Mở lại quyền để xem hiệu lực hiện tại.');
    expect(JSON.parse(calls('restrict')[0][1]!.body as string)).toMatchObject({ expectedEpoch: 2, scopeIds: [] });
    expect(fetchMock.mock.calls.every(([path]) => String(path).startsWith('/api/hermes/'))).toBe(true);
  });
  it('keeps existing connection control available when grant choices are unavailable, while enrollment stays disabled', async () => {
    fetchMock.mockImplementation((path, init) => String(path).endsWith('/options') ? Promise.resolve(json({ error: { code: 'backend_unavailable' } }, 503)) : respond(path, init));
    render(<HermesConnectionsPage />); await ready();
    expect(screen.getByText(/Chưa đọc được danh sách quyền và phạm vi/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Tạo kết nối' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Xem quyền' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Xem quyền' }));
    const rights = within(await screen.findByRole('region', { name: 'Quyền kết nối' }));
    expect(rights.getByText(/Phạm vi đã lưu/)).toBeTruthy();
    fireEvent.click(rights.getByRole('checkbox', { name: /Phạm vi đã lưu/ }));
    fireEvent.click(rights.getByRole('button', { name: 'Lưu giới hạn' }));
    await screen.findByText('Đã lưu giới hạn mới. Mở lại quyền để xem hiệu lực hiện tại.');
    expect(JSON.parse(calls('restrict')[0][1]!.body as string).scopeIds).toEqual([]);
  });
  it('drops delayed choices and selected room scope after a company switch', async () => {
    const delay = pending<Response>();
    let delayA = false;
    fetchMock.mockImplementation((path, init) => String(path).endsWith('/options') && delayA && JSON.parse(init!.body as string).organizationId === ORG ? delay.promise : respond(path, init));
    const view = render(<HermesConnectionsPage />); await ready();
    const create = within(screen.getByRole('region', { name: 'Cấp quyền Hermes mới' }));
    fireEvent.click(create.getByRole('checkbox', { name: 'Nhà A' }));
    delayA = true; fireEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' }));
    await waitFor(() => expect(calls('options')).toHaveLength(2));
    identity.organizationId = OTHER; view.rerender(<HermesConnectionsPage />);
    await screen.findByText('Chưa có kết nối Hermes trong công ty này.');
    await act(async () => delay.resolve(await respond('/api/hermes/connections/options', { body: JSON.stringify({ organizationId: ORG }) })));
    expect((screen.getByRole('checkbox', { name: 'Nhà A' })).getAttribute('aria-checked')).toBe('false');
    expect(calls('connect')).toHaveLength(0);
  });
});

describe('mounted company policy invalidates connection authority', () => {
  async function policyEditor() {
    const editor = within(screen.getByRole('region', { name: 'Chính sách Hermes của công ty' }));
    fireEvent.click(editor.getByRole('button', { name: 'Cấu hình chính sách công ty' }));
    await editor.findByRole('checkbox', { name: 'Bật Hermes cho công ty' });
    return editor;
  }
  const policyWrites = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/hermes_set_org_policy_v1'));

  it('mounts real permission/scope pickers, saves the human-selected ceiling, and reads fresh choices without enrolling', async () => {
    render(<HermesConnectionsPage />); await ready();
    const editor = await policyEditor();
    const reads = within(editor.getByRole('group', { name: 'Đọc dữ liệu' }));
    fireEvent.change(reads.getByPlaceholderText(/Tìm quyền/), { target: { value: 'rooms.view' } });
    expect(reads.getAllByRole('checkbox').at(-1)!.getAttribute('aria-checked')).toBe('true');
    expect(within(editor.getByRole('group', { name: 'Thao tác dữ liệu' })).queryByRole('checkbox')).toBeNull();
    fireEvent.click(editor.getByRole('checkbox', { name: 'Nhà A' }));
    fireEvent.click(reads.getAllByRole('checkbox').at(-1)!);
    fireEvent.click(editor.getByRole('button', { name: 'Lưu chính sách Hermes' }));
    await editor.findByText('Đã lưu chính sách Hermes của công ty. Tải lại để tiếp tục chỉnh sửa.');
    await waitFor(() => expect(calls('options')).toHaveLength(2));
    expect(JSON.parse(policyWrites()[0][1]!.body as string)).toEqual({ p_org: ORG, p_expected_version: 1,
      p_enabled: true, p_read: ['assistant.context.read'], p_action: [], p_scope_ids: [] });
    expect(policyWrites()).toHaveLength(1); expect(calls('connect')).toHaveLength(0);
    const create = within(screen.getByRole('region', { name: 'Cấp quyền Hermes mới' }));
    expect(create.queryByRole('checkbox', { name: 'Nhà A' })).toBeNull();
    expect((create.getByRole('button', { name: 'Tạo kết nối' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears existing authority before policy ACK and keeps it cleared until readback settles', async () => {
    const options = pending<Response>(), policyAck = pending<void>(); let reloading = false;
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path), base = { userId: USER, organizationId: ORG };
      if (url.endsWith('/zalo/bots')) return json({ ...base, status: 'listed', nextCursor: null, bots: [{ accountId: ASSISTANT, name: 'Nick phụ', zaloUid: '12345' }] });
      if (url.endsWith('/zalo/begin')) return json({ ...base, status: 'waiting', challengeId: NEW, challenge: 'hz_' + 'a'.repeat(64),
        accountId: ASSISTANT, connectionId: CONNECTION, expiresAt: Date.now() + 300000 });
      if (url.endsWith('/hermes_set_org_policy_v1')) { const response = await respond(path, init); reloading = true; await policyAck.promise; return response; }
      if (url.endsWith('/connections/options') && reloading) return options.promise;
      return respond(path, init);
    });
    render(<HermesConnectionsPage />); await ready(); submitPassword(); await screen.findByLabelText('Mã kết nối');
    fireEvent.click(within(screen.getByRole('article', { name: 'Kết nối 33333333' })).getByRole('button', { name: 'Xem quyền' }));
    await screen.findByRole('region', { name: 'Quyền kết nối' });
    fireEvent.change(screen.getByLabelText('1. Chọn kết nối Hermes'), { target: { value: CONNECTION } });
    fireEvent.change(screen.getByLabelText('Bot nhận tin nhắn'), { target: { value: ASSISTANT } });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo mã liên kết Zalo' })); await screen.findByLabelText('Nội dung gửi cho bot');
    const create = within(screen.getByRole('region', { name: 'Cấp quyền Hermes mới' }));
    fireEvent.click(create.getByRole('checkbox', { name: 'Nhà A' }));
    fireEvent.change(screen.getByLabelText('Xác nhận mật khẩu CRM'), { target: { value: 'discard-on-policy-change' } });
    const editor = await policyEditor();
    fireEvent.click(editor.getByRole('checkbox', { name: 'Bật Hermes cho công ty' }));
    fireEvent.click(editor.getByRole('button', { name: 'Lưu chính sách Hermes' }));
    await waitFor(() => expect(policyWrites()).toHaveLength(1));
    expect(screen.queryByLabelText('Mã kết nối')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Quyền kết nối' })).toBeNull();
    expect(screen.queryByLabelText('Nội dung gửi cho bot')).toBeNull();
    expect((screen.getByLabelText('Xác nhận mật khẩu CRM') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Tạo kết nối' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Tải lại danh sách' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls('options')).toHaveLength(1);
    await act(async () => policyAck.resolve());
    await waitFor(() => expect(calls('options')).toHaveLength(2));
    await act(async () => options.resolve(await respond('/api/hermes/connections/options', { body: JSON.stringify({ organizationId: ORG }) })));
    await screen.findByText(/Chính sách công ty đang tắt kết nối Hermes/);
    expect(calls('connect')).toHaveLength(1); expect(policyWrites()).toHaveLength(1);
  });

  it('rejects an abort-ignorant connect completion after policy changes in the same workspace and never retries it', async () => {
    const connect = pending<Response>(); let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (path, init) => {
      if (String(path).endsWith('/connections/connect')) { signal = init!.signal as AbortSignal; return connect.promise; }
      return respond(path, init);
    });
    render(<HermesConnectionsPage />); await ready();
    const editor = await policyEditor();
    submitPassword(); await waitFor(() => expect(calls('connect')).toHaveLength(1));
    fireEvent.click(editor.getByRole('checkbox', { name: 'Bật Hermes cho công ty' }));
    fireEvent.click(editor.getByRole('button', { name: 'Lưu chính sách Hermes' }));
    await screen.findByText(/Chính sách công ty đang tắt kết nối Hermes/);
    expect(signal?.aborted).toBe(true);
    await act(async () => connect.resolve(json({ status: 'active', connection: { ...row(NEW), epoch: 1,
      restrictions: { read: ['assistant.context.read'], action: [] }, scopeIds: [] }, token: OPAQUE, tokenExpiresAt: Date.now() + 900000 })));
    expect(screen.queryByLabelText('Mã kết nối')).toBeNull();
    expect(screen.queryByRole('article', { name: 'Kết nối 77777777' })).toBeNull();
    expect(calls('connect')).toHaveLength(1); expect(calls('list')).toHaveLength(2); expect(calls('options')).toHaveLength(2);
  });

  it('also withdraws stale authority after an unknown policy ACK and does not replay either write', async () => {
    fetchMock.mockImplementation(async (path, init) => {
      if (String(path).endsWith('/hermes_set_org_policy_v1')) { await respond(path, init); throw new Error('lost ACK'); }
      return respond(path, init);
    });
    render(<HermesConnectionsPage />); await ready(); submitPassword(); await screen.findByLabelText('Mã kết nối');
    const editor = await policyEditor();
    fireEvent.click(editor.getByRole('checkbox', { name: 'Bật Hermes cho công ty' }));
    fireEvent.click(editor.getByRole('button', { name: 'Lưu chính sách Hermes' }));
    await editor.findByText(/Chưa xác định kết quả lưu chính sách/);
    await screen.findByText(/Chính sách công ty đang tắt kết nối Hermes/);
    expect(screen.queryByLabelText('Mã kết nối')).toBeNull(); expect(policyWrites()).toHaveLength(1); expect(calls('connect')).toHaveLength(1);
  });
});

describe('fixed action self-enrollment through the existing page and real client',()=>{
 it('selects chat read independently and leaves send unselected',async()=>{
  companyPolicy.policy.read.push('chat_zalo.view');companyPolicy.policy.action=['chat_zalo.send'];render(<HermesConnectionsPage/>);await ready();
  const section=within(screen.getByRole('region',{name:'Cấp quyền Hermes mới'}));
  const reads=within(section.getByRole('group',{name:'Đọc dữ liệu'}));
  const actions=within(section.getByRole('group',{name:'Thao tác dữ liệu'}));
  fireEvent.click(await reads.findByRole('button',{name:/Chat Zalo/}));fireEvent.click(reads.getByRole('checkbox',{name:/Vào trang Chat Zalo/}));
  fireEvent.click(actions.getByRole('button',{name:/Chat Zalo/}));expect(actions.getByRole('checkbox',{name:/Gửi \/ soạn tin nhắn/}).getAttribute('data-state')).toBe('unchecked');
  submitPassword();await screen.findByRole('region',{name:'Mã kết nối một lần'});
  expect(JSON.parse(calls('connect')[0][1]!.body as string).restrictions).toEqual({read:['assistant.context.read','chat_zalo.view'],action:[]});
 });
 it('never preselects offered action and sends it only after explicit checkbox selection',async()=>{
  companyPolicy.policy.action=['chat_zalo.send'];render(<HermesConnectionsPage/>);await ready();
  const section=within(screen.getByRole('region',{name:'Cấp quyền Hermes mới'}));fireEvent.click(await section.findByRole('button',{name:/Chat Zalo/}));
  const checkbox=section.getByRole('checkbox',{name:/Gửi \/ soạn tin nhắn/});expect(checkbox.getAttribute('data-state')).toBe('unchecked');expect(calls('connect')).toHaveLength(0);
  fireEvent.click(checkbox);submitPassword();await screen.findByRole('region',{name:'Mã kết nối một lần'});
  expect(JSON.parse(calls('connect')[0][1]!.body as string).restrictions).toEqual({read:['assistant.context.read'],action:['chat_zalo.send']});
 });
 it('fresh options removing action clear a previous selection instead of retaining an invisible grant',async()=>{
  companyPolicy.policy.action=['chat_zalo.send'];render(<HermesConnectionsPage/>);await ready();
  const section=within(screen.getByRole('region',{name:'Cấp quyền Hermes mới'}));fireEvent.click(await section.findByRole('button',{name:/Chat Zalo/}));fireEvent.click(section.getByRole('checkbox',{name:/Gửi \/ soạn tin nhắn/}));
  companyPolicy.policy.action=[];fireEvent.click(screen.getByRole('button',{name:'Tải lại danh sách'}));await waitFor(()=>expect(calls('options')).toHaveLength(2));await waitFor(()=>expect(section.queryByRole('button',{name:/Chat Zalo/})).toBe(null));
  submitPassword();await screen.findByRole('region',{name:'Mã kết nối một lần'});expect(JSON.parse(calls('connect')[0][1]!.body as string).restrictions.action).toEqual([]);
 });
});

describe('room-pass Action enrollment',()=>{
 it('uses the existing picker, leaves Action off and requires chosen building scope with Read empty',async()=>{
  companyPolicy.policy.read=[];companyPolicy.policy.action=['sale_phong.manage_pass_listings'];
  render(<HermesConnectionsPage/>);await ready();
  const section=within(screen.getByRole('region',{name:'Cấp quyền Hermes mới'}));
  const actions=within(section.getByRole('group',{name:'Thao tác dữ liệu'}));
  fireEvent.click(await actions.findByRole('button',{name:/Sale Phòng/}));
  const checkbox=actions.getByRole('checkbox',{name:/Quản lý.*pass/i});
  expect(checkbox.getAttribute('data-state')).toBe('unchecked');expect(calls('connect')).toHaveLength(0);
  expect((screen.getByRole('button',{name:'Tạo kết nối'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(checkbox);expect((screen.getByRole('button',{name:'Tạo kết nối'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(section.getByRole('checkbox',{name:'Nhà A'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'Tạo kết nối'}) as HTMLButtonElement).disabled).toBe(false));
  submitPassword();await screen.findByRole('region',{name:'Mã kết nối một lần'});
  expect(JSON.parse(calls('connect')[0][1]!.body as string)).toMatchObject({restrictions:{read:[],action:['sale_phong.manage_pass_listings']},scopeIds:[SCOPE]});
 });
});

describe('task-create Action enrollment',()=>{
 it('uses the existing picker, leaves Action off and requires chosen building scope with Read empty',async()=>{
  companyPolicy.policy.read=[];companyPolicy.policy.action=['tasks.create'];
  render(<HermesConnectionsPage/>);await ready();
  const section=within(screen.getByRole('region',{name:'Cấp quyền Hermes mới'}));
  const actions=within(section.getByRole('group',{name:'Thao tác dữ liệu'}));
  fireEvent.click(await actions.findByRole('button',{name:/Công việc/}));
  const checkbox=actions.getByRole('checkbox',{name:/Tạo công việc/i});
  expect(checkbox.getAttribute('data-state')).toBe('unchecked');expect(calls('connect')).toHaveLength(0);
  expect((screen.getByRole('button',{name:'Tạo kết nối'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(checkbox);expect((screen.getByRole('button',{name:'Tạo kết nối'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(section.getByRole('checkbox',{name:'Nhà A'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'Tạo kết nối'}) as HTMLButtonElement).disabled).toBe(false));
  submitPassword();await screen.findByRole('region',{name:'Mã kết nối một lần'});
  expect(JSON.parse(calls('connect')[0][1]!.body as string)).toMatchObject({restrictions:{read:[],action:['tasks.create']},scopeIds:[SCOPE]});
 });
});

describe('customer/lead-create Action enrollment',()=>{
 it('shows offered Khách hàng actions unchecked and requires the Toàn tổ chức scope before connecting',async()=>{
  companyPolicy.policy.read=[];companyPolicy.policy.action=['customers.create','leads.create'];
  companyPolicy.choices.scopes=[{scopeId:SCOPE,scopeType:'ORGANIZATION',label:'Toàn tổ chức',buildingId:null,areaId:null,cashbookId:null}];
  companyPolicy.storedScopes=[{scopeId:SCOPE,label:'Toàn tổ chức',available:true}];
  render(<HermesConnectionsPage/>);await ready();
  const section=within(screen.getByRole('region',{name:'Cấp quyền Hermes mới'}));
  const actions=within(section.getByRole('group',{name:'Thao tác dữ liệu'}));
  expect(await actions.findByText('Khách hàng')).toBeTruthy();
  fireEvent.click(actions.getByRole('button',{name:/Khách hẹn/}));fireEvent.click(actions.getByRole('button',{name:/Cư dân/}));
  const customer=actions.getByRole('checkbox',{name:/Tạo cư dân/i}),lead=actions.getByRole('checkbox',{name:/Tạo khách hẹn/i});
  expect(customer.getAttribute('data-state')).toBe('unchecked');expect(lead.getAttribute('data-state')).toBe('unchecked');
  expect(actions.getAllByText(/cần phạm vi Toàn tổ chức$/,{selector:'span.block'})).toHaveLength(2);
  fireEvent.click(customer);expect((screen.getByRole('button',{name:'Tạo kết nối'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(section.getByRole('checkbox',{name:'Toàn tổ chức'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'Tạo kết nối'}) as HTMLButtonElement).disabled).toBe(false));
  submitPassword();await screen.findByRole('region',{name:'Mã kết nối một lần'});
  expect(JSON.parse(calls('connect')[0][1]!.body as string)).toMatchObject({restrictions:{read:[],action:['customers.create']},scopeIds:[SCOPE]});
 });
});
