// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProfitReportChecks from '../ProfitReportChecks';
import { computeProfitReportChecks, type ProfitCheckRow } from '@/lib/profitReportChecks';

afterEach(cleanup);

// Số liệu giả, tròn — không phải dữ liệu thật.
const KEEP_ONLY_RENT = ['dien', 'nuoc', 'internet', 'quan_ly', 've_sinh', 'cong_an', 'rac', 'thang_may'];
const rentRow = (buildingId: string, voucherId: string, expense: number, extra: Partial<ProfitCheckRow> = {}): ProfitCheckRow => ({
  voucherId, voucherName: `Tiền nhà ${voucherId}`, buildingId, buildingName: null, voucherDate: '2026-10-05',
  typeId: 't-rent', typeName: 'Tiền nhà', category: 'Tiền nhà', income: 0, expense,
  countsInBusinessResult: true, approvalStatus: 'APPROVED', ...extra,
});
const checks = computeProfitReportChecks({
  rows: [
    rentRow('B', 'tu-lap', 20_000_000, { approvalStatus: 'UNAPPROVED', voucherDate: '2026-09-01' }),
    rentRow('B', 'lap-tay', 20_000_000),
  ],
  buildings: ['A', 'B'].map((id) => ({ id, name: `Toà ${id}`, hidden_fixed_expenses: KEEP_ONLY_RENT })),
  feeRates: [
    { buildingId: 'A', feeCategory: 'tien_nha', defaultAmount: 30_000_000 },
    { buildingId: 'B', feeCategory: 'tien_nha', defaultAmount: 20_000_000 },
  ],
  expenseTypes: [{ id: 't-rent', fee_category: 'tien_nha' }],
  today: '2026-10-22',
});

describe('ProfitReportChecks', () => {
  it('hero: chip tóm tắt, không có chip "đủ" khi còn cảnh báo', () => {
    render(<div className="ph"><ProfitReportChecks checks={checks} /></div>);
    expect(screen.getByRole('button', { name: /Thiếu chi cố định: 1 toà · ≈30tr/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Có thể trùng: 1 toà · ≈20tr/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Chờ duyệt quá 30 ngày: 1 phiếu · 20tr/ })).toBeTruthy();
    expect(screen.queryByText(/Chi cố định đủ/)).toBeNull();
    expect(document.querySelector('.ph-chip--ok')).toBeNull();
  });

  it('mobile: bấm chip xổ chi tiết toà × khoản × mức/đã có, có nút lập phiếu', () => {
    const onCreate = vi.fn();
    render(<ProfitReportChecks checks={checks} variant="mobile" onCreateExpense={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: /Thiếu chi cố định/ }));
    expect(screen.getByText('Toà A')).toBeTruthy();
    expect(screen.getByText(/chưa có phiếu · mức 30\.000\.000/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lập phiếu' }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ buildingId: 'A', key: 'tien_nha', status: 'MISSING' }));

    fireEvent.click(screen.getByRole('button', { name: /Có thể trùng/ }));
    expect(screen.getByText(/Tiền nhà tu-lap · 01\/09\/2026 · 20\.000\.000.* · chờ duyệt/)).toBeTruthy();
    expect(screen.getByText(/Tiền nhà lap-tay/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Chờ duyệt quá 30 ngày/ }));
    expect(screen.getByText(/ngày phiếu 01\/09\/2026 · đã 51 ngày/)).toBeTruthy();
  });

  it('không cảnh báo: chip trung tính, không xanh "khớp"; chip phòng từ roomSummary', () => {
    const clean = computeProfitReportChecks({
      rows: [rentRow('A', 'x', 30_000_000)],
      buildings: [{ id: 'A', name: 'Toà A', hidden_fixed_expenses: KEEP_ONLY_RENT }],
      feeRates: [{ buildingId: 'A', feeCategory: 'tien_nha', defaultAmount: 30_000_000 }],
      today: '2026-10-22',
    });
    render(
      <ProfitReportChecks
        checks={clean}
        roomSummary={{
          vacantRooms: 4, missingInvoiceRooms: 11, unpaidInvoiceRooms: 8, unpaidInvoiceAmount: 36_800_000,
          overdueInvoiceRooms: 4, endedUnsettled: 1, endedUnsettledRemaining: 0,
        }}
      />,
    );
    expect(screen.getByText('Chi cố định đủ · 1 toà').className).toBe('ph-chip');
    expect(screen.getByText('11 phòng chưa có hoá đơn')).toBeTruthy();
    expect(screen.getByText('8 hoá đơn chưa thu · 36,8tr (4 quá hạn)')).toBeTruthy();
    expect(screen.getByText('1 HĐ kết thúc chưa thanh lý')).toBeTruthy();
    expect(screen.getByText('4 phòng trống')).toBeTruthy();
  });

  it('chưa có kết quả và không có chip phòng thì không vẽ gì', () => {
    const { container } = render(<ProfitReportChecks checks={undefined} variant="mobile" />);
    expect(container.innerHTML).toBe('');
  });
});
