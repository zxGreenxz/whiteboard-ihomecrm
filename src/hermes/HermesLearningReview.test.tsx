// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesLearningReview } from './HermesLearningReview';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: async () => ({
  data: { session: { user: { id: '11111111-1111-4111-8111-111111111111' }, access_token: 'fixture.browser.jwt' } }, error: null,
}) } } }));

const USER = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333', P2 = '44444444-4444-4444-8444-444444444444', P1 = '66666666-6666-4666-8666-666666666666';
const URL = 'https://abcdefghijklmnopqrst.supabase.co';
const scope = { userId: USER, organizationId: ORG, generation: 0 }, currentScope = () => scope;
type Item = Record<string, unknown> & { id: string; status: string; seq: number };
const proposal = (id: string, seq: number, extra: Record<string, unknown> = {}): Item => ({ id, seq, kind: 'skill_crm_write', profile: 'owner', userId: USER,
  userName: 'Nguyễn Chủ', title: `Skill crm-task-management: curator sửa lúc 31/10 08:30 — bài học ghi CRM #${seq}`,
  content: 'For task creation, rediscover crm_task_create before creating a task.', contentTruncated: false,
  source: { type: 'curator_ledger', skill: 'crm-task-management', actor: 'curator', action: 'patch', sessionId: '20261017_064219_e91586aa',
    reasons: ['tool ghi crm_task_create'] },
  detectedAt: '2026-10-31T01:30:00.000000Z', status: 'pending', decidedBy: null, decidedByName: null, decidedAt: null, note: null, via: null,
  redactedAt: null, ...extra });
const decide = (item: Item, status: string, note: string | null, at = '2026-10-31T02:00:00.000001Z') => ({ ...item, status, note, decidedBy: USER,
  decidedByName: 'Quản trị', decidedAt: at, via: 'crm_ui' });
// Mốc kiểm tương đối với lúc chạy test (không ghim ngày): "vừa kiểm" và "đã quá 36 giờ".
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
const auditOf = (agoMs: number) => ({ profile: 'owner', userId: USER, userName: 'Nguyễn Chủ', generatedAt: iso(agoMs), receivedAt: iso(agoMs - 60_000) });
let pending: Item[], history: Item[], audits: unknown[], writes: { p: Record<string, unknown> }[], reviews: { p: Record<string, unknown> }[];
let writeReply: (p: Record<string, unknown>) => Response, reviewReply: ((p: Record<string, unknown>) => Response) | null;
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
const json = (value: unknown, status = 200) => Response.json(value, { status });
function applied(p: Record<string, unknown>) {
  const ids = p.proposalIds as string[], status = p.decision === 'approve' ? 'approved' : 'rejected';
  const done = pending.filter(item => ids.includes(item.id)).map(item => decide(item, status, p.note as string | null));
  pending = pending.filter(item => !ids.includes(item.id)); history = [...done, ...history];
  return json({ organizationId: ORG, decision: p.decision, replayed: false, proposals: done });
}
/** Như SQL: 20 đề xuất chờ một trang (theo số, sau pendingAfterSeq), lịch sử 20 dòng, kèm lần kiểm cuối. */
function snapshotOf(p: Record<string, unknown>) {
  const after = typeof p.pendingAfterSeq === 'number' ? p.pendingAfterSeq : 0;
  const rest = pending.filter(item => item.seq > after), page = rest.slice(0, 20);
  return { organizationId: ORG, canDecide: true, pendingCount: pending.length, pending: page,
    nextPendingAfterSeq: rest.length > 20 ? page[19]!.seq : null, history: history.slice(0, 20), nextHistoryCursor: null, audits };
}
async function respond(path: RequestInfo | URL, init?: RequestInit) {
  const body = JSON.parse(init!.body as string) as { p: Record<string, unknown> };
  if (String(path).endsWith('/hermes_learning_review_v1')) {
    reviews.push(body);
    if (reviewReply) return reviewReply(body.p);
    return json(snapshotOf(body.p));
  }
  if (String(path).endsWith('/hermes_learning_decide_v1')) { writes.push(body); return writeReply(body.p); }
  throw new Error('unexpected_fixture_route');
}
beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', URL); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_fixture');
  scope.generation = 0; pending = [proposal(P3, 3)]; history = []; audits = [auditOf(30 * 60_000)]; writes = []; reviews = [];
  writeReply = applied; reviewReply = null;
  fetchMock = vi.fn<typeof globalThis.fetch>(respond); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const view = () => <HermesLearningReview userId={USER} organizationId={ORG} currentScope={currentScope} />;

describe('Cài đặt › Hermes › Bài học chờ duyệt', () => {
  it('tự đọc khi mở tab, duyệt kèm ghi chú bằng một quyết định có requestId, rồi đọc lại', async () => {
    render(<StrictMode>{view()}</StrictMode>);
    const article = await screen.findByRole('article', { name: 'Đề xuất #3' });
    expect(within(article).getByText('For task creation, rediscover crm_task_create before creating a task.')).toBeTruthy();
    expect(within(article).getByText(/Skill crm-task-management · curator \(tự học sau phiên\) sửa · phiên …e91586aa/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Bài học chờ duyệt (1)' })).toBeTruthy();
    fireEvent.click(within(article).getByRole('button', { name: 'Duyệt' }));
    fireEvent.change(within(article).getByLabelText('Ghi chú (không bắt buộc)'), { target: { value: '  Đúng, tạo việc qua task.create  ' } });
    fireEvent.click(within(article).getByRole('button', { name: 'Xác nhận duyệt' }));
    await screen.findByText('Đã duyệt đề xuất #3.');
    await screen.findByText('Không có bài học nào đang chờ duyệt.');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.p).toMatchObject({ organizationId: ORG, proposalIds: [P3], decision: 'approve', note: 'Đúng, tạo việc qua task.create' });
    expect(writes[0]!.p.requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const historyBlock = screen.getByLabelText('Lịch sử duyệt');
    expect(within(historyBlock).getByText(/#3 · Đã duyệt · Quản trị/)).toBeTruthy();
    expect(fetchMock.mock.calls.every(([path]) => /hermes_learning_(review|decide)_v1$/.test(String(path)))).toBe(true);
  });

  it('nói đúng hành vi hiện tại: bài học đã có hiệu lực, "Bỏ" chỉ ghi nhận — gỡ khỏi trợ lý làm tay', async () => {
    pending = [proposal(P1, 1), proposal(P2, 2, { kind: 'memory_crm_write', source: { type: 'memory', file: 'memories/MEMORY.md' } })];
    render(view());
    const intro = await screen.findByText(/được đưa vào đây để chủ\/quản trị viên xem lại/);
    expect(intro.textContent).toMatch(/đã có hiệu lực từ lúc trợ lý tự ghi — trợ lý không chờ duyệt/);
    expect(intro.textContent).toMatch(/Bỏ chỉ ghi nhận bài học sai — việc gỡ bài học khỏi trợ lý hiện do người vận hành làm tay/);
    expect(intro.textContent).not.toMatch(/sẽ được gỡ khỏi trợ lý/);
    const second = await screen.findByRole('article', { name: 'Đề xuất #2' });
    expect(within(second).getByText(/Bộ nhớ · hồ sơ owner · Nguyễn Chủ/)).toBeTruthy();
    expect(within(second).getByText('Bộ nhớ memories/MEMORY.md')).toBeTruthy();
    fireEvent.click(within(second).getByRole('button', { name: 'Bỏ' }));
    expect(within(second).getByText(/Bỏ chỉ ghi lại quyết định; bài học vẫn còn ở trợ lý/)).toBeTruthy();
    fireEvent.click(within(second).getByRole('button', { name: 'Huỷ' }));
    expect(writes).toHaveLength(0);
    fireEvent.click(within(second).getByRole('button', { name: 'Bỏ' }));
    fireEvent.click(within(second).getByRole('button', { name: 'Xác nhận bỏ' }));
    await screen.findByText('Đã bỏ đề xuất #2. Bài học vẫn còn ở trợ lý cho tới khi người vận hành gỡ.');
    expect(writes[0]!.p).toMatchObject({ proposalIds: [P2], decision: 'reject', note: null });
    expect(await screen.findByRole('article', { name: 'Đề xuất #1' })).toBeTruthy();
  });

  it('hiện lần kiểm cuối của từng hồ sơ; quá 36 giờ hoặc chưa có lần kiểm nào thì cảnh báo', async () => {
    render(view());
    const fresh = await screen.findByLabelText('Lần kiểm cuối');
    expect(within(fresh).getByText(/Lần kiểm cuối · hồ sơ owner \(Nguyễn Chủ\):/).textContent).not.toMatch(/quá 36 giờ/);
    cleanup();
    audits = [auditOf(40 * 3_600_000)];
    render(view());
    expect((await screen.findByText(/đã quá 36 giờ: job kiểm học tập có thể đã ngừng/)).textContent).toMatch(/hồ sơ owner/);
    cleanup();
    audits = [];
    render(view());
    await screen.findByText(/Chưa có lần kiểm học tập nào được ghi nhận/);
  });

  it('đề xuất chờ phân trang 20 theo số; "Xem thêm đề xuất" đọc trang sau bằng pendingAfterSeq', async () => {
    pending = Array.from({ length: 23 }, (_, n) => proposal(`88888888-8888-4888-8888-${String(n + 1).padStart(12, '0')}`, n + 1));
    render(view());
    await screen.findByRole('article', { name: 'Đề xuất #20' });
    expect(screen.queryByRole('article', { name: 'Đề xuất #21' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Xem thêm đề xuất (còn 3)' }));
    await screen.findByRole('article', { name: 'Đề xuất #23' });
    expect(reviews.at(-1)!.p).toMatchObject({ historyCursor: null, pendingAfterSeq: 20 });
    expect(screen.getAllByRole('article')).toHaveLength(23);
    expect(screen.queryByRole('button', { name: /Xem thêm đề xuất/ })).toBeNull();
  });

  it('mất phản hồi khi ghi: báo chưa rõ, khoá thao tác khác, chỉ gửi lại đúng lệnh cũ', async () => {
    writeReply = () => json({ error: 'gateway' }, 502);
    render(view());
    const article = await screen.findByRole('article', { name: 'Đề xuất #3' });
    fireEvent.click(within(article).getByRole('button', { name: 'Duyệt' }));
    fireEvent.click(within(article).getByRole('button', { name: 'Xác nhận duyệt' }));
    await screen.findByText(/Chưa rõ máy chủ đã ghi quyết định này chưa/);
    expect((within(article).getByRole('button', { name: 'Xác nhận duyệt' }) as HTMLButtonElement).disabled).toBe(true);
    writeReply = applied;
    fireEvent.click(screen.getByRole('button', { name: 'Gửi lại với cùng mã' }));
    await screen.findByText('Đã duyệt đề xuất #3.');
    expect(writes).toHaveLength(2);
    expect(writes[1]!.p).toEqual(writes[0]!.p);
  });

  it('máy chủ đã ghi nhưng mất phản hồi: tải lại không còn đề xuất, gửi lại cùng mã vẫn báo đúng số đề xuất', async () => {
    let lost = true, first: Record<string, unknown> | null = null;
    writeReply = p => {
      if (lost) { lost = false; first = p; applied(p); return json({ error: 'gateway' }, 502); }
      expect(p).toEqual(first);
      const done = history.filter(item => (p.proposalIds as string[]).includes(item.id));
      return json({ organizationId: ORG, decision: p.decision, replayed: true, proposals: done });
    };
    render(view());
    const article = await screen.findByRole('article', { name: 'Đề xuất #3' });
    fireEvent.click(within(article).getByRole('button', { name: 'Duyệt' }));
    fireEvent.click(within(article).getByRole('button', { name: 'Xác nhận duyệt' }));
    await screen.findByText(/Chưa rõ máy chủ đã ghi quyết định này chưa/);
    await screen.findByText('Không có bài học nào đang chờ duyệt.');
    fireEvent.click(screen.getByRole('button', { name: 'Gửi lại với cùng mã' }));
    await screen.findByText('Đã duyệt đề xuất #3. (Máy chủ đã ghi từ lần gửi trước.)');
    expect(writes).toHaveLength(2);
  });

  it('đề xuất đã có người quyết định: báo xung đột và đọc lại', async () => {
    writeReply = () => { pending = []; return json({ code: 'PT409', message: 'hermes_learning_already_decided', details: null, hint: null }, 409); };
    render(view());
    const article = await screen.findByRole('article', { name: 'Đề xuất #3' });
    fireEvent.click(within(article).getByRole('button', { name: 'Bỏ' }));
    fireEvent.click(within(article).getByRole('button', { name: 'Xác nhận bỏ' }));
    await screen.findByText('Đề xuất này đã được quyết định trước đó. Danh sách đã được tải lại.');
    await screen.findByText('Không có bài học nào đang chờ duyệt.');
  });

  it('thiếu quyền hoặc máy chủ chưa có chức năng thì nói rõ, không hiện danh sách rỗng', async () => {
    reviewReply = () => json({ code: '42501', message: 'PRIVATE', details: null, hint: null }, 403);
    render(view());
    await screen.findByText(/Chỉ chủ hoặc quản trị viên công ty \(quyền quản lý người dùng\)/);
    expect(screen.queryByText('Không có bài học nào đang chờ duyệt.')).toBeNull();
    expect(screen.queryByText('PRIVATE')).toBeNull();
    expect(screen.queryByText(/Chưa có lần kiểm học tập nào/)).toBeNull();
    cleanup();
    reviewReply = () => json({ code: 'PGRST202', message: 'x', details: null, hint: null }, 404);
    render(view());
    await screen.findByText('Máy chủ chưa có chức năng duyệt bài học (cơ sở dữ liệu chưa được cập nhật).');
  });

  it('lịch sử phân trang bằng con trỏ của máy chủ; nội dung đã che được ghi chú', async () => {
    pending = [];
    const first = Array.from({ length: 20 }, (_, n) => decide(proposal(`77777777-7777-4777-8777-${String(n).padStart(12, '0')}`, 100 - n), 'approved', null,
      `2026-10-30T${String(23 - n).padStart(2, '0')}:00:00.000000Z`));
    const older = { ...decide(proposal(P1, 1), 'rejected', 'sai nghiệp vụ', '2026-10-29T01:00:00.000000Z'), redactedAt: '2026-10-29T02:00:00.000000Z' };
    const cursor = { decidedAt: first[19]!.decidedAt, id: first[19]!.id };
    reviewReply = p => json({ ...snapshotOf(p), history: p.historyCursor ? [older] : first, nextHistoryCursor: p.historyCursor ? null : cursor });
    render(view());
    await screen.findByText(/#100 · Đã duyệt/);
    fireEvent.click(screen.getByRole('button', { name: 'Xem thêm lịch sử' }));
    await screen.findByText(/#1 · Đã bỏ · Quản trị .* · nội dung đã che — .* — ghi chú: sai nghiệp vụ/);
    expect(reviews.at(-1)!.p.historyCursor).toEqual(cursor);
    expect(screen.queryByRole('button', { name: 'Xem thêm lịch sử' })).toBeNull();
  });
});
