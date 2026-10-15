// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesDeliveryReconcile } from './HermesDeliveryReconcile';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: async () => ({
  data: { session: { user: { id: '11111111-1111-4111-8111-111111111111' }, access_token: 'fixture.browser.jwt' } }, error: null,
}) } } }));
const USER = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333', CONV = '44444444-4444-4444-8444-444444444444', RECORD = '55555555-5555-4555-8555-555555555555';
const URL = 'https://abcdefghijklmnopqrst.supabase.co';
const scope = { userId: USER, organizationId: ORG, generation: 0 }, currentScope = () => scope;
const unknownItem = () => ({ kind: 'queue_job', id: JOB, origin: 'hermes_schedule', scheduleId: RECORD, conversationId: CONV, conversationName: 'Nhóm sale Quận 7',
  preview: 'BẢN TIN PHÒNG TRỐNG', errorCode: 'UNKNOWN_EFFECT', createdAt: '2026-10-15T01:00:00.000Z', processedAt: '2026-10-15T01:01:00.000Z' });
let items: ReturnType<typeof unknownItem>[], writes: unknown[], writeReply: (body: { p: Record<string, string> }) => Response;
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
const acknowledged = (p: Record<string, string>) => Response.json({ organizationId: ORG, userId: USER, reconciliation: { id: RECORD, kind: p.kind,
  targetId: p.targetId, decision: p.decision, note: p.note, via: 'crm_ui', createdAt: '2026-10-15T02:00:00.000Z' } });
async function respond(path: RequestInfo | URL, init?: RequestInit) {
  const body = JSON.parse(init!.body as string);
  if (String(path).endsWith('/hermes_delivery_reconcile_list_v1')) return Response.json({ organizationId: ORG, userId: USER, canManage: true, items, recent: [] });
  if (String(path).endsWith('/hermes_delivery_reconcile_resolve_v1')) { writes.push(body); return writeReply(body); }
  throw new Error('unexpected_fixture_route');
}
beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', URL); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_fixture');
  scope.generation = 0; items = [unknownItem()]; writes = [];
  writeReply = body => { items = []; return acknowledged(body.p); };
  fetchMock = vi.fn<typeof globalThis.fetch>(respond); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const view = () => <HermesDeliveryReconcile userId={USER} organizationId={ORG} currentScope={currentScope} />;
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra tin chưa rõ kết quả' }));
  return screen.findByRole('article', { name: 'Tin chưa rõ: Lịch Hermes · Nhóm sale Quận 7' });
}
function attest(decision: string, note: string) {
  fireEvent.click(screen.getByRole('button', { name: decision }));
  fireEvent.change(screen.getByLabelText('Ghi chú kiểm tra'), { target: { value: note } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Ghi nhận' }));
}

describe('UNKNOWN_EFFECT reconciliation panel', () => {
  it('reads only when opened and records an explicit, noted human attestation without any resend', async () => {
    render(<StrictMode>{view()}</StrictMode>);
    expect(fetchMock).not.toHaveBeenCalled();
    const article = await open();
    expect(within(article).getByText('BẢN TIN PHÒNG TRỐNG')).toBeTruthy();
    fireEvent.click(within(article).getByRole('button', { name: 'Chưa tới nơi' }));
    expect((screen.getByRole('button', { name: 'Ghi nhận' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Ghi chú kiểm tra'), { target: { value: 'Đã xem nhóm lúc 9 giờ, không thấy tin' } });
    expect((screen.getByRole('button', { name: 'Ghi nhận' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Ghi nhận' }));
    await screen.findByText(/Đã ghi nhận: tin chưa tới nơi\. Hệ thống không tự gửi lại/);
    await screen.findByText('Không có tin nào đang chờ đối soát.');
    expect(writes).toHaveLength(1);
    const p = (writes[0] as { p: Record<string, string> }).p;
    expect(p).toMatchObject({ organizationId: ORG, kind: 'queue_job', targetId: JOB, decision: 'not_sent', note: 'Đã xem nhóm lúc 9 giờ, không thấy tin' });
    expect(p.requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(fetchMock.mock.calls.every(([path]) => /hermes_delivery_reconcile_(list|resolve)_v1$/.test(String(path)))).toBe(true);
  });
  it('a lost write reply is shown as unknown and may only be repeated with the same request ID', async () => {
    writeReply = () => Response.json({ error: 'gateway' }, { status: 502 });
    render(view()); await open();
    attest('Đã tới nơi', 'Thấy tin trong nhóm');
    await screen.findByText(/Chưa rõ máy chủ đã ghi nhận xác nhận này chưa/);
    expect((screen.getByRole('button', { name: 'Đã tới nơi' }) as HTMLButtonElement).disabled).toBe(true);
    writeReply = body => { items = []; return acknowledged(body.p); };
    fireEvent.click(screen.getByRole('button', { name: 'Ghi lại với cùng mã' }));
    await screen.findByText('Đã ghi nhận: tin đã tới nơi.');
    expect(writes).toHaveLength(2);
    expect((writes[1] as { p: unknown }).p).toEqual((writes[0] as { p: unknown }).p);
  });
  it('shows a permission denial instead of an empty list and an already settled job as a conflict', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ code: '42501', message: 'PRIVATE', details: null, hint: null }, { status: 403 }));
    render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra tin chưa rõ kết quả' }));
    await screen.findByText(/chưa có quyền xem đối soát/);
    expect(screen.queryByText('Không có tin nào đang chờ đối soát.')).toBe(null);
    cleanup(); render(view()); await open();
    writeReply = () => { items = []; return Response.json({ code: 'PT409', message: 'hermes_reconcile_already_resolved', details: null, hint: null }, { status: 409 }); };
    attest('Đã tới nơi', 'Thấy tin trong nhóm');
    await screen.findByText(/đã được ghi nhận hoặc không còn ở trạng thái chưa rõ/);
    await screen.findByText('Không có tin nào đang chờ đối soát.');
    expect(screen.queryByRole('button', { name: 'Ghi lại với cùng mã' })).toBe(null);
  });
  it('discards a late reply after the account/company scope changed', async () => {
    let release: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra tin chưa rõ kết quả' }));
    scope.generation++;
    release(Response.json({ organizationId: ORG, userId: USER, canManage: true, items, recent: [] }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByRole('article')).toBe(null);
  });
});
