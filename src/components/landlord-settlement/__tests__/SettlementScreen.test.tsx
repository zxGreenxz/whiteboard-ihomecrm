// @vitest-environment jsdom
// Giao diện Quyết toán vận hành v3 (thiết kế Claude Design v3b, 23/10/2026) — khung chung cho màn quản trị
// và link chủ nhà /qt/:token. Kiểm: tab mặc định / chuyển tab, ô sổ lọc danh sách (tổng là số server),
// Bàn giao (nút xác nhận chỉ ở link chủ nhà + tháng đã chốt chưa xác nhận, gửi đúng revision), nút gạt
// người giữ cọc chỉ BÁO lên trang (không gọi RPC), Thống kê (trạng thái xác nhận + cách tính trong dòng).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

const m = vi.hoisted(() => ({ confirm: vi.fn(), note: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@/hooks/useLandlordSettlement', () => ({
  useConfirmLandlordMonth: () => ({ isPending: false, mutateAsync: m.confirm }),
  useUpdateLandlordHandoverNote: () => ({ isPending: false, mutateAsync: m.note }),
}));
vi.mock('sonner', () => ({ toast: { success: m.success, info: m.info, error: vi.fn(), warning: vi.fn() } }));

import { SettlementScreen } from '../SettlementScreen';
import { ROOM_DATA_V3, closedMonth, monthV3, overviewV3 } from './settlementFixtures';

type Props = ComponentProps<typeof SettlementScreen>;
const ve = (p: Partial<Props> = {}) => render(
  <SettlementScreen mode="admin" buildingName="Toà A" landlordName="Chủ nhà A" month={monthV3()} overview={overviewV3()}
    months={['2026-11', '2026-10', '2026-09', '2026-08']} selectedMonth="2026-10" onSelectMonth={vi.fn()} buildingId="toa-1" {...p} />,
);
const tab = (name: RegExp) => screen.getByRole('tab', { name });
const tien = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const innerWidth = window.innerWidth;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
});

it('mặc định tab Thu chi; chuyển được sang Quyết toán / Bàn giao / Thống kê; thẻ quyết toán ở đầu trang mở tab Quyết toán', () => {
  ve();
  expect(tab(/Thu chi/).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByTestId('settlement-who-grid')).toBeTruthy();
  fireEvent.click(tab(/Thống kê/));
  expect(tab(/Thống kê/).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByTestId('settlement-stats')).toBeTruthy();
  expect(screen.queryByTestId('settlement-who-grid')).toBeNull();
  fireEvent.click(tab(/Bàn giao/));
  expect(screen.getByTestId('settlement-handover')).toBeTruthy();
  fireEvent.click(screen.getByTestId('settlement-hero-net'));
  expect(tab(/Quyết toán/).getAttribute('aria-selected')).toBe('true');
  // cách tính: số lấy nguyên server, kết quả là landlord_owes_manager
  const net = within(screen.getByTestId('settlement-net'));
  expect(tien(net.getByTestId('settlement-net-result'))).toMatch(/Chủ nhà trả quản lý\s*4\.700\.000 đ/);
  const rows = net.getAllByTestId('calc-row').map((r) => r.getAttribute('data-key'));
  expect(rows).toEqual(['share', 'paid', 'collected', 'deposit']);
});

it('đầu trang: Doanh thu − Chi phí = Lợi nhuận, phần quản lý, chip trạng thái; nút tháng tắt ở hai đầu', () => {
  const chon = vi.fn();
  ve({ onSelectMonth: chon, selectedMonth: '2026-11', month: monthV3({ is_current_month: true, period_month: '2026-11-01' }) });
  const kpi = tien(screen.getByTestId('settlement-hero-kpis'));
  expect(kpi).toMatch(/Doanh thu\s*23\.000\.000 đ/);
  expect(kpi).toMatch(/Lợi nhuận\s*18\.000\.000 đ/);
  expect(kpi).toMatch(/Quản lý 15% · 2\.700\.000 đ/);
  // thanh = phần quản lý / lợi nhuận (chỉ để vẽ)
  expect(screen.getByTestId('settlement-manager-bar').style.width).toBe('15%');
  expect(screen.getByTestId('chip-status').textContent).toBe('Tạm tính — tháng đang chạy');
  expect(screen.getByTestId('chip-pending').textContent).toBe('Không còn phiếu chờ duyệt');
  const sau = screen.getByRole('button', { name: 'Tháng sau' }) as HTMLButtonElement;
  expect(sau.disabled).toBe(true);
  expect(sau.title).toBe('Chưa có tháng sau');
  fireEvent.click(screen.getByRole('button', { name: 'Tháng trước' }));
  expect(chon).toHaveBeenCalledWith('2026-10');
});

it('link chủ nhà: đầu trang chỉ còn Doanh thu / Chi phí / Lợi nhuận (chủ nhắn 24/10/2026); không lộ người chốt hay đối chiếu', () => {
  const bridge = { kqkd_profit: 18_000_000, settlement_profit: 18_000_000, rows: [] };
  ve({ mode: 'public', buildingId: undefined, token: 'tok', month: closedMonth({ kqkd_bridge: bridge }) });
  expect(tien(screen.getByTestId('settlement-hero-kpis'))).toMatch(/Doanh thu\s*23\.000\.000 đ.*Lợi nhuận\s*18\.000\.000 đ/);
  for (const id of ['settlement-manager-bar', 'settlement-hero-net', 'chip-status', 'chip-pending', 'chip-bridge']) {
    expect(screen.queryByTestId(id), id).toBeNull();
  }
  expect(within(screen.getByTestId('settlement-hero')).queryByText(/Quản lý nhận/)).toBeNull();
  cleanup();
  ve({ month: closedMonth({ kqkd_bridge: bridge }) });
  expect(screen.getByTestId('chip-status').textContent).toBe('Đã chốt lúc 08:30 · 01/11/2026 bởi Quản trị A');
  expect(screen.getByTestId('chip-bridge').textContent).toBe('Khớp Báo cáo LN · 18.000.000 đ');
});

it('Khoản chi: ô đầu dòng là bên chi — QL (quản lý / vận hành chi), CN (chủ nhà chi); cột ghi "Bên chi"', () => {
  ve();
  const chi = within(screen.getByTestId('settlement-expense-card'));
  expect(chi.getByText('Bên chi')).toBeTruthy();
  const o = chi.getAllByTestId('settlement-row-tile');
  expect(o.map((x) => x.textContent)).toEqual(o.map(() => 'QL'));
  expect(o[0]?.getAttribute('title')).toBe('Quản lý (vận hành) chi');
  cleanup();
  const st = monthV3().statement!;
  const chuNhaChi = { ...st.vouchers.find((v) => v.type === 'EXPENSE')!, side: 'LANDLORD' as const };
  ve({ month: { ...monthV3(), statement: { ...st, vouchers: [...st.vouchers, chuNhaChi] } } });
  const tiles = within(screen.getByTestId('settlement-expense-card')).getAllByTestId('settlement-row-tile').map((x) => x.textContent);
  expect(tiles).toContain('CN');
  // khoản thu vẫn ghi tên phòng
  expect(within(screen.getByTestId('settlement-income-card')).getAllByTestId('settlement-row-tile').every((x) => !['CN', 'QL'].includes(x.textContent ?? ''))).toBe(true);
});

it('Khoản thu hiện đủ phòng như Báo cáo LN: xếp MB → số → chữ, PARIS 2 "Chưa đóng", MB "Phòng trống"; lọc theo sổ thì ẩn ghi chú', () => {
  for (const mode of ['admin', 'public'] as const) {
    const p = mode === 'public' ? { buildingId: undefined, token: 'tok' } : {};
    ve({ mode, ...p, month: monthV3({ room_data: ROOM_DATA_V3 }) });
    const thu = within(screen.getByTestId('settlement-income-card'));
    // 103 thu vào sổ quản lý ⇒ ô phòng gắn thêm ký hiệu sổ quản lý (thiết kế v2)
    expect(thu.getAllByTestId('settlement-row-tile').map((x) => x.textContent)).toEqual(['MB', '101', '102', '103QL', 'PARIS 2']);
    const ghiChu = thu.getAllByTestId('settlement-room-note');
    expect(ghiChu.map((x) => x.getAttribute('data-tone'))).toEqual(['vacant', 'unpaid']);
    expect(tien(ghiChu[0])).toMatch(/Phòng trống.*Trống phòng/);
    expect(tien(ghiChu[1])).toMatch(/Chưa đóng.*Có hoá đơn, chưa thu 4\.500\.000 đ/);
    // ghi chú không phải phiếu: số khoản và tổng giữ nguyên
    expect(thu.getByText('3 khoản')).toBeTruthy();
    expect(tien(thu.getByTestId('settlement-list-total'))).toBe('23.000.000 đ');
    fireEvent.click(screen.getByRole('button', { name: /Chủ nhà nhận/ }));
    expect(within(screen.getByTestId('settlement-income-card')).queryAllByTestId('settlement-room-note')).toHaveLength(0);
    cleanup();
  }
  // server cũ (không có room_data) ⇒ như trước, không ghi chú
  ve();
  expect(within(screen.getByTestId('settlement-income-card')).queryAllByTestId('settlement-room-note')).toHaveLength(0);
  cleanup();
  // tháng đã chốt: khớp ảnh chốt thì vẫn ghi; có phiếu đổi sau chốt (ghi chú sống lệch ảnh chốt) thì ẩn
  ve({ month: closedMonth({ room_data: ROOM_DATA_V3 }) });
  expect(within(screen.getByTestId('settlement-income-card')).getAllByTestId('settlement-room-note')).toHaveLength(2);
  cleanup();
  ve({ month: closedMonth({ room_data: ROOM_DATA_V3, is_stale: true }) });
  expect(within(screen.getByTestId('settlement-income-card')).queryAllByTestId('settlement-room-note')).toHaveLength(0);
});

it('Khoản thu (thiết kế v2): màn rộng là bảng Tiền phòng · Điện · Nước · PDV · Tổng; PDV gộp khoản khác; giảm trừ / thu một phần có ghi chú, làm tròn không; phiếu chưa tách ghi tên', () => {
  const st = monthV3().statement!;
  const khong = { discount: 0, debt: 0, rounding: 0 };
  const parts = { ...khong, rent: 6_200_000, electric: 827_000, water: 0, service: 300_000, other: 100_000,
    discount: -200_000, rounding: -700, invoice_amount: 7_226_300, partial: false };
  const vouchers = st.vouchers.map((v) => (v.code === 'PT2' ? { ...v, amount: 7_226_300, parts }
    // PT3 lập tháng trước nhưng tính theo kỳ tháng này — khoản thu không ghi "tính theo kỳ" nữa (chủ nhắn 26/10/2026)
    : v.code === 'PT3' ? { ...v, voucher_date: '2026-09-28', parts: { ...khong, rent: 2_000_000, electric: 700_000, water: 300_000,
      service: 0, other: 0, invoice_amount: 6_000_000, partial: true } } : v));
  ve({ month: { ...monthV3(), statement: { ...st, vouchers } } });
  const thu = within(screen.getByTestId('settlement-income-card'));
  expect(thu.getByText('Tiền phòng')).toBeTruthy();
  expect(thu.getByText('PDV')).toBeTruthy();
  const dong = thu.getAllByTestId('settlement-cash-row');
  expect(dong.map((r) => r.getAttribute('data-layout'))).toEqual(['table-other', 'table', 'table']);
  const o = within(dong[1]).getAllByTestId('income-part-cell');
  expect(o.map((x) => x.textContent)).toEqual(['6.200.000', '827.000', '—', '400.000']);
  expect(o[3]?.getAttribute('title')).toBe('Phí dịch vụ 300.000 + khoản khác trên hoá đơn 100.000');
  // giảm trừ ngay dưới tổng tiền, chỉ "−200k" (chủ nhắn 26/10/2026); làm tròn không ghi
  expect(within(dong[1]).getByTestId('settlement-row-adjust').textContent).toBe('−200k');
  expect(tien(dong[1])).toMatch(/7\.226\.300 đ\s*−200k$/);
  expect(tien(dong[1])).not.toMatch(/Giảm trừ|làm tròn|700/i);
  // ngày · mã · sổ không còn trên dòng — nằm ở tooltip
  expect(dong[1]?.getAttribute('title')).toMatch(/05\/10\/2026 · PT2 · Sổ chủ nhà$/);
  expect(tien(dong[2])).toMatch(/thu một phần \(hoá đơn 6\.000\.000\) — chia theo tỷ lệ/);
  expect(tien(dong[2])).not.toMatch(/tính theo kỳ/);
  expect(within(dong[2]).getByTestId('settlement-row-book').textContent).toBe('QL');
  // phiếu chưa tách (ảnh chốt cũ / không theo hoá đơn): tên + chi tiết hạng mục trải qua bốn cột
  expect(within(dong[0]).getByTestId('settlement-voucher-name').textContent).toBeTruthy();
  expect(within(dong[0]).getByTestId('settlement-voucher-lines').textContent).toBe('Tiền phòng 10.000.000 đ · Tiền điện 2.000.000 đ');
  cleanup();
  // màn hẹp: phiếu có phần tách xếp bốn ô dưới "Tổng thu"; phiếu chưa tách giữ kiểu danh sách
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
  ve({ month: { ...monthV3(), statement: { ...st, vouchers } } });
  const hep = within(screen.getByTestId('settlement-income-card')).getAllByTestId('settlement-cash-row');
  expect(hep.map((r) => r.getAttribute('data-layout'))).toEqual(['list', 'stack', 'stack']);
  expect(tien(hep[1])).toMatch(/^.*Tổng thu\s*7\.226\.300 đ\s*−200k.*Tiền phòng\s*6\.200\.000.*PDV\s*400\.000/);
});

it('"Theo hạng mục" mặc định THU GỌN ở cả hai thẻ (hai cột thẳng hàng); bấm ở một thẻ thì mở / đóng CẢ HAI', () => {
  ve();
  const the = (id: string) => within(screen.getByTestId(id));
  const nut = (id: string) => the(id).getByRole('button', { name: /Theo hạng mục/ });
  for (const id of ['settlement-income-card', 'settlement-expense-card']) {
    expect(nut(id).getAttribute('aria-expanded')).toBe('false');
  }
  expect(document.getElementById('settlement-categories-list-income')).toBeNull();
  expect(document.getElementById('settlement-categories-list-expense')).toBeNull();
  fireEvent.click(nut('settlement-expense-card'));
  for (const id of ['settlement-income-card', 'settlement-expense-card']) {
    expect(nut(id).getAttribute('aria-expanded')).toBe('true');
  }
  expect(document.getElementById('settlement-categories-list-income')).not.toBeNull();
  expect(document.getElementById('settlement-categories-list-expense')).not.toBeNull();
  fireEvent.click(nut('settlement-income-card'));
  expect(document.getElementById('settlement-categories-list-income')).toBeNull();
  expect(document.getElementById('settlement-categories-list-expense')).toBeNull();
});

it('ô sổ: bấm "Chủ nhà nhận" lọc danh sách theo sổ chủ nhà (tổng = số server), bấm lại bỏ lọc', () => {
  ve();
  const thu = () => within(screen.getByTestId('settlement-income-card'));
  expect(thu().getAllByTestId('settlement-cash-row')).toHaveLength(3);
  expect(tien(thu().getByTestId('settlement-list-total'))).toBe('23.000.000 đ');
  fireEvent.click(screen.getByRole('button', { name: /Chủ nhà nhận/ }));
  expect(screen.getByTestId('settlement-filter-bar').textContent).toMatch(/sổ chủ nhà/);
  expect(thu().getAllByTestId('settlement-cash-row')).toHaveLength(2);
  expect(tien(thu().getByTestId('settlement-list-total'))).toBe('20.000.000 đ');
  // hạng mục theo bên sổ: phần chủ nhà của "Tiền phòng" là 18tr (mở khối "Theo hạng mục" — mặc định thu gọn)
  fireEvent.click(thu().getByRole('button', { name: /Theo hạng mục/ }));
  expect(tien(thu().getByTestId('settlement-categories-income'))).toMatch(/Tiền phòng\s*18\.000\.000 đ\s*90%/);
  // sổ chủ nhà không chi gì ⇒ thẻ chi rỗng
  expect(within(screen.getByTestId('settlement-expense-card')).queryAllByTestId('settlement-cash-row')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /Chủ nhà nhận/ }));
  expect(screen.queryByTestId('settlement-filter-bar')).toBeNull();
  expect(thu().getAllByTestId('settlement-cash-row')).toHaveLength(3);
  // chi tiết hạng mục của phiếu nhiều dòng
  expect(thu().getAllByTestId('settlement-voucher-lines')[0]?.textContent).toBe('Tiền phòng 10.000.000 đ · Tiền điện 2.000.000 đ');
  // phiếu cọc không lẫn vào khoản thu — nằm ở "Khoản khác"
  expect(screen.getByTestId('settlement-other-vouchers')).toBeTruthy();
});

it('khung hẹp: hai nút chuyển Khoản thu / Khoản chi', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
  ve();
  expect(screen.getByTestId('settlement-screen').getAttribute('data-narrow')).toBe('true');
  expect(screen.getByTestId('settlement-income-card')).toBeTruthy();
  expect(screen.queryByTestId('settlement-expense-card')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Khoản chi · 1' }));
  expect(screen.getByTestId('settlement-expense-card')).toBeTruthy();
  expect(screen.queryByTestId('settlement-income-card')).toBeNull();
});

it('Bàn giao — link chủ nhà, tháng đã chốt chưa xác nhận: có nút, gửi đúng tháng + revision + ghi chú', async () => {
  m.confirm.mockResolvedValue({ status: 'CONFIRMED', confirmed_at: '2026-11-03T02:12:00Z' });
  ve({ mode: 'public', buildingId: undefined, token: 'tok-abc', month: closedMonth() });
  expect(screen.getByTestId('tab-handover-wait')).toBeTruthy();
  fireEvent.click(tab(/Bàn giao/));
  // ghi chú bàn giao của quản lý hiện nguyên (giữ xuống dòng)
  expect(screen.getByTestId('settlement-handover-note').textContent).toBe('P.103 chuyển khoản vào sổ quản lý.\nĐã sửa máy lạnh 301.');
  fireEvent.change(screen.getByLabelText('Ghi chú của chủ nhà (không bắt buộc)'), { target: { value: '  Khớp sổ  ' } });
  const nut = screen.getByRole('button', { name: 'Xác nhận đã xem số liệu' });
  fireEvent.click(nut);
  fireEvent.click(nut);
  await waitFor(() => expect(m.success).toHaveBeenCalled());
  expect(m.confirm).toHaveBeenCalledTimes(1);
  expect(m.confirm).toHaveBeenCalledWith({ token: 'tok-abc', month: '2026-10-01', revision: 3, note: 'Khớp sổ' });
});

it('Bàn giao — 40001 (vừa mở chốt / chốt lại): báo tải lại, không báo thành công; trang nạp lần chốt mới vẫn GIỮ ghi chú đang gõ, gửi lại đúng lần chốt mới', async () => {
  m.confirm.mockRejectedValueOnce({ code: '40001', message: 'Bên quản lý vừa chốt lại tháng này' });
  const p = { mode: 'public' as const, buildingId: undefined, token: 'tok' };
  const { rerender } = ve({ ...p, month: closedMonth() });
  fireEvent.click(tab(/Bàn giao/));
  fireEvent.change(screen.getByLabelText('Ghi chú của chủ nhà (không bắt buộc)'), { target: { value: 'P.302 trả tiền mặt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận đã xem số liệu' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/tải lại số mới/);
  expect(m.success).not.toHaveBeenCalled();
  // trang nạp lại: bên quản lý đã chốt lại (lần chốt 5)
  const chotLai = closedMonth({ closed: { ...closedMonth().closed!, revision: 5 } });
  rerender(<SettlementScreen mode="public" buildingName="Toà A" landlordName="Chủ nhà A" month={chotLai} overview={overviewV3()}
    months={['2026-11', '2026-10', '2026-09', '2026-08']} selectedMonth="2026-10" onSelectMonth={vi.fn()} token="tok" />);
  expect((screen.getByLabelText('Ghi chú của chủ nhà (không bắt buộc)') as HTMLTextAreaElement).value).toBe('P.302 trả tiền mặt');
  m.confirm.mockResolvedValueOnce({ status: 'CONFIRMED', confirmed_at: '2026-11-03T02:12:00Z' });
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận đã xem số liệu' }));
  await waitFor(() => expect(m.success).toHaveBeenCalled());
  expect(m.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 5, note: 'P.302 trả tiền mặt' }));
});

it('Bàn giao — đã có xác nhận từ trước (ALREADY_CONFIRMED): báo rõ ghi chú lần này không lưu, không báo "đã xác nhận" như lần đầu', async () => {
  m.confirm.mockResolvedValue({ status: 'ALREADY_CONFIRMED', confirmed_at: '2026-11-03T02:12:00Z' });
  ve({ mode: 'public', buildingId: undefined, token: 'tok', month: closedMonth() });
  fireEvent.click(tab(/Bàn giao/));
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận đã xem số liệu' }));
  await waitFor(() => expect(m.info).toHaveBeenCalled());
  expect(String(m.info.mock.calls[0]?.[0])).toMatch(/đã được xác nhận trước đó lúc 09:12 · 03\/11\/2026 — ghi chú lần này không được lưu/);
  expect(m.success).not.toHaveBeenCalled();
});

it('Bàn giao — nút xác nhận KHÔNG có ở màn quản trị; tháng mở ⇒ nút tắt; đã xác nhận ⇒ khối xanh', () => {
  ve({ month: closedMonth() });
  fireEvent.click(tab(/Bàn giao/));
  expect(screen.queryByRole('button', { name: 'Xác nhận đã xem số liệu' })).toBeNull();
  expect(screen.getByTestId('settlement-not-confirmed')).toBeTruthy();
  // admin, tháng đã chốt: sửa ghi chú bàn giao
  expect((screen.getByLabelText('Ghi chú bàn giao của quản lý') as HTMLTextAreaElement).value).toMatch(/^P\.103/);
  cleanup();

  ve({ mode: 'public', buildingId: undefined, token: 'tok' });
  fireEvent.click(tab(/Bàn giao/));
  expect((screen.getByRole('button', { name: 'Xác nhận đã xem số liệu' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();

  ve({ mode: 'public', buildingId: undefined, token: 'tok',
    month: closedMonth({ confirmation: { confirmed_at: '2026-11-03T02:12:00Z', note: 'Khớp sổ' } }) });
  expect(screen.getByTestId('tab-handover-ok')).toBeTruthy();
  fireEvent.click(tab(/Bàn giao/));
  expect(screen.queryByRole('button', { name: 'Xác nhận đã xem số liệu' })).toBeNull();
  const ok = tien(screen.getByTestId('settlement-confirmed'));
  expect(ok).toMatch(/Chủ nhà A đã xác nhận đã xem số liệu tháng 10\/2026/);
  expect(ok).toMatch(/Lúc 09:12 · 03\/11\/2026/);
  expect(ok).toMatch(/Khớp sổ/);
  cleanup();
  // link tên miền: xác nhận ghi theo người xem (tên gắn với PIN) ⇒ hiện đúng người đó
  ve({ month: closedMonth({ confirmation: { confirmed_at: '2026-11-03T02:12:00Z', note: null, by: 'Người xem A' } }) });
  fireEvent.click(tab(/Bàn giao/));
  expect(tien(screen.getByTestId('settlement-confirmed'))).toMatch(/Người xem A đã xác nhận đã xem số liệu tháng 10\/2026/);
});

it('Bàn giao — admin sửa ghi chú sau khi chốt: gửi đúng revision của lần chốt đang hiện', async () => {
  m.note.mockResolvedValue({ status: 'UPDATED', revision: 3, updated_at: '2026-11-02T00:00:00Z' });
  ve({ month: closedMonth() });
  fireEvent.click(tab(/Bàn giao/));
  fireEvent.change(screen.getByLabelText('Ghi chú bàn giao của quản lý'), { target: { value: 'Ghi chú mới' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu ghi chú' }));
  await waitFor(() => expect(m.success).toHaveBeenCalled());
  expect(m.note).toHaveBeenCalledWith({ buildingId: 'toa-1', month: '2026-10-01', revision: 3, note: 'Ghi chú mới' });
});

it('Bàn giao — admin: người khác chốt lại (lần chốt mới, ghi chú mới) ⇒ chưa gõ gì thì ô nạp ghi chú mới; đã gõ thì giữ chữ đang gõ', () => {
  const ve2 = (month: ReturnType<typeof closedMonth>) => (
    <SettlementScreen mode="admin" buildingName="Toà A" landlordName="Chủ nhà A" month={month} overview={overviewV3()}
      months={['2026-11', '2026-10', '2026-09', '2026-08']} selectedMonth="2026-10" onSelectMonth={vi.fn()} buildingId="toa-1" />
  );
  const chotLai = (note: string) => closedMonth({ closed: { ...closedMonth().closed!, revision: 5, note } });
  const o = () => screen.getByLabelText('Ghi chú bàn giao của quản lý') as HTMLTextAreaElement;
  const { rerender } = render(ve2(closedMonth()));
  fireEvent.click(tab(/Bàn giao/));
  rerender(ve2(chotLai('Ghi chú lần chốt lại')));
  expect(o().value).toBe('Ghi chú lần chốt lại');
  // không còn "đã sửa" giả ⇒ nút lưu tắt
  expect((screen.getByRole('button', { name: 'Lưu ghi chú' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(o(), { target: { value: 'Tôi đang gõ dở' } });
  rerender(ve2(chotLai('Ghi chú khác của người khác')));
  expect(o().value).toBe('Tôi đang gõ dở');
});

it('nút gạt người giữ cọc (admin): toà chưa chốt tháng nào ⇒ bấm lựa chọn khác chỉ báo lên trang; toà đã chốt tháng ⇒ tắt; link chủ nhà chỉ thấy chip', () => {
  const doi = vi.fn();
  const ov = overviewV3();
  const chuaChot = { ...ov, months: ov.months.map((m) => ({ ...m, status: 'OPEN' as const })) };
  ve({ onRequestDepositHolder: doi, overview: chuaChot });
  fireEvent.click(tab(/Quyết toán/));
  const quanLy = screen.getByRole('radio', { name: 'Quản lý' });
  expect(quanLy.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(quanLy);
  expect(doi).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: 'Chủ nhà' }));
  expect(doi).toHaveBeenCalledWith('LANDLORD');
  // cọc theo sổ: sổ quản lý có 5,4tr (số server)
  expect(tien(screen.getByTestId('settlement-deposit-manager'))).toBe('5.400.000 đ');
  cleanup();

  // toà đã chốt tháng 12/2025 (tháng đang xem vẫn mở): người giữ cọc là cài đặt của toà ⇒ khoá
  ve({ onRequestDepositHolder: doi });
  fireEvent.click(tab(/Quyết toán/));
  const chuNha = screen.getByRole('radio', { name: 'Chủ nhà' }) as HTMLButtonElement;
  expect(chuNha.disabled).toBe(true);
  expect(chuNha.title).toBe('Toà đã chốt tháng 12/2025 — người giữ cọc chỉ đổi được khi chưa chốt tháng nào');
  fireEvent.click(chuNha);
  expect(doi).toHaveBeenCalledTimes(1);
  cleanup();

  ve({ mode: 'public', buildingId: undefined, token: 'tok', month: closedMonth({}, { deposit_holder: 'LANDLORD' }) });
  fireEvent.click(tab(/Quyết toán/));
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.getByTestId('settlement-holder-chip').textContent).toBe('Người giữ cọc: Chủ nhà');
  // link chủ nhà, tháng đã chốt chưa xác nhận: thẻ dẫn sang Bàn giao
  fireEvent.click(screen.getByTestId('settlement-go-handover'));
  expect(tab(/Bàn giao/).getAttribute('aria-selected')).toBe('true');
});

it('ảnh chốt cũ (thiếu người giữ cọc / cọc sổ quản lý): luật cũ "Quản lý", cọc sổ quản lý hiện "—"', () => {
  ve({ month: monthV3({}, { deposit_holder: undefined, deposits: { received: 0, paid_out: 0, landlord_received: 0, landlord_paid_out: 0 } }) });
  fireEvent.click(tab(/Quyết toán/));
  expect(screen.getByRole('radio', { name: 'Quản lý' }).getAttribute('aria-checked')).toBe('true');
  expect(tien(screen.getByTestId('settlement-deposits'))).toMatch(/Thu — · hoàn, cấn —/);
});

it('Thống kê: chọn năm, trạng thái xác nhận từng tháng, mở "Cách tính" trong dòng, bấm tên tháng để xem tháng đó', () => {
  const chon = vi.fn();
  ve({ onSelectMonth: chon });
  fireEvent.click(tab(/Thống kê/));
  const dong = (k: string) => screen.getByTestId('settlement-stats').querySelector(`[data-month="${k}"]`);
  // năm của tháng đang xem (2026), mới nhất trước
  expect(screen.getAllByTestId('settlement-stat-row').map((r) => r.getAttribute('data-month'))).toEqual(['2026-11', '2026-10', '2026-09']);
  const trangThai = (k: string) => tien(dong(k)?.querySelector('[data-testid="settlement-stat-status"]') ?? null);
  expect(trangThai('2026-11')).toMatch(/^Đang chạy/);
  expect(trangThai('2026-10')).toBe('Chờ xác nhận');
  expect(trangThai('2026-09')).toBe('Đã xác nhận 02/10/2026');

  fireEvent.click(within(dong('2026-09') as HTMLElement).getByTestId('settlement-stat-net'));
  const calc = within(screen.getByTestId('settlement-stat-calc'));
  expect(calc.getAllByTestId('calc-row').map((r) => r.getAttribute('data-key'))).toEqual(['share', 'paid', 'collected', 'deposit']);
  expect(calc.getByText('− Cọc của khách ở sổ quản lý')).toBeTruthy();
  fireEvent.click(calc.getByRole('button', { name: 'Đóng cách tính' }));
  expect(screen.queryByTestId('settlement-stat-calc')).toBeNull();

  fireEvent.click(within(dong('2026-09') as HTMLElement).getByRole('button', { name: 'Tháng 9/2026' }));
  expect(chon).toHaveBeenCalledWith('2026-09');

  // năm cũ: tháng thiếu trường v3 ⇒ chỉ dòng phần quản lý, không tự tính các dòng khác
  fireEvent.click(screen.getByRole('tab', { name: 'Năm 2025' }));
  expect(screen.getAllByTestId('settlement-stat-row').map((r) => r.getAttribute('data-month'))).toEqual(['2025-12']);
  expect(trangThai('2025-12')).toBe('Chưa xác nhận');
  fireEvent.click(screen.getByTestId('settlement-stat-net'));
  expect(within(screen.getByTestId('settlement-stat-calc')).getAllByTestId('calc-row').map((r) => r.getAttribute('data-key'))).toEqual(['share']);
  // màn quản trị: phần cộng dồn và thanh toán (xem / huỷ khoản đã ghi) vẫn còn
  expect(screen.getByTestId('settlement-balance')).toBeTruthy();
  expect(screen.getByText('Hai bên đã trả nhau')).toBeTruthy();
});

it('Thống kê — link chủ nhà: KHÔNG có khối "Tổng quyết toán" (chủ nhắn 24/10/2026), bảng thống kê vẫn có', () => {
  ve({ mode: 'public', buildingId: undefined, token: 'tok' });
  fireEvent.click(tab(/Thống kê/));
  expect(screen.getAllByTestId('settlement-stat-row').length).toBeGreaterThan(0);
  expect(screen.queryByText('Tổng quyết toán')).toBeNull();
  expect(screen.queryByTestId('settlement-balance')).toBeNull();
  expect(screen.queryByText('Hai bên đã trả nhau')).toBeNull();
});

it('tháng đã chốt mà phiếu đổi sau khi chốt: vẫn cảnh báo (admin đỏ, link chủ nhà trung tính)', () => {
  ve({ month: closedMonth({ is_stale: true }) });
  expect(screen.getByTestId('settlement-stale').getAttribute('role')).toBe('alert');
  expect(screen.getByTestId('chip-status').textContent).toBe('Phiếu đã đổi sau khi chốt');
  cleanup();
  ve({ mode: 'public', buildingId: undefined, token: 'tok', month: closedMonth({ is_stale: true }) });
  // link chủ nhà không còn chip trạng thái ở đầu trang — dòng báo ở thân trang vẫn nói rõ
  expect(screen.getByTestId('settlement-stale').textContent).toMatch(/bên quản lý sẽ chốt lại/);
  expect(screen.queryByTestId('chip-status')).toBeNull();
});

it('ký hiệu sổ của toà: ô đầu dòng Khoản chi + 2 nút lọc trên dòng tiêu đề thẻ (bấm lại bỏ lọc); chưa đặt ⇒ CN / QL', () => {
  ve({ overview: overviewV3({ landlord_book_code: 'CG', manager_book_code: 'ET' }) });
  const chi = () => within(screen.getByTestId('settlement-expense-card'));
  expect(chi().getAllByTestId('settlement-row-tile').map((x) => x.textContent)).toEqual(['ET']);
  const thu = () => within(screen.getByTestId('settlement-income-card'));
  const nut = (s: 'LANDLORD' | 'MANAGER') => thu().getByTestId(`settlement-book-filter-${s}`);
  expect([nut('LANDLORD').textContent, nut('MANAGER').textContent]).toEqual(['CG', 'ET']);
  expect(thu().getAllByTestId('settlement-cash-row')).toHaveLength(3);
  fireEvent.click(nut('MANAGER'));
  expect(nut('MANAGER').getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByTestId('settlement-filter-bar').textContent).toMatch(/sổ quản lý/);
  expect(thu().getAllByTestId('settlement-cash-row')).toHaveLength(1);
  expect(tien(thu().getByTestId('settlement-list-total'))).toBe('3.000.000 đ');
  // hai thẻ cùng một bộ lọc
  expect(chi().getByTestId('settlement-book-filter-MANAGER').getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(nut('MANAGER'));
  expect(screen.queryByTestId('settlement-filter-bar')).toBeNull();
  expect(thu().getAllByTestId('settlement-cash-row')).toHaveLength(3);
  cleanup();
  ve({ mode: 'public', buildingId: undefined, token: 'tok', overview: overviewV3({ landlord_book_code: 'CG', manager_book_code: 'ET' }) });
  expect(within(screen.getByTestId('settlement-income-card')).getByTestId('settlement-book-filter-LANDLORD').textContent).toBe('CG');
  cleanup();
  ve();
  expect(within(screen.getByTestId('settlement-income-card')).getByTestId('settlement-book-filter-LANDLORD').textContent).toBe('CN');
});

it('tab Thu chi: bảng "Ai thu, ai chi" nằm DƯỚI CÙNG; "Khoản khác" chỉ ở màn quản trị', () => {
  ve();
  const grid = screen.getByTestId('settlement-who-grid');
  const other = screen.getByTestId('settlement-other-vouchers');
  const lists = screen.getByTestId('settlement-expense-card');
  expect(lists.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(other.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // bấm ô ở bảng cuối vẫn lọc danh sách phía trên
  fireEvent.click(screen.getByRole('button', { name: /Chủ nhà nhận/ }));
  expect(screen.getByTestId('settlement-filter-bar').textContent).toMatch(/sổ chủ nhà/);
  cleanup();
  ve({ mode: 'public', buildingId: undefined, token: 'tok' });
  expect(screen.queryByTestId('settlement-other-vouchers')).toBeNull();
  expect(screen.getByTestId('settlement-who-grid')).toBeTruthy();
});
