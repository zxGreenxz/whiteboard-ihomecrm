// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-000000000001';
const state = vi.hoisted(() => ({
  org: '00000000-0000-4000-8000-000000000001' as string | null,
  rpc: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: state.rpc } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: state.org }) }));

import PendingValveReleaseLogCard from '../PendingValveReleaseLogCard';

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`, entryId: `e-${n}`, actorUserId: 'abcdef12-0000-4000-8000-000000000000',
  actorName: 'JOEY', organizationSource: 'pending', namespace: 'pending-collection', businessKey: `hd-${n}`, operation: 'thu tiền hoá đơn',
  attemptId: `a-${n}`, recordIds: ['pt-01'], recordCount: 1, stuckAt: '2026-11-24T02:00:00+00:00',
  releasedAt: '2026-11-24T02:05:00+00:00', receivedAt: '2026-11-24T02:06:00.123456+00:00',
  device: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ...extra,
});
const page = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ data: { organizationId: ORG, allowed: true, rows, hasMore: false, ...extra }, error: null });

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PendingValveReleaseLogCard /></QueryClientProvider>);
}

describe('mục Nhật ký tự gỡ khoá ở trang Tổ chức', () => {
  beforeEach(() => { state.org = ORG; state.rpc.mockReset(); });
  afterEach(() => { cleanup(); });

  it('chưa chọn công ty: không hiện, không hỏi máy chủ', () => {
    state.org = null;
    const { container } = renderCard();
    expect(container.innerHTML).toBe('');
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('đang chờ trang đầu: không chớp khối chờ; máy chủ trả allowed=false cho công ty này: ẩn mục', async () => {
    let resolve!: (value: unknown) => void;
    state.rpc.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container } = renderCard();
    await waitFor(() => expect(state.rpc).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
    resolve({ data: { organizationId: ORG, allowed: false, rows: [], hasMore: false }, error: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('hiện người gỡ, thao tác, giờ kẹt, giờ gỡ, giờ lên máy chủ, mã bản ghi, thiết bị; hỏi đúng công ty đang chọn', async () => {
    state.rpc.mockResolvedValue(page([
      row(1),
      row(2, { actorName: null, operation: null, namespace: 'voucher-lifecycle', organizationSource: 'sole_membership', recordIds: ['pc-1', 'pc-2'], recordCount: 5, device: null }),
    ]));
    renderCard();
    expect(await screen.findByText('Nhật ký tự gỡ khoá')).toBeTruthy();
    expect(state.rpc).toHaveBeenCalledWith('pending_valve_release_log_list_v1', { p_organization_id: ORG, p_limit: 20, p_before_received_at: null, p_before_id: null });
    expect(await screen.findByText('thu tiền hoá đơn')).toBeTruthy();
    expect(screen.getByText('JOEY · gỡ lúc 09:05 ngày 24/11/2026')).toBeTruthy();
    expect(screen.getAllByText('09:00 ngày 24/11/2026')).toHaveLength(2);
    expect(screen.getAllByText('09:06 ngày 24/11/2026')).toHaveLength(2);
    expect(screen.getByText('iPhone · Safari')).toBeTruthy();
    expect(screen.getByText('pending-collection · hd-1')).toBeTruthy();
    // Dòng thứ hai: không tên người, không tên thao tác, công ty suy từ tư cách duy nhất, còn mã chưa hiện.
    expect(screen.getByText('Tài khoản abcdef12 · gỡ lúc 09:05 ngày 24/11/2026')).toBeTruthy();
    expect(screen.getByText('voucher-lifecycle', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('pc-1, pc-2').closest('dd')?.textContent).toBe('pc-1, pc-2 và 3 mã khác');
    expect(screen.getByText('Thao tác không gắn công ty; ghi vào công ty duy nhất của người gỡ')).toBeTruthy();
    expect(screen.getByText('Không rõ thiết bị')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Xem thêm' })).toBeNull();
  });

  it('giờ không đọc được thì hiện nguyên văn, không làm hỏng mục', async () => {
    state.rpc.mockResolvedValue(page([row(1, { stuckAt: '10000-01-01T00:00:00+00:00' })]));
    renderCard();
    expect(await screen.findByText('10000-01-01T00:00:00+00:00')).toBeTruthy();
    expect(screen.getByText('thu tiền hoá đơn')).toBeTruthy();
  });

  it('«Xem thêm» nạp trang sau theo con trỏ (giờ lên máy chủ, id) của dòng cuối', async () => {
    state.rpc
      .mockResolvedValueOnce(page([row(1)], { hasMore: true }))
      .mockResolvedValueOnce(page([row(2, { operation: 'duyệt phiếu' })]));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Xem thêm' }));
    expect(await screen.findByText('duyệt phiếu')).toBeTruthy();
    expect(state.rpc).toHaveBeenLastCalledWith('pending_valve_release_log_list_v1', {
      p_organization_id: ORG, p_limit: 20, p_before_received_at: '2026-11-24T02:06:00.123456+00:00', p_before_id: row(1).id,
    });
    expect(screen.queryByRole('button', { name: 'Xem thêm' })).toBeNull();
  });

  it('chưa có dòng nào: báo rõ là chưa có', async () => {
    state.rpc.mockResolvedValue(page([]));
    renderCard();
    expect(await screen.findByText('Chưa có lần tự gỡ khoá nào được ghi nhận.')).toBeTruthy();
  });

  it('đọc lỗi hoặc dữ liệu thuộc công ty khác: báo chưa tải được, không hiện rỗng', async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    renderCard();
    expect(await screen.findByText(/Chưa tải được nhật ký tự gỡ khoá/)).toBeTruthy();
    cleanup();
    state.rpc.mockResolvedValue({ data: { organizationId: 'khac', allowed: true, rows: [], hasMore: false }, error: null });
    renderCard();
    expect(await screen.findByText(/Chưa tải được nhật ký tự gỡ khoá/)).toBeTruthy();
    expect(screen.queryByText('Chưa có lần tự gỡ khoá nào được ghi nhận.')).toBeNull();
  });
});
