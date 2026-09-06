// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Toaster } from 'sonner';
import { byId, click, deferred, eventually, fresh, io, mount, resetIo, send, unmount } from './renderHarness';
import ChatPanel from '../ChatPanel';
import { LoiModel } from '../llmClient';

beforeEach(resetIo);
afterEach(unmount);
const panel = () => <><ChatPanel onClose={() => {}} /><Toaster /></>;

describe('mounted ChatPanel G0', () => {
  it('keeps the question and blocks model I/O when availability remains stale after refetch', async () => {
    io.availability = { ...fresh(), fetchedAt: Date.now() - 90_000 };
    io.refetch.mockResolvedValue({ data: io.availability });
    await mount(panel());
    expect(byId('copilot-quyen-chua-tuoi').textContent).toContain('làm mới');
    await send();
    expect(byId<HTMLTextAreaElement>('copilot-input').value).toBe('Phòng nào đang trống?');
    expect(document.body.textContent).toContain('thử lại sau vài giây');
    expect(io.refetch).toHaveBeenCalledTimes(1);
    expect(io.create).not.toHaveBeenCalled(); expect(io.turn).not.toHaveBeenCalled();
  });
  it('waits for fresh availability before sending and displays the completed answer', async () => {
    io.availability = null;
    const refresh = deferred<{ data: ReturnType<typeof fresh> }>(); io.refetch.mockReturnValue(refresh.promise);
    await mount(panel()); await send();
    expect(io.turn).not.toHaveBeenCalled();
    const snapshot = fresh();
    await act(async () => refresh.resolve({ data: snapshot }));
    expect(io.turn).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ availability: snapshot }) }));
    expect(document.body.textContent).toContain('Có 2 phòng trống: A101, A102.');
    expect(byId<HTMLTextAreaElement>('copilot-input').value).toBe('');
  });
  it('shows the organization action instead of refetching forever when no organization is selected', async () => {
    io.org = null; await mount(panel()); await send();
    expect(document.body.textContent).toMatch(/chọn (công ty|tổ chức)/i);
    expect(io.refetch).not.toHaveBeenCalled(); expect(io.turn).not.toHaveBeenCalled();
  });
  it('renders structured proxy code in Vietnamese even when its English message has no code', async () => {
    io.turn.mockRejectedValue(new LoiModel('No access to the selected organization', 403, 'organization_forbidden'));
    await mount(panel()); await send();
    expect(document.body.textContent).toContain('Bạn không có quyền dùng Copilot trong tổ chức đang chọn.');
    expect(document.body.textContent).not.toContain('No access to the selected organization');
    expect(byId('copilot-send')).toBeTruthy();
  });
  it.each(['entitlement', 'permission'] as const)('hides UI control without %s', async gate => {
    if (gate === 'entitlement') io.entitlement!.ui_control_enabled = false;
    else io.perms = { ai_copilot: { view: true } };
    await mount(panel());
    expect(document.querySelector('[data-testid="copilot-uimode"]')).toBeNull();
  });
  it('shows a denial and never constructs an agent with another organization snapshot', async () => {
    io.availability = { ...fresh(), organizationId: 'other-org' };
    await mount(panel()); await click(byId('copilot-uimode')); await send('Lọc phòng');
    await eventually(() => expect(document.body.textContent).toContain('Quyền công cụ đang thuộc tổ chức khác'));
    expect(io.uiAgent).not.toHaveBeenCalled(); expect(io.turn).not.toHaveBeenCalled();
  });
  it('blocks UI control when the page rollout is disabled', async () => {
    io.availability = { ...fresh(), states: { 'page:rooms.list': 'disabled' } };
    await mount(panel()); await click(byId('copilot-uimode')); await send('Lọc phòng');
    await eventually(() => expect(document.body.textContent).toContain('page_rollout_disabled'));
    expect(io.uiAgent).not.toHaveBeenCalled();
  });
  it('denies UI control when the current page permission is missing', async () => {
    io.perms = { ai_copilot: { view: true, ui_control: true } };
    await mount(panel()); await click(byId('copilot-uimode')); await send('Lọc phòng');
    await eventually(() => expect(document.body.textContent).toContain('page_permission_missing'));
    expect(io.uiAgent).not.toHaveBeenCalled();
  });
  it('executes and renders UI control only inside an enabled authorized page', async () => {
    await mount(panel()); await click(byId('copilot-uimode')); await send('Lọc phòng');
    await eventually(() => expect(document.body.textContent).toContain('Đã lọc phòng.'));
    expect(io.uiAgent).toHaveBeenCalledTimes(1); expect(io.turn).not.toHaveBeenCalled();
  });
  it('shows model and history loading until the real history boundary resolves', async () => {
    io.providers = undefined;
    const latest = deferred<{ id: string }>(); io.latest.mockReturnValue(latest.promise);
    io.messages.mockResolvedValue([{ role: 'assistant', content: 'Lịch sử tổ chức DEMO' }]);
    await mount(panel());
    expect(byId<HTMLSelectElement>('copilot-model-select').disabled).toBe(true);
    expect(byId('copilot-model-select').textContent).toContain('Đang tải');
    expect(byId('copilot-dang-tai-lich-su').textContent).toContain('Đang tải lịch sử');
    expect(document.querySelector('[data-testid="copilot-chip"]')).toBeNull();
    await act(async () => latest.resolve({ id: 'saved-thread' }));
    expect(document.querySelector('[data-testid="copilot-dang-tai-lich-su"]')).toBeNull();
    expect(document.body.textContent).toContain('Lịch sử tổ chức DEMO');
    expect(io.messages).toHaveBeenCalledWith('saved-thread', io.org);
  });
  it('keeps the completed answer and renders a toast after both persistence attempts fail', async () => {
    io.save.mockRejectedValue(new Error('offline'));
    await mount(panel()); await send();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(document.body.textContent).toContain('Có 2 phòng trống: A101, A102.');
    expect(document.body.textContent).toContain('Không lưu được lịch sử chat.');
    expect(io.save).toHaveBeenCalledTimes(2);
  });
});
