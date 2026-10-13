// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesZaloBotSettings } from './HermesZaloBotSettings';
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: async () => ({
  data: { session: { user: { id: '11111111-1111-4111-8111-111111111111' }, access_token: 'fixture.browser.jwt' } }, error: null,
}) } } }));
const USER = '11111111-1111-4111-8111-111111111111', ORG = '22222222-2222-4222-8222-222222222222';
const BOT = '44444444-4444-4444-8444-444444444444', OTHER = '55555555-5555-4555-8555-555555555555';
const scope = { userId: USER, organizationId: ORG, generation: 0 }, currentScope = () => scope;
const owner = { userId: USER, organizationId: ORG };
const row = () => ({ accountId: BOT, name: 'Nick phụ công ty', zaloUid: '12345' as string | null, connected: true, enabled: false, version: 0 });
let bots: ReturnType<typeof row>[], changed: ReturnType<typeof vi.fn<() => void>>, fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
async function respond(path: RequestInfo | URL, init?: RequestInit) {
  const input = JSON.parse(init!.body as string);
  if (String(path).endsWith('/manageBots')) return Response.json({ ...owner, status: 'listed', nextCursor: null, bots });
  if (String(path).endsWith('/setBot')) {
    const bot = bots.find(value => value.accountId === input.accountId)!;
    if (bot.version !== input.expectedVersion) return Response.json({ error: 'context_changed' }, { status: 409 });
    bot.enabled = input.enabled; bot.version++;
    return Response.json({ ...owner, status: 'configured', accountId: bot.accountId, version: bot.version, enabled: bot.enabled });
  }
  throw new Error('unexpected_fixture_route');
}
beforeEach(() => {
  scope.userId = USER; scope.organizationId = ORG; scope.generation = 0;
  bots = [row()]; changed = vi.fn<() => void>(); fetchMock = vi.fn<typeof globalThis.fetch>(respond); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const view = (key = 'current') => <HermesZaloBotSettings key={key} userId={USER} organizationId={ORG} currentScope={currentScope} onConfigurationChanged={changed} />;
const writes = () => fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/setBot'));
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Cấu hình bot của công ty' }));
  await screen.findByRole('article', { name: 'Tài khoản Zalo Nick phụ công ty' });
}
async function confirm() {
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận đổi cấu hình' }));
}
describe('company bot administration with caller-scoped real client and synthetic HTTP', () => {
  it('does not probe administration until opened and requires explicit confirmation of the secondary account', async () => {
    render(<StrictMode>{view()}</StrictMode>); expect(fetchMock).not.toHaveBeenCalled(); await open();
    fireEvent.click(screen.getByRole('button', { name: 'Bật làm bot' }));
    expect((screen.getByRole('button', { name: 'Xác nhận đổi cấu hình' }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes()).toHaveLength(0); await confirm();
    await screen.findByText('Đã bật nick phụ làm bot Hermes. Người dùng có thể tạo liên kết Zalo mới.');
    expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ accountId: BOT, expectedVersion: 0, enabled: true, organizationId: ORG });
    fireEvent.click(screen.getByRole('button', { name: 'Tắt bot' })); await confirm();
    await screen.findByText('Đã tắt bot Hermes và ngắt các liên kết đang dùng bot này.');
    expect(JSON.parse(writes()[1][1]!.body as string).expectedVersion).toBe(1);
    expect(writes()).toHaveLength(2); expect(changed).toHaveBeenCalledTimes(2);
  });
  it('shows permission denial without presenting it as an empty company', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'forbidden' }, { status: 403 })); render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Cấu hình bot của công ty' }));
    await screen.findByText(/Bạn chưa có đủ quyền/);
    expect(screen.queryByText(/Công ty chưa có nick Zalo phụ/)).toBe(null); expect(screen.queryByRole('button', { name: 'Bật làm bot' })).toBe(null);
    expect(writes()).toHaveLength(0);
  });
  it('cannot enable an unready account, but can turn off a disconnected existing bot', async () => {
    bots = [{ ...row(), connected: false, zaloUid: null }, { ...row(), accountId: OTHER, name: 'Bot ngắt mạng', connected: false, enabled: true, version: 3 }];
    render(view()); await open();
    expect((screen.getByRole('button', { name: 'Bật làm bot' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Tắt bot' })); await confirm();
    await screen.findByText('Đã tắt bot Hermes và ngắt các liên kết đang dùng bot này.');
    expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({ accountId: OTHER, expectedVersion: 3, enabled: false });
  });
  it('lost configuration ACK invalidates link UI, blocks writes and requires explicit readback without replay', async () => {
    fetchMock.mockImplementation(async (path, init) => { if (String(path).endsWith('/setBot')) { await respond(path, init); throw new Error('PRIVATE'); } return respond(path, init); });
    render(view()); await open(); fireEvent.click(screen.getByRole('button', { name: 'Bật làm bot' })); await confirm();
    await screen.findByText(/Chưa xác định kết quả đổi cấu hình/); expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Xác nhận đổi cấu hình' })).toBe(null); expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Tải lại cấu hình bot' })); await screen.findByRole('button', { name: 'Tắt bot' });
    expect(screen.queryByText(/Thao tác thay đổi đang tạm dừng/)).toBe(null); expect(writes()).toHaveLength(1);
  });
  it('stale-version denial clears the proposal and never silently overwrites or retries', async () => {
    render(view()); await open(); fireEvent.click(screen.getByRole('button', { name: 'Bật làm bot' }));
    bots[0].version = 4; await confirm(); await screen.findByText(/Cấu hình hoặc phiên Zalo đã thay đổi/);
    expect(writes()).toHaveLength(1); expect(bots[0].enabled).toBe(false);
    expect(screen.queryByRole('checkbox')).toBe(null);
  });
  it('clears consent when selecting another account or cancelling', async () => {
    bots.push({ ...row(), accountId: OTHER, name: 'Nick phụ khác' }); render(view()); await open();
    fireEvent.click(within(screen.getByRole('article', { name: 'Tài khoản Zalo Nick phụ công ty' })).getByRole('button'));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(within(screen.getByRole('article', { name: 'Tài khoản Zalo Nick phụ khác' })).getByRole('button'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Hủy thay đổi' })); expect(screen.queryByRole('checkbox')).toBe(null); expect(writes()).toHaveLength(0);
  });
  it('loads later account pages before selecting a bot beyond the first hundred', async () => {
    const history = Array.from({ length: 100 }, (_, index) => ({ ...row(), accountId: '10000000-0000-4000-8000-' + String(index).padStart(12, '0'),
      name: 'Offline ' + index, connected: false }));
    fetchMock.mockImplementation(async (path, init) => {
      if (!String(path).endsWith('/manageBots')) return respond(path, init);
      const input = JSON.parse(init!.body as string);
      return Response.json({ ...owner, status: 'listed', bots: input.afterAccountId ? bots : history,
        nextCursor: input.afterAccountId ? null : history[99].accountId });
    });
    render(view()); fireEvent.click(screen.getByRole('button', { name: 'Cấu hình bot của công ty' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Xem thêm tài khoản Zalo' }));
    const article = await screen.findByRole('article', { name: 'Tài khoản Zalo Nick phụ công ty' });
    fireEvent.click(within(article).getByRole('button', { name: 'Bật làm bot' })); await confirm();
    await screen.findByText('Đã bật nick phụ làm bot Hermes. Người dùng có thể tạo liên kết Zalo mới.');
    expect(writes()).toHaveLength(1); expect(screen.queryByRole('button', { name: 'Xem thêm tài khoản Zalo' })).toBe(null);
  });
  it('ignores a late result after company generation changes and aborts its client work', async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { rerender } = render(view()); fireEvent.click(screen.getByRole('button', { name: 'Cấu hình bot của công ty' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    scope.generation += 2; rerender(view('new-generation'));
    await act(async () => { resolve(await respond('/api/hermes/zalo/manageBots', { body: '{}' })); });
    expect(screen.queryByRole('article')).toBe(null); expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(changed).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });
});
