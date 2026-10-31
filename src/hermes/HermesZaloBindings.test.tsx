// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { HermesZaloBindings, type HermesZaloSummary } from './HermesZaloBindings';
import type { HermesConnectionMetadata } from './connectionClient';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: async () => ({
  data: { session: { user: { id: '11111111-1111-4111-8111-111111111111' }, access_token: 'fixture.browser.jwt' } }, error: null,
}) } } }));
const USER = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333', BOT = '44444444-4444-4444-8444-444444444444';
const CHALLENGE = '55555555-5555-4555-8555-555555555555', BINDING = '66666666-6666-4666-8666-666666666666';
const secret = 'hz_' + 'a'.repeat(64);
const row = (): HermesConnectionMetadata => ({ id: CONNECTION, userId: USER, organizationId: ORG, assistantId: CHALLENGE,
  epoch: 2, state: 'active', restrictions: { read: ['assistant.context.read'], action: [] }, scopeIds: [] });
const scope = { userId: USER, organizationId: ORG, generation: 0 };
const currentScope = () => scope;
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, ttl: number;
const base = { userId: USER, organizationId: ORG };
async function respond(path: RequestInfo | URL, init?: RequestInit) {
  const op = String(path).split('/').at(-1), input = JSON.parse(init!.body as string);
  if (op === 'bots') return Response.json({ ...base, status: 'listed', nextCursor: null, bots: [{ accountId: BOT, name: 'Bot công ty', zaloUid: '12345' }] });
  if (op === 'list') return Response.json({ ...base, status: 'listed', nextCursor: null, bindings: [] });
  if (op === 'begin') return Response.json({ ...base, status: 'waiting', challengeId: CHALLENGE, challenge: secret, accountId: BOT, connectionId: CONNECTION, expiresAt: Date.now() + ttl });
  if (op === 'status') return Response.json({ ...base, status: 'observed', challengeId: CHALLENGE, accountId: BOT, connectionId: CONNECTION, expiresAt: Date.now() + ttl, candidateVersion: 1, senderUid: '98765' });
  if (op === 'confirm') return Response.json({ ...base, status: 'active', bindingId: BINDING, epoch: 1, accountId: BOT, connectionId: CONNECTION, senderUid: input.expectedSenderUid });
  if (op === 'selectCredential') return Response.json({ ...base, status: 'selected', connectionId: input.connectionId });
  if (op === 'unlink') return Response.json({ ...base, status: 'revoked', bindingId: BINDING, epoch: input.expectedEpoch + 1 });
  throw new Error('unexpected fixture route');
}
beforeEach(() => {
  scope.userId = USER; scope.organizationId = ORG; scope.generation = 0; ttl = 900000;
  fetchMock = vi.fn<typeof globalThis.fetch>(respond); vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const view = (key = 'initial', connections = [row()]) => <HermesZaloBindings key={key} userId={USER} organizationId={ORG} currentScope={currentScope} connections={connections} disabled={false} />;
// Một kết nối và một bot thì tự được chọn; chỉ khi có nhiều kết nối mới phải chọn trong danh sách.
async function ready() {
  await waitFor(() => { expect(calls('list').length).toBeGreaterThan(0); expect(screen.queryByText('Đang kiểm tra liên kết…')).toBe(null); });
  const select = screen.queryByLabelText('Kết nối Hermes dùng cho Zalo');
  if (select) fireEvent.change(select, { target: { value: CONNECTION } });
}
async function begin() { fireEvent.click(screen.getByRole('button', { name: 'Tạo mã liên kết Zalo' })); await screen.findByLabelText('Nội dung gửi cho bot'); }
async function observed() { await begin(); await screen.findByText('98765'); }
const calls = (op: string) => fetchMock.mock.calls.filter(([path]) => path === '/api/hermes/zalo/' + op);
describe('Hermes Zalo link UI with real client and synthetic HTTP', () => {
  it('loads again after the StrictMode cleanup aborts the first mount', async () => {
    render(<StrictMode>{view()}</StrictMode>);
    await ready(); await begin();
    expect(calls('begin')).toHaveLength(1);
  });
  it('polls the real sender and requires one explicit pairing action, then supports unlink without replaying a write', async () => {
    render(view()); await ready(); await observed();
    const confirm = screen.getByRole('button', { name: 'Ghép nick Zalo này' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false); expect(calls('confirm')).toHaveLength(0);
    fireEvent.click(confirm);
    await screen.findByText('Đã liên kết nick Zalo của bạn với kết nối Hermes.');
    expect(screen.queryByLabelText('Nội dung gửi cho bot')).toBe(null);
    expect(JSON.parse(calls('confirm')[0][1]!.body as string)).toEqual({ challengeId: CHALLENGE, expectedCandidateVersion: 1, expectedSenderUid: '98765', organizationId: ORG });
    fireEvent.click(screen.getByRole('button', { name: 'Ngắt liên kết' })); await screen.findByText('Đã ngắt liên kết nick Zalo.');
    expect(calls('confirm')).toHaveLength(1); expect(calls('unlink')).toHaveLength(1);
  });
  it('copies only the one-time link command and never writes a challenge to browser storage', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem'); render(view()); await ready(); await begin();
    fireEvent.click(screen.getByRole('button', { name: 'Sao chép mã Zalo' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/hermes-link ' + secret));
    expect(local).not.toHaveBeenCalled();
  });
  it('reconciles a just-confirmed binding with its later page without duplicate rows or stale state', async () => {
    const history = Array.from({ length: 100 }, (_, index) => ({
      bindingId: '10000000-0000-4000-8000-' + String(index).padStart(12, '0'), epoch: 1, state: 'revoked',
      accountId: BOT, connectionId: CONNECTION, senderUid: String(index + 1),
    }));
    const cursor = history[99].bindingId;
    fetchMock.mockImplementation(async (path, init) => {
      if (!String(path).endsWith('/list')) return respond(path, init);
      const input = JSON.parse(init!.body as string);
      return Response.json({ ...base, status: 'listed', nextCursor: input.afterBindingId ? null : cursor,
        bindings: input.afterBindingId ? [{ bindingId: BINDING, epoch: 2, state: 'revoked', accountId: BOT,
          connectionId: CONNECTION, senderUid: '98765' }] : history });
    });
    render(view()); await ready(); await observed();
    fireEvent.click(screen.getByRole('button', { name: 'Ghép nick Zalo này' }));
    await screen.findByText('Đã liên kết nick Zalo của bạn với kết nối Hermes.');
    fireEvent.click(screen.getByRole('button', { name: 'Xem thêm liên kết' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Xem thêm liên kết' })).toBe(null));
    expect(screen.getAllByText('Nick của bạn: 98765')).toHaveLength(1);
    expect(screen.getByText('Liên kết đã ngắt (101)')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: 'Ngắt liên kết' })).toHaveLength(0);
    expect(JSON.parse(calls('list')[1][1]!.body as string).afterBindingId).toBe(cursor);
    expect(calls('confirm')).toHaveLength(1);
  });
  it('clears the challenge after expiry and cannot confirm it', async () => {
    render(view()); await ready(); vi.useFakeTimers(); ttl = 1000;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tạo mã liên kết Zalo' })); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByLabelText('Nội dung gửi cho bot')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
    expect(screen.queryByLabelText('Nội dung gửi cho bot')).toBe(null); expect(calls('confirm')).toHaveLength(0);
  });
  it('unknown confirm blocks further writes until explicit readback and does not retry automatically', async () => {
    fetchMock.mockImplementation(async (path, init) => { if (String(path).endsWith('/confirm')) throw new Error('PRIVATE'); return respond(path, init); });
    render(view()); await ready(); await observed();
    fireEvent.click(screen.getByRole('button', { name: 'Ghép nick Zalo này' }));
    await screen.findByText(/Chưa xác định thao tác liên kết đã hoàn tất/);
    expect((screen.getByRole('button', { name: 'Tạo mã liên kết Zalo' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Nội dung gửi cho bot')).toBe(null); expect(calls('confirm')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại liên kết' })); await ready(); expect(calls('confirm')).toHaveLength(1);
  });
  it('explains an existing sender link without retrying or changing either account automatically', async () => {
    fetchMock.mockImplementation(async (path, init) => String(path).endsWith('/confirm')
      ? Response.json({ error: 'sender_already_linked' }, { status: 409 }) : respond(path, init));
    render(view()); await ready(); await observed();
    fireEvent.click(screen.getByRole('button', { name: 'Ghép nick Zalo này' }));
    await screen.findByText(/Nick Zalo này đã có liên kết với bot/);
    expect(screen.getByText(/ngắt liên kết ở tài khoản cũ trước khi ghép lại/)).toBeTruthy();
    expect(screen.queryByText(/Chưa xác định thao tác liên kết đã hoàn tất/)).toBe(null);
    expect(screen.queryByLabelText('Nội dung gửi cho bot')).toBe(null);
    expect(calls('confirm')).toHaveLength(1); expect(calls('unlink')).toHaveLength(0);
    expect(calls('selectCredential')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại liên kết' })); await ready();
    expect(calls('confirm')).toHaveLength(1);
  });
  it('withdraws the challenge when the parent connection is revoked', async () => {
    const { rerender } = render(view()); await ready(); await begin();
    rerender(view('initial', [{ ...row(), state: 'revoked', epoch: 3 }]));
    await waitFor(() => expect(screen.queryByLabelText('Nội dung gửi cho bot')).toBe(null)); expect(calls('confirm')).toHaveLength(0);
  });
  it('a late response cannot restore a challenge after workspace generation changes', async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation(async (path, init) => String(path).endsWith('/begin') ? new Promise(done => { resolve = done; }) : respond(path, init));
    const { rerender } = render(view()); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Tạo mã liên kết Zalo' }));
    await waitFor(() => expect(calls('begin')).toHaveLength(1)); scope.generation += 2; rerender(view('new-generation'));
    await act(async () => { resolve(await respond('/api/hermes/zalo/begin', { body: '{}' })); });
    await ready(); expect(screen.queryByLabelText('Nội dung gửi cho bot')).toBe(null);
    expect(calls('begin')[0][1]!.signal!.aborted).toBe(true);
  });
  it('stops automatic status reads after recognizing the sender and after leaving the page', async () => {
    const { unmount } = render(view()); await ready(); await observed();
    expect(screen.queryByRole('checkbox')).toBe(null);
    expect(screen.queryByRole('button', { name: 'Tôi đã gửi, kiểm tra người gửi' })).toBe(null);
    const count = calls('status').length;
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(6500); });
    expect(calls('status')).toHaveLength(count);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6500); });
    expect(calls('status')).toHaveLength(count);
  });
  it('keeps a live code when only permissions or connection revision change', async () => {
    const { rerender } = render(view()); await ready(); await begin();
    rerender(view('initial', [{ ...row(), epoch: 3, restrictions: { read: [], action: [] } }]));
    expect(screen.getByLabelText('Nội dung gửi cho bot')).toBeTruthy();
    await screen.findByText('98765');
    expect(calls('begin')).toHaveLength(1);
  });
  it('switches the explicit CRM credential with CAS while preserving the Zalo pairing', async () => {
    const next = '77777777-7777-4777-8777-777777777777';
    render(view('initial', [row(), { ...row(), id: next }]));
    await ready(); await observed();
    fireEvent.click(screen.getByRole('button', { name: 'Ghép nick Zalo này' }));
    await screen.findByText('Đã liên kết nick Zalo của bạn với kết nối Hermes.');
    expect(screen.queryByRole('button', { name: 'Dùng kết nối này cho trợ lý' })).toBe(null);
    fireEvent.change(screen.getByLabelText('Kết nối Hermes dùng cho Zalo'), { target: { value: next } });
    fireEvent.click(screen.getByRole('button', { name: 'Dùng kết nối này cho trợ lý' }));
    await screen.findByText('Đã chọn kết nối CRM cho trợ lý. Nick Zalo vẫn được giữ.');
    expect(JSON.parse(calls('selectCredential')[0][1]!.body as string)).toEqual({ connectionId: next,
      expectedConnectionEpoch: 2, expectedActiveConnectionId: CONNECTION, organizationId: ORG });
    expect(screen.getByText('Nick của bạn: 98765')).toBeTruthy();
    expect(calls('begin')).toHaveLength(1); expect(calls('confirm')).toHaveLength(1);
  });

  it('shows missing credential and pending activation separately from an already verified nick', async () => {
    fetchMock.mockImplementation(async (path, init) => String(path).endsWith('/list') ?
      Response.json({ ...base, status: 'listed', nextCursor: null, bindings: [{ bindingId: BINDING, epoch: 1,
        state: 'active', accountId: BOT, connectionId: CONNECTION, senderUid: '98765', provisioningState: 'pending_credential' }] }) : respond(path, init));
    render(view()); await ready();
    expect(await screen.findByText('Đang chờ kết nối CRM của trợ lý.')).toBeTruthy();
    expect(screen.getByText('Nick của bạn: 98765')).toBeTruthy();
  });

  it('uses the only connection and bot without a picker and reports progress without codes or UIDs', async () => {
    const summaries: HermesZaloSummary[] = [];
    render(<HermesZaloBindings userId={USER} organizationId={ORG} currentScope={currentScope} connections={[row()]} disabled={false} onSummary={value => summaries.push(value)} />);
    await ready();
    expect(screen.queryByLabelText('Kết nối Hermes dùng cho Zalo')).toBe(null); expect(screen.queryByLabelText('Bot nhận tin nhắn')).toBe(null);
    expect(screen.getByText('Bot công ty')).toBeTruthy();
    await observed();
    fireEvent.click(screen.getByRole('button', { name: 'Ghép nick Zalo này' }));
    await screen.findByText('Đã liên kết nick Zalo của bạn với kết nối Hermes.');
    expect(JSON.parse(calls('begin')[0][1]!.body as string)).toMatchObject({ accountId: BOT, connectionId: CONNECTION, expectedConnectionEpoch: 2 });
    expect(summaries.map(value => value.stage)).toEqual(expect.arrayContaining(['none', 'code', 'observed', 'linked']));
    expect(summaries.at(-1)).toEqual({ bots: 1, stage: 'linked', provisioningState: null });
    expect(JSON.stringify(summaries)).not.toContain('98765');
  });
  it('offers the switch on its own when the linked connection was revoked and one active connection is left', async () => {
    const next = '77777777-7777-4777-8777-777777777777';
    fetchMock.mockImplementation(async (path, init) => String(path).endsWith('/list') ? Response.json({ ...base, status: 'listed', nextCursor: null,
      bindings: [{ bindingId: BINDING, epoch: 1, state: 'active', accountId: BOT, connectionId: CONNECTION, senderUid: '98765', provisioningState: 'pending_credential' }] })
      : respond(path, init));
    render(view('initial', [{ ...row(), state: 'revoked', epoch: 3 }, { ...row(), id: next }])); await ready();
    expect(screen.queryByLabelText('Kết nối Hermes dùng cho Zalo')).toBe(null);
    expect(screen.getByText(/Trợ lý đang dùng một kết nối đã ngắt hoặc hết hạn/).textContent).toContain('…77777777');
    expect(screen.queryByRole('button', { name: 'Tạo mã liên kết Zalo' })).toBe(null);
    fireEvent.click(screen.getByRole('button', { name: 'Dùng kết nối này cho trợ lý' }));
    await screen.findByText('Đã chọn kết nối CRM cho trợ lý. Nick Zalo vẫn được giữ.');
    expect(JSON.parse(calls('selectCredential')[0][1]!.body as string)).toEqual({ connectionId: next,
      expectedConnectionEpoch: 2, expectedActiveConnectionId: CONNECTION, organizationId: ORG });
    expect(calls('begin')).toHaveLength(0); expect(calls('confirm')).toHaveLength(0);
  });
  it('walks the code steps again when linking another nick while one is already linked', async () => {
    fetchMock.mockImplementation(async (path, init) => String(path).endsWith('/list') ? Response.json({ ...base, status: 'listed', nextCursor: null,
      bindings: [{ bindingId: BINDING, epoch: 1, state: 'active', accountId: BOT, connectionId: CONNECTION, senderUid: '11111', provisioningState: 'synchronized' }] })
      : respond(path, init));
    render(view()); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Liên kết nick Zalo khác' }));
    await begin();
    expect(screen.getByText(/Đang chờ bot nhận tin/)).toBeTruthy();
    await screen.findByText('98765');
    expect((screen.getByRole('button', { name: 'Ghép nick Zalo này' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Nick của bạn: 11111')).toBeTruthy(); expect(calls('confirm')).toHaveLength(0);
  });
  it('asks for a bot only when the company has several', async () => {
    fetchMock.mockImplementation(async (path, init) => String(path).endsWith('/bots') ? Response.json({ ...base, status: 'listed', nextCursor: null,
      bots: [{ accountId: BOT, name: 'Bot công ty', zaloUid: '12345' }, { accountId: CHALLENGE, name: 'Bot phụ', zaloUid: '67890' }] }) : respond(path, init));
    render(view()); await ready();
    expect((screen.getByRole('button', { name: 'Tạo mã liên kết Zalo' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Bot nhận tin nhắn'), { target: { value: BOT } });
    expect((screen.getByRole('button', { name: 'Tạo mã liên kết Zalo' }) as HTMLButtonElement).disabled).toBe(false);
    await begin(); expect(JSON.parse(calls('begin')[0][1]!.body as string)).toMatchObject({ accountId: BOT });
  });
});
