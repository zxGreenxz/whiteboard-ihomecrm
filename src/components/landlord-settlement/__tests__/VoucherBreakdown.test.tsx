// @vitest-environment jsdom
// "Phiếu trong tháng" (quyết toán + link chủ nhà): tên hiển thị thay "Thu tiền theo HĐ INV-…" và mã hợp đồng
// (chủ nhắn 23/10/2026); phiếu hạn chế ở link chủ nhà giữ tên đã che. Mã / số giả.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { settlementVoucherSchema, type SettlementStatement } from '@/lib/landlordSettlement';
import { VoucherBreakdown } from '../VoucherBreakdown';

afterEach(() => cleanup());

const phieu = (p: Record<string, unknown>) => settlementVoucherSchema.parse({
  code: 'PT1', voucher_date: '2026-10-03', type: 'INCOME', name: 'Thu tiền theo HĐ INV-2026-01184', account_name: 'Sổ chủ nhà',
  side: 'LANDLORD', group: 'PNL', source: null, cash_reversed: false, cash_unposted: false, restricted: false,
  excluded_reason: null, status: 'APPROVED', amount: 3_000_000, room_name: '203',
  invoice: { kind: 'MONTHLY', billing_month: '2026-10', issue_date: '2026-10-01', has_rent: true, has_service: true,
    is_first_month: false, is_liquidation: false, is_extra: false },
  ...p,
});
const totals = { landlord_collected: 3_000_000 } as unknown as SettlementStatement['totals'];
const ten = () => screen.getAllByTestId('settlement-voucher-name').map((x) => x.textContent?.trim());

it.each(['admin', 'public'] as const)('%s: tên hoá đơn có phòng thay mã hoá đơn; thanh lý bỏ mã hợp đồng', (mode) => {
  render(<VoucherBreakdown mode={mode} periodMonth="2026-10-01" totals={totals} vouchers={[
    phieu({}),
    phieu({ code: 'PT2', name: 'Doanh thu bỏ cọc — HĐ HD-2026-0012', invoice: null, source: 'FORFEIT_REVENUE' }),
    phieu({ code: 'PT3', name: 'Tiền phòng anh Ba', invoice: null }),
  ]} />);
  expect(ten()).toEqual(['TIỀN PHÒNG - 203 - 10/2026', 'Doanh thu bỏ cọc — phòng 203', 'Tiền phòng anh Ba']);
  // mã phiếu vẫn ở dòng phụ
  expect(screen.getByText(/PT1/)).toBeTruthy();
});

it('ảnh chốt cũ (không có phần dựng tên) ⇒ tên gốc; link chủ nhà: phiếu hạn chế giữ tên đã che', () => {
  render(<VoucherBreakdown mode="public" periodMonth="2026-10-01" totals={totals} vouchers={[
    phieu({ room_name: undefined, invoice: undefined }),
    phieu({ code: 'PT9', name: 'Khoản hạn chế (ẩn chi tiết)', restricted: true }),
  ]} />);
  expect(ten()).toEqual(['Thu tiền theo HĐ INV-2026-01184', 'Khoản hạn chế (ẩn chi tiết)']);
  fireEvent.click(screen.getByRole('tab', { name: /Chủ nhà thu/ }));
  expect(ten().length).toBe(2);
});

it('link chủ nhà: phiếu hạn chế KHÔNG được dựng lại tên từ phần hoá đơn (kể cả gói lỡ còn phần đó)', () => {
  render(<VoucherBreakdown mode="public" periodMonth="2026-10-01" totals={totals} vouchers={[
    phieu({ code: 'PT9', restricted: true }),
  ]} />);
  expect(ten()).toEqual(['Thu tiền theo HĐ INV-2026-01184']);
  cleanup();
  // màn quản trị: người quản lý được xem đủ, dựng tên như mọi phiếu
  render(<VoucherBreakdown mode="admin" periodMonth="2026-10-01" totals={totals} vouchers={[phieu({ code: 'PT9', restricted: true })]} />);
  expect(ten()).toEqual(['TIỀN PHÒNG - 203 - 10/2026']);
});
