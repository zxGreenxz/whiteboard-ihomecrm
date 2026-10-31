import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHermesLearningClient, HermesLearningError } from './learningReviewClient';

const USER = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333', P2 = '44444444-4444-4444-8444-444444444444', REQ = '55555555-5555-4555-8555-555555555555';
const URL = 'https://abcdefghijklmnopqrst.supabase.co';
const scope = { userId: USER, organizationId: ORG, generation: 0 };
const getSession = async () => ({ data: { session: { access_token: 'header.payload.signature', user: { id: USER } } }, error: null });
const item = (id = P1, extra: Record<string, unknown> = {}) => ({ id, seq: 3, kind: 'skill_crm_write', profile: 'owner', userId: USER, userName: 'Chủ',
  title: 'Skill crm-task-management: curator sửa', content: 'Dùng crm_action_run task.create', contentTruncated: false,
  source: { type: 'curator_ledger', skill: 'crm-task-management' }, detectedAt: '2026-10-31T01:30:00.123456Z', status: 'pending',
  decidedBy: null, decidedByName: null, decidedAt: null, note: null, via: null, redactedAt: null, ...extra });
const decidedItem = (id = P1, status = 'approved', note: string | null = null) => item(id, { status, decidedBy: USER, decidedByName: 'Chủ',
  decidedAt: '2026-10-31T02:00:00.000001Z', note, via: 'crm_ui' });
const audit = { profile: 'owner', userId: USER, userName: 'Chủ', generatedAt: '2026-10-31T13:40:00.000000Z', receivedAt: '2026-10-31T13:41:02.123456Z' };
const snapshot = (extra: Record<string, unknown> = {}) => ({ organizationId: ORG, canDecide: true, pendingCount: 1, pending: [item()],
  nextPendingAfterSeq: null, history: [decidedItem(P2, 'rejected', 'sai')], nextHistoryCursor: null, audits: [audit], ...extra });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
const client = () => createHermesLearningClient({ userId: USER, organizationId: ORG, currentScope: () => scope, getSession, fetch: fetchMock });
const body = (call = 0) => JSON.parse(fetchMock.mock.calls[call]![1]!.body as string);

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', URL); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_fixture');
  scope.generation = 0; fetchMock = vi.fn<typeof globalThis.fetch>(async () => json(snapshot()));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Hermes learning review client', () => {
  it('đọc danh sách bằng JWT người dùng, đúng RPC và công ty, kiểm khuôn phản hồi', async () => {
    const result = await client().review(null);
    expect(result.pending[0]?.seq).toBe(3);
    expect(result.history[0]?.status).toBe('rejected');
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(String(path)).toBe(`${URL}/rest/v1/rpc/hermes_learning_review_v1`);
    expect(body()).toEqual({ p: { organizationId: ORG, historyCursor: null, pendingAfterSeq: null } });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer header.payload.signature');
    expect(init!.redirect).toBe('error');
    expect(result.audits).toEqual([audit]);
    await client().review({ decidedAt: '2026-10-31T02:00:00.000001Z', id: P2 });
    expect(body(1)).toEqual({ p: { organizationId: ORG, historyCursor: { decidedAt: '2026-10-31T02:00:00.000001Z', id: P2 }, pendingAfterSeq: null } });
  });

  it('trang đề xuất chờ tiếp theo theo số thứ tự; trang trả số không lớn hơn mốc thì bị từ chối', async () => {
    fetchMock.mockResolvedValueOnce(json(snapshot({ pending: [item(P1, { seq: 21 })], pendingCount: 21 })));
    const next = await client().review(null, { pendingAfterSeq: 20 });
    expect(next.pending[0]?.seq).toBe(21);
    expect(body()).toEqual({ p: { organizationId: ORG, historyCursor: null, pendingAfterSeq: 20 } });
    fetchMock.mockResolvedValueOnce(json(snapshot({ pending: [item(P1, { seq: 20 })] })));
    await expect(client().review(null, { pendingAfterSeq: 20 })).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client().review(null, { pendingAfterSeq: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    // nextPendingAfterSeq phải trỏ đúng đề xuất cuối của trang
    fetchMock.mockResolvedValueOnce(json(snapshot({ nextPendingAfterSeq: 99 })));
    await expect(client().review(null)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('một dòng nội dung "lạ" mà SQL vẫn chấp nhận không làm hỏng cả danh sách', async () => {
    fetchMock.mockResolvedValueOnce(json(snapshot({ pendingCount: 0, pending: [item(P1, { content: '\n\n', title: ' ' })] })));
    const result = await client().review(null);
    expect(result.pending).toHaveLength(1);
    expect(result.pendingCount).toBe(0); // đọc trước khi lô nạp xong: hiển thị, không từ chối
  });

  it('phản hồi của công ty khác hoặc lệch khuôn không bao giờ thành danh sách', async () => {
    fetchMock.mockResolvedValueOnce(json(snapshot({ organizationId: P2 })));
    await expect(client().review(null)).rejects.toMatchObject({ code: 'invalid_response' });
    fetchMock.mockResolvedValueOnce(json(snapshot({ pending: [decidedItem()] })));
    await expect(client().review(null)).rejects.toMatchObject({ code: 'invalid_response' });
    fetchMock.mockResolvedValueOnce(json(snapshot({ pending: [item(P1, { detectedAt: '2026-10-31T01:30:00Z' })] })));
    await expect(client().review(null)).rejects.toMatchObject({ code: 'invalid_response' });
    fetchMock.mockResolvedValueOnce(json(snapshot({ pending: [item(P1, { redactedAt: '2026-10-31T02:00:00.000001Z' })] })));
    await expect(client().review(null)).rejects.toMatchObject({ code: 'invalid_response' }); // chỉ che được sau quyết định
    fetchMock.mockResolvedValueOnce(json(snapshot({ audits: [{ ...audit, generatedAt: 'hôm qua' }] })));
    await expect(client().review(null)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client().review({ decidedAt: 'hôm qua', id: P1 })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('phân biệt thiếu quyền, máy chủ chưa hỗ trợ và cần đăng nhập lại', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: '42501', message: 'x', details: null, hint: null }, 403));
    await expect(client().review(null)).rejects.toMatchObject({ code: 'forbidden', outcomeUnknown: false });
    fetchMock.mockResolvedValueOnce(json({ code: 'PGRST202', message: 'x', details: null, hint: null }, 404));
    await expect(client().review(null)).rejects.toMatchObject({ code: 'not_supported' });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }));
    await expect(client().review(null)).rejects.toMatchObject({ code: 'reauthentication_required' });
  });

  it('duyệt gửi đúng một quyết định có requestId, ghi chú đã cắt khoảng trắng; kiểm phản hồi khớp', async () => {
    fetchMock.mockResolvedValueOnce(json({ organizationId: ORG, decision: 'approve', replayed: false, proposals: [decidedItem(P1, 'approved', 'đúng quy trình')] }));
    const result = await client().decide({ requestId: REQ, proposalIds: [P1], decision: 'approve', note: '  đúng quy trình  ' });
    expect(result.proposals[0]?.status).toBe('approved');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${URL}/rest/v1/rpc/hermes_learning_decide_v1`);
    expect(body()).toEqual({ p: { organizationId: ORG, requestId: REQ, proposalIds: [P1], decision: 'approve', note: 'đúng quy trình' } });
  });

  it('từ chối đầu vào sai trước khi gửi', async () => {
    await expect(client().decide({ requestId: REQ, proposalIds: [P1, P1], decision: 'approve', note: null })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client().decide({ requestId: REQ, proposalIds: [P1], decision: 'approve', note: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client().decide({ requestId: REQ, proposalIds: [P1], decision: 'approve', note: '   ' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('xung đột là kết cục đã biết; mất phản hồi hoặc phản hồi lệch sau khi gửi là chưa rõ kết cục', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 'PT409', message: 'x', details: null, hint: null }, 409));
    await expect(client().decide({ requestId: REQ, proposalIds: [P1], decision: 'reject', note: null })).rejects.toMatchObject({ code: 'conflict', outcomeUnknown: false });
    fetchMock.mockResolvedValueOnce(json({ error: 'gateway' }, 502));
    await expect(client().decide({ requestId: REQ, proposalIds: [P1], decision: 'reject', note: null })).rejects.toMatchObject({ code: 'decision_outcome_unknown', outcomeUnknown: true });
    fetchMock.mockResolvedValueOnce(json({ organizationId: ORG, decision: 'reject', replayed: false, proposals: [decidedItem(P1, 'approved')] }));
    await expect(client().decide({ requestId: REQ, proposalIds: [P1], decision: 'reject', note: null })).rejects.toMatchObject({ code: 'decision_outcome_unknown' });
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    const error = await client().decide({ requestId: REQ, proposalIds: [P1], decision: 'reject', note: null }).catch(value => value);
    expect(error).toBeInstanceOf(HermesLearningError);
    expect(error).toMatchObject({ code: 'decision_outcome_unknown', outcomeUnknown: true });
  });

  it('đổi tài khoản/công ty giữa chừng thì bỏ kết quả', async () => {
    fetchMock.mockImplementationOnce(async () => { scope.generation = 1; return json(snapshot()); });
    await expect(client().review(null)).rejects.toMatchObject({ code: 'context_changed' });
  });
});
