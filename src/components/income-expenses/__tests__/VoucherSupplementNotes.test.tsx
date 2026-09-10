// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoucherNote, coGhiChuHeThong } from '../VoucherNote';
import type { IncomeExpenseSupplement } from '@/lib/incomeExpenseSupplement';

vi.mock('../CommissionVoucherNote', () => ({ laPhieuHoaHong: (v: {commission_kind?: string}) => !!v.commission_kind,
  CommissionVoucherNote: () => <div>Thông tin hoa hồng gốc</div> }));
vi.mock('../TerminationRefundNote', () => ({ laPhieuTraKhachThanhLy: (v: {system_source?: string}) => v.system_source === 'termination',
  TerminationRefundNote: () => <div>Thông tin thanh lý gốc</div> }));
const supplement = { id: 'entry', note: 'Dòng bổ sung 1\nDòng bổ sung 2', attachments: ['image'],
  actor_name: 'Kế toán DEMO', created_at: '2026-09-10T04:30:00Z' } as IncomeExpenseSupplement;
afterEach(cleanup);
describe('notes visible alongside original/system notes', () => {
  it.each([{}, {commission_kind: 'sale' as const, contract_id:'contract'}, {system_source:'termination'}])('renders supplementary text and author for %j', fields => {
    const voucher = { id: 'voucher', ...fields, supplements: [supplement] };
    expect(coGhiChuHeThong(voucher)).toBe(true);
    render(<VoucherNote voucher={voucher} fallbackNotes="Ghi chú gốc" />);
    expect(screen.getByTestId('voucher-supplement-note').textContent).toContain(supplement.note);
    expect(screen.getByText(/Người bổ sung: Kế toán DEMO/)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('attributes photo-only additions even when original voucher has no notes', () => {
    render(<VoucherNote voucher={{ id:'voucher', supplements: [{ ...supplement, note: null }] }} />);
    expect(screen.getByText('Bổ sung 1 ảnh / chứng từ.')).toBeTruthy();
    expect(screen.getByText(/Người bổ sung/)).toBeTruthy();
  });
});
