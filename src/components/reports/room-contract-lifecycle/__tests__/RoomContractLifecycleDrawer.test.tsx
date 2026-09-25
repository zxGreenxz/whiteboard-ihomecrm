// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifecyclePayload } from '@/lib/roomLifecycle';

const H = vi.hoisted(() => ({
  payload: null as unknown,
  lifecycle: { data: undefined as unknown, isError: false, error: null as unknown },
}));
vi.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganizationId: 'org' }),
}));
vi.mock('@/hooks/useRoomCashLifecycle', () => ({
  useRoomCashLifecycle: () => ({ data: H.payload, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useContractLifecycle', () => ({
  useContractLifecycle: () => H.lifecycle,
}));
vi.mock('@/hooks/useRoomContractExtras', () => ({
  useRoomContractExtras: () => ({ data: undefined }),
}));
vi.mock('@/lib/vnDate', () => ({ vnTodayISO: () => '2026-09-25' }));
import RoomContractLifecycleDrawer from '../RoomContractLifecycleDrawer';

const payload: LifecyclePayload = {
  room: { id: 'r204', name: '204', buildingId: 'b', buildingName: '111PVC' },
  range: { from: null, to: null },
  contracts: [
    { id: 'A', number: 'HĐ-A', status: 'TERMINATED', startDate: '2026-01-05', endDate: '2026-07-31', actualEndDate: '2026-07-31', rentPrice: 3_900_000, totalDeposit: 3_900_000, tenantName: 'Hoàng Gia Linh' },
    { id: 'B', number: 'HĐ-B', status: 'ACTIVE', startDate: '2026-08-10', endDate: '2027-02-09', actualEndDate: null, rentPrice: 3_950_000, totalDeposit: 3_950_000, tenantName: 'Ngô Phương Anh' },
  ],
  segments: [
    { contractId: 'A', contractNumber: 'HĐ-A', segIndex: 0, fromDate: '2026-01-05', toDate: '2026-07-31', sourcePath: null, trusted: true, diagnostic: null },
    { contractId: 'B', contractNumber: 'HĐ-B', segIndex: 0, fromDate: '2026-08-10', toDate: null, sourcePath: null, trusted: true, diagnostic: null },
  ],
  events: [{ type: 'CONTRACT_OPENED', date: '2026-08-10', contractId: 'B', amount: null, trusted: true, meta: null }],
  vacancies: [{ fromDate: '2026-07-31', toDate: '2026-08-10', days: 10 }],
  generatedAt: '2026-09-25T00:00:00Z',
};

beforeEach(() => {
  H.payload = payload;
  H.lifecycle = { data: undefined, isError: false, error: null };
});
afterEach(cleanup);

describe('RoomContractLifecycleDrawer', () => {
  it('danh sách năm → bấm hợp đồng → chi tiết → quay lại', () => {
    render(<RoomContractLifecycleDrawer roomId="r204" roomName="204" initialYear={2026} onClose={vi.fn()} />);
    expect(screen.getByText('Phòng 204 · Vòng đời hợp đồng')).toBeTruthy();
    expect(screen.getByText('Phòng trống 10 ngày · 31/07 → 09/08 — Thanh lý HĐ')).toBeTruthy();
    // Nguồn tiền đang tải: không in số cọc nào.
    expect(screen.getAllByText('Đang tải cọc & công nợ…').length).toBe(2);

    fireEvent.click(screen.getByText('Ngô Phương Anh'));
    expect(screen.getByText('Ngô Phương Anh · HĐ-B')).toBeTruthy();
    expect(screen.getByText('Diễn biến từ ngày vào tới ngày ra')).toBeTruthy();
    expect(screen.getByText('Hôm nay · đang ở')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Quay lại danh sách hợp đồng' }));
    expect(screen.getByText('Hợp đồng trong năm 2026')).toBeTruthy();
  });

  it('không lùi quá năm có dữ liệu và không tiến quá năm nay', () => {
    render(<RoomContractLifecycleDrawer roomId="r204" roomName="204" initialYear={2026} onClose={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Năm sau' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Năm trước' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lỗi nguồn tiền được nói ra, không đổi thành số 0', () => {
    H.lifecycle = { data: undefined, isError: true, error: new Error('Không đọc được bản ghi thanh lý — thử lại.') };
    render(<RoomContractLifecycleDrawer roomId="r204" roomName="204" initialYear={2026} onClose={vi.fn()} />);
    expect(screen.getByText('Cọc & công nợ: Không đọc được bản ghi thanh lý — thử lại.')).toBeTruthy();
    fireEvent.click(screen.getByText('Ngô Phương Anh'));
    const kpi = (label: string) => screen.getByText(label).parentElement!.textContent!;
    expect(kpi('ĐÃ THU')).toContain('Chưa đủ dữ liệu');
    expect(kpi('KHÁCH CÒN NỢ')).toContain('Chưa đủ dữ liệu');
    // Đang ở: chủ nhà chưa tới hạn hoàn cọc — 0 có căn cứ và phải nói rõ vì sao.
    expect(kpi('CHỦ NHÀ CÒN NỢ KHÁCH')).toContain('Chưa đến hạn hoàn cọc');
  });

  it('nút đóng gọi onClose', () => {
    const onClose = vi.fn();
    render(<RoomContractLifecycleDrawer roomId="r204" roomName="204" initialYear={2026} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Đóng' }));
    expect(onClose).toHaveBeenCalled();
  });

  describe('bề rộng panel', () => {
    const innerWidth = window.innerWidth;
    const anchors: HTMLElement[] = [];
    afterEach(() => {
      Object.defineProperty(window, 'innerWidth', { value: innerWidth, configurable: true });
      anchors.splice(0).forEach((a) => a.remove());
    });
    const anchorAt = (right: number) => {
      const el = document.createElement('div');
      el.getBoundingClientRect = () => ({ right } as DOMRect);
      document.body.appendChild(el);
      anchors.push(el);
      return el;
    };
    const panel = () => document.querySelector<HTMLElement>('.rcl')!;

    it('mép trái bám mép phải khung cuộn cột Khoản thu (chỗ thanh cuộn)', () => {
      Object.defineProperty(window, 'innerWidth', { value: 1915, configurable: true });
      render(<RoomContractLifecycleDrawer roomId="r204" roomName="204" initialYear={2026} onClose={vi.fn()} alignAfter={anchorAt(985.6)} />);
      expect(panel().style.left).toBe('985px');
      expect(panel().style.width).toBe('auto');
    });

    it('cột Thu chiếm gần hết bề ngang → giữ bề rộng mặc định 760px', () => {
      Object.defineProperty(window, 'innerWidth', { value: 1915, configurable: true });
      render(<RoomContractLifecycleDrawer roomId="r204" roomName="204" initialYear={2026} onClose={vi.fn()} alignAfter={anchorAt(1880)} />);
      expect(panel().style.left).toBe(`${1915 - 760}px`);
    });

    it('không có mốc → rộng mặc định theo CSS', () => {
      render(<RoomContractLifecycleDrawer roomId="r204" roomName="204" initialYear={2026} onClose={vi.fn()} />);
      expect(panel().style.left).toBe('');
    });
  });
});
