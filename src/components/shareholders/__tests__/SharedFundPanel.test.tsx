// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SharedFundState } from '@/hooks/profit-ledger/useSharedFund';
import SharedFundPanel from '../SharedFundPanel';
import { prepareFundWrite } from '../SharedFundForm';

const mock = vi.hoisted(() => ({ write: vi.fn(), state: null as SharedFundState | null }));
vi.mock('@/hooks/profit-ledger/useSharedFund', () => ({
  useSharedFund: () => ({ data: mock.state, refetch: vi.fn() }),
  useSharedFundWrite: () => ({ mutateAsync: mock.write, isPending: false }),
  useRecordOpeningReceipts: () => ({ mutate: mock.write, isPending: false }),
}));
const fixture: SharedFundState = {
  organization_id: 'org',
  route: 'CANONICAL',
  has_opening: true,
  available_amount: 101,
  last_effective_date: null,
  sources: [],
  distributions: [],
  openings: [],
  shareholders: [
    { shareholder_id: 'alpha', name: 'Alpha', advance_outstanding: 70, unpaid_profit: 90 },
    { shareholder_id: 'beta', name: 'Beta', advance_outstanding: 0, unpaid_profit: 30 },
  ],
};
const form = {
  day: '2025-02-28',
  reference: 'REF-1',
  evidence: 'Biên bản số 1',
  kind: 'OPENING' as const,
  money: '70',
  total: '101',
  person: 'alpha',
  month: '2025-01',
  confirmed: true,
  lines: [{ person: 'alpha', gross: '50', offset: '30' }],
};
beforeEach(() => {
  mock.state = fixture;
  mock.write.mockReset().mockResolvedValue({ id: 'new-id', reconciled: false });
});
afterEach(cleanup);

describe('Phân bổ quỹ và ghi mốc', () => {
  it('nhập phiếu tháng từ mốc đã có, chỉ gửi sau khi xem lại', () => {
    mock.state = { ...fixture, openings: [{ opening_id: 'opening', shareholder_id: 'alpha',
      through_month: '2025-10-01', as_of_date: '2025-11-01', advance_amount: 70,
      evidence: 'Bảng đối chiếu', created_by: 'owner', request_key: 'fixture',
      reconciled_approved: 30, reconciled_count: 3, historical_count: 0 }] };
    render(<SharedFundPanel org="org" onSettle={vi.fn()} />);
    fireEvent.click(screen.getByText('Mốc ứng lịch sử (1)'));
    fireEvent.click(screen.getByText('Bổ sung phiếu tạm ứng theo kỳ'));
    fireEvent.change(screen.getByLabelText('Kỳ lợi nhuận'), { target: { value: '2025-01' } });
    fireEvent.change(screen.getByLabelText('Tạm ứng (đ)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Lợi nhuận ngoài sổ (đ)'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('Căn cứ đối chiếu'), { target: { value: 'Biên bản tháng một' } });
    fireEvent.change(screen.getByLabelText('Phiếu tiền gốc (mã | ngày | số tiền)'), { target: { value: 'PC-A | 2025-02-01 | 40; PC-B | 2025-02-02 | 20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra trước khi ghi' }));
    expect(mock.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Ghi phiếu lịch sử' }));
    expect(mock.write).toHaveBeenCalledWith([{ period_month:'2025-01-01', amount:100, external_profit:60, source_refs:[{code:'PC-A',date:'2025-02-01',amount:40},{code:'PC-B',date:'2025-02-02',amount:20}], evidence:'Biên bản tháng một' }]);
  });
  it('chia đều, giữ đồng lẻ, ghi 2 dòng bù và phải trả sau xác nhận', async () => {
    const settle = vi.fn();
    render(<SharedFundPanel org="org" onSettle={settle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Phân bổ cho cổ đông' }));
    fireEvent.change(screen.getByLabelText('Mã biên bản / chứng từ'), { target: { value: 'REF-2' } });
    fireEvent.change(screen.getByLabelText('Căn cứ đối chiếu'), {
      target: { value: 'Đã đối chiếu chứng từ' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Cổ đông 1' }), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByText('Thêm cổ đông'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Cổ đông 2' }), { target: { value: 'beta' } });
    fireEvent.change(screen.getByLabelText('Tổng muốn chia đều (đồng)'), { target: { value: '101' } });
    fireEvent.click(screen.getByText('Chia đều'));
    fireEvent.change(screen.getAllByLabelText('Cấn ứng (đồng)')[0], { target: { value: '50' } });
    fireEvent.click(screen.getByText('Xem lại trước khi ghi'));
    await screen.findByRole('region', { name: 'Xác nhận ghi quỹ' });
    expect(mock.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận ghi sổ' }));
    await screen.findByText(/Đã ghi quyết định phân bổ/);
    expect(mock.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'distribute',
        expected: 101,
        lines: [
          { shareholder_id: 'alpha', amount: 50, advance_offset_amount: 50 },
          { shareholder_id: 'beta', amount: 50, advance_offset_amount: 0 },
        ],
      }),
    );
    expect(settle).not.toHaveBeenCalled();
  });
  it('chặn ứng vượt, dòng trùng và số vượt quỹ', () => {
    const build = (lines: typeof form.lines) =>
      prepareFundWrite('distribute', { ...form, lines }, fixture, '2025-03-01');
    expect(() => build([{ person: 'beta', gross: '10', offset: '1' }])).toThrow(/Cấn|cấn/);
    expect(() => build([form.lines[0], form.lines[0]])).toThrow(/khác nhau/);
    expect(() => build([{ ...form.lines[0], gross: '102' }])).toThrow(/vượt/);
  });
  it('mốc đầu kỳ đòi xác nhận, tháng đã qua và căn cứ', () => {
    expect(() => prepareFundWrite('opening', { ...form, confirmed: false }, fixture, '2025-03-01')).toThrow(
      /Xác nhận/,
    );
    expect(() => prepareFundWrite('opening', { ...form, month: '2025-03' }, fixture, '2025-03-01')).toThrow(
      /kết thúc/,
    );
    expect(prepareFundWrite('opening', form, fixture, '2025-03-01')).toMatchObject({
      advance: 70,
      expectedUnpaid: 90,
      expectedApproved: 70,
      asOfDate: '2025-02-28',
    });
    expect(() =>
      prepareFundWrite('source', { ...form, confirmed: false }, { ...fixture, has_opening: false }),
    ).toThrow(/tách/);
  });
  it('không hiển thị dữ liệu công ty cũ', () => {
    render(<SharedFundPanel org="other" onSettle={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('Chưa tải được');
    expect(screen.queryByText('Quỹ khả dụng theo phân bổ')).toBeNull();
  });
});
