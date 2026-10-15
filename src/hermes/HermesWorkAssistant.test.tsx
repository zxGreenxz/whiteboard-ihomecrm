// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesWorkAssistant } from './HermesWorkAssistant';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: async () => ({
  data: { session: { user: { id: '11111111-1111-4111-8111-111111111111' }, access_token: 'fixture.browser.jwt' } }, error: null,
}) } } }));
const USER = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222', OTHER = '55555555-5555-4555-8555-555555555555';
const NOTE = '66666666-6666-4666-8666-666666666666', FOLLOW_A = '77777777-7777-4777-8777-777777777777', FOLLOW_B = '88888888-8888-4888-8888-888888888888';
const NOW = '2026-10-15T10:00:00+00:00';
const scope = { userId: USER, organizationId: ORG, generation: 0 }, currentScope = () => scope;
const rpcFail = (code: string, status: number) => Response.json({ code, message: 'PRIVATE', details: null, hint: null }, { status });

interface Note { id: string; key: string; content: string; version: number }
let notes: Note[], settings: { enabled: boolean; sharing: 'owner' | 'superadmin' | 'managers'; retentionDays: number; accessVersion: number };
let failures: Record<string, Response | undefined>, fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

const follow = (id: string, over: Record<string, unknown>) => ({ id, version: 4, state: 'active', closeReason: null, objective: 'Chụp ảnh nghiệm thu', jobId: null,
  jobCode: 'CV-1', jobTitle: 'Sửa điều hòa', jobStatus: 'IN_PROGRESS', deadline: NOW, overdue: false, assignerUserId: USER, assignerName: 'Tôi',
  executorUserId: OTHER, executorName: 'Thợ An', mode: 'supervisor', depth: 0, remindBeforeMinutes: 30, notifyAssigner: true,
  createdAt: NOW, updatedAt: NOW, closedAt: null, ...over });
const byMe = () => [follow(FOLLOW_A, { jobCode: 'CV-1', overdue: true }), follow(FOLLOW_B, { jobCode: 'CV-2', jobTitle: 'Thay khóa', state: 'cancelled', closeReason: 'stopped' })];

async function respond(url: RequestInfo | URL, init?: RequestInit) {
  const rpc = String(url).split('/rpc/')[1], input = JSON.parse(init!.body as string) as { p_input?: Record<string, unknown> };
  const failure = failures[rpc]; if (failure) return failure.clone();
  const base = { organizationId: ORG };
  if (rpc === 'hermes_my_work_memory_v1') return Response.json({ ...base, ownerUserId: USER, settings, personalMemory: 'outside_crm', remoteCopies: 'not_revocable',
    items: notes.map(note => ({ ...note, assistantId: 'hermes-1', connectionId: 'conn-1', source: { channel: 'external_mcp', label: 'Hermes của tôi' },
      createdAt: NOW, updatedAt: NOW, expiresAt: '2026-11-15T10:00:00+00:00' })), offset: 0, nextOffset: null, total: notes.length });
  if (rpc === 'hermes_my_work_memory_configure_v1') {
    const { enabled, sharing, retentionDays, expectedAccessVersion } = input.p_input as typeof settings & { expectedAccessVersion: number };
    if (settings.accessVersion !== expectedAccessVersion) return rpcFail('PT409', 409);
    settings = { enabled, sharing, retentionDays, accessVersion: settings.accessVersion + 1 };
    return Response.json({ ...base, ownerUserId: USER, settings, personalMemory: 'outside_crm', remoteCopies: 'not_revocable' });
  }
  if (rpc === 'hermes_my_work_memory_edit_v1') {
    const note = notes.find(item => item.id === input.p_input!.id)!;
    if (note.version !== input.p_input!.expectedVersion) return rpcFail('PT409', 409);
    note.content = input.p_input!.content as string; note.version++;
    return Response.json({ ...base, ownerUserId: USER, id: note.id, key: note.key, version: note.version, expiresAt: NOW });
  }
  if (rpc === 'hermes_my_work_memory_forget_v1') {
    notes = notes.filter(item => item.id !== input.p_input!.id);
    return Response.json({ ...base, ownerUserId: USER, id: input.p_input!.id, forgotten: true, auditRetained: true, remoteCopies: 'not_revocable' });
  }
  if (rpc === 'hermes_my_task_follows_v1') {
    const { role, state } = input.p_input as { role: string; state: string };
    const items = role !== 'assigned_by_me' ? [follow(FOLLOW_B, { jobCode: 'CV-9', jobTitle: 'Giao cho tôi', assignerUserId: OTHER, assignerName: 'Chị Lan' })]
      : byMe().filter(item => state === 'active' ? item.state === 'active' : item.state !== 'active');
    return Response.json({ ...base, userId: USER, role, state, items, offset: 0, nextOffset: null });
  }
  if (rpc === 'hermes_my_task_follow_stop_v1') return Response.json({ ...base, userId: USER, id: input.p_input!.followId, version: 5, state: 'cancelled', closeReason: 'stopped' });
  throw new Error('unexpected_fixture_rpc');
}
beforeEach(() => {
  scope.generation = 0; failures = {};
  notes = [{ id: NOTE, key: 'khach_vip', content: 'Khách thích phòng tầng cao', version: 2 }];
  settings = { enabled: true, sharing: 'owner', retentionDays: 30, accessVersion: 3 };
  fetchMock = vi.fn<typeof globalThis.fetch>(respond); vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co'); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_fixture');
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const view = (extra = {}) => <StrictMode><HermesWorkAssistant userId={USER} organizationId={ORG} currentScope={currentScope} {...extra} /></StrictMode>;
const writes = (rpc: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/' + rpc));
const show = () => { render(view()); fireEvent.click(screen.getByRole('button', { name: 'Mở trợ lý của tôi' })); };

describe('Trợ lý của tôi', () => {
  it('reads nothing until the user opens the section', async () => {
    render(view());
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Mở trợ lý của tôi' }));
    await screen.findByRole('article', { name: 'Ghi chú khach_vip' });
    expect(fetchMock).toHaveBeenCalled();
  });
  it('shows CRM work notes and separates them from Hermes personal memory outside the CRM', async () => {
    show();
    const note = await screen.findByRole('article', { name: 'Ghi chú khach_vip' });
    expect(within(note).getByText('Khách thích phòng tầng cao')).toBeTruthy();
    expect(within(note).getByText(/Hermes của tôi/)).toBeTruthy();
    expect(screen.getByText(/do bạn quản lý ngoài CRM/)).toBeTruthy();
    expect(screen.getByText(/không xoá được bản đã chuyển tới Hermes/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /duyệt|PIN/i })).toBe(null);
  });
  it('edits with the version that was visible when editing started and then reloads the list', async () => {
    show(); await screen.findByRole('article', { name: 'Ghi chú khach_vip' });
    fireEvent.click(screen.getByRole('button', { name: 'Sửa ghi chú khach_vip' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Nội dung ghi chú khach_vip' }), { target: { value: 'Khách thích phòng yên tĩnh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu ghi chú' }));
    await screen.findByText('Đã cập nhật ghi chú.'); await screen.findByText('Khách thích phòng yên tĩnh');
    expect(JSON.parse(writes('hermes_my_work_memory_edit_v1')[0][1]!.body as string)).toEqual({ p_org: ORG, p_input: { id: NOTE, expectedVersion: 2, content: 'Khách thích phòng yên tĩnh' } });
    expect(writes('hermes_my_work_memory_edit_v1')).toHaveLength(1);
  });
  it('refuses a multi-line edit locally', async () => {
    show(); await screen.findByRole('article', { name: 'Ghi chú khach_vip' });
    fireEvent.click(screen.getByRole('button', { name: 'Sửa ghi chú khach_vip' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Nội dung ghi chú khach_vip' }), { target: { value: 'dòng 1\ndòng 2' } });
    expect((screen.getByRole('button', { name: 'Lưu ghi chú' }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes('hermes_my_work_memory_edit_v1')).toHaveLength(0);
  });
  it('asks for confirmation before forgetting a note', async () => {
    show(); await screen.findByRole('article', { name: 'Ghi chú khach_vip' });
    fireEvent.click(screen.getByRole('button', { name: 'Quên ghi chú khach_vip' }));
    const dialog = await screen.findByRole('alertdialog'); expect(writes('hermes_my_work_memory_forget_v1')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Quên ghi chú này' }));
    await screen.findByText(/Đã quên ghi chú/);
    expect(JSON.parse(writes('hermes_my_work_memory_forget_v1')[0][1]!.body as string)).toEqual({ p_org: ORG, p_input: { id: NOTE, expectedVersion: 2 } });
    await screen.findByText(/Chưa có ghi chú công việc nào/);
  });
  it('shows a permission error that is not an empty list, and a version conflict that reloads', async () => {
    failures.hermes_my_work_memory_v1 = rpcFail('42501', 403);
    show();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(alert => /chưa có quyền/.test(alert.textContent ?? ''))).toBe(true);
    expect(screen.queryByText(/Chưa có ghi chú công việc nào/)).toBe(null);
    cleanup(); failures = {};
    show(); await screen.findByRole('article', { name: 'Ghi chú khach_vip' });
    fireEvent.click(screen.getByRole('button', { name: 'Sửa ghi chú khach_vip' }));
    notes[0].version = 7;
    fireEvent.change(screen.getByRole('textbox', { name: 'Nội dung ghi chú khach_vip' }), { target: { value: 'Nội dung khác' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu ghi chú' }));
    await screen.findByText(/Dữ liệu đã thay đổi/);
    expect(screen.queryByText(/chưa có quyền/)).toBe(null);
    await waitFor(() => expect(writes('hermes_my_work_memory_v1').length).toBeGreaterThan(2));
    expect(writes('hermes_my_work_memory_edit_v1')).toHaveLength(1);
  });
  it('says the outcome is unknown, without resending, when a write fails after dispatch', async () => {
    show(); await screen.findByRole('article', { name: 'Ghi chú khach_vip' });
    failures.hermes_my_work_memory_forget_v1 = rpcFail('XX000', 500);
    fireEvent.click(screen.getByRole('button', { name: 'Quên ghi chú khach_vip' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Quên ghi chú này' }));
    await screen.findByText(/Kết quả chưa xác định/);
    expect(writes('hermes_my_work_memory_forget_v1')).toHaveLength(1);
  });
  it('saves settings with the access version just read', async () => {
    show(); await screen.findByRole('article', { name: 'Ghi chú khach_vip' });
    const save = screen.getByRole('button', { name: 'Lưu cài đặt' }) as HTMLButtonElement; expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Số ngày lưu (1–365)'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(save);
    await screen.findByText('Đã lưu cài đặt ghi nhớ công việc.');
    expect(writes('hermes_my_work_memory_configure_v1')).toHaveLength(1);
    expect(JSON.parse(writes('hermes_my_work_memory_configure_v1')[0][1]!.body as string)).toEqual({ p_org: ORG,
      p_input: { enabled: false, sharing: 'owner', retentionDays: 90, expectedAccessVersion: 3 } });
  });
  it('lists followed jobs with overdue and shows stop only on active jobs I assigned', async () => {
    show();
    const job = await screen.findByRole('article', { name: 'Việc CV-1' });
    expect(within(job).getByText('Quá hạn')).toBeTruthy(); expect(within(job).getByText('Đang làm')).toBeTruthy();
    expect(within(job).getByText(/Thợ An/)).toBeTruthy(); expect(within(job).getByText(/Nhắc trước 30 phút/)).toBeTruthy();
    fireEvent.click(within(job).getByRole('button', { name: 'Dừng theo dõi CV-1' }));
    await screen.findByText(/Đã dừng theo dõi/);
    expect(JSON.parse(writes('hermes_my_task_follow_stop_v1')[0][1]!.body as string)).toEqual({ p_org: ORG, p_input: { followId: FOLLOW_A, expectedVersion: 4 } });
    fireEvent.click(screen.getByRole('button', { name: 'Đã đóng' }));
    const closed = await screen.findByRole('article', { name: 'Việc CV-2' });
    expect(within(closed).queryByRole('button', { name: /Dừng theo dõi/ })).toBe(null);
    fireEvent.click(screen.getByRole('button', { name: 'Đang theo dõi' })); fireEvent.click(screen.getByRole('button', { name: 'Giao cho tôi' }));
    const assigned = await screen.findByRole('article', { name: 'Việc CV-9' });
    expect(within(assigned).queryByRole('button', { name: /Dừng theo dõi/ })).toBe(null);
  });
  it('renders the reconcile slot when provided', async () => {
    render(view({ reconcileSlot: <p>Đối soát kết quả chưa rõ</p> }));
    expect(await screen.findByText('Đối soát kết quả chưa rõ')).toBeTruthy();
  });
});
