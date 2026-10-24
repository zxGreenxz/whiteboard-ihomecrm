// @vitest-environment jsdom
// Hộp "Cài đặt toà vận hành": quản lý nhận tiền cố định (đ/tháng) và/hoặc % (chủ chốt 23/10/2026), người giữ
// cọc (v3 — cài đặt của TOÀ, chỉ đổi khi chưa chốt tháng nào). Kiểm: ô tiền cố định nạp theo đúng điều khoản
// của tháng đang xem, trường đã sửa giữ khi đổi tháng (so với tháng NẠP, như %), cả hai bằng 0 bị chặn trước
// khi gửi, gửi đúng số + tháng đang xem; mở từ nút gạt người giữ cọc thì chọn sẵn giá trị mới; toà đã chốt
// tháng thì khoá người giữ cọc. Số tiền / tên là giả.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DepositHolder, LandlordOperationOptions } from '@/lib/landlordSettlement';

const TOA = '00000000-0000-4000-8000-000000000011';
const SO = '00000000-0000-4000-8000-000000000021';

const m = vi.hoisted(() => ({ save: vi.fn(), codes: vi.fn(), success: vi.fn(), warning: vi.fn(), options: null as unknown }));
vi.mock('@/hooks/useLandlordSettlement', () => ({
  useLandlordOperationOptions: () => ({ data: m.options, isFetching: false, isLoading: false, isError: false, error: null }),
  useUpsertLandlordOperation: () => ({ isPending: false, mutateAsync: m.save }),
  useSetLandlordBookCodes: () => ({ isPending: false, mutateAsync: m.codes }),
}));
vi.mock('sonner', () => ({ toast: { success: m.success, warning: m.warning, error: vi.fn() } }));

import { OperationConfigDialog } from '../OperationConfigDialog';

const dk = (valid_from: string, manager_percent: number, manager_fixed_amount: number) =>
  ({ valid_from, manager_percent, manager_fixed_amount, landlord_account_ids: [SO] });

/** Mặc định: toà đã chốt tháng 10/2026, quản lý giữ cọc. `chot: null` = chưa chốt tháng nào. */
function options(terms: ReturnType<typeof dk>[], { holder = 'MANAGER', chot = '2026-10-01', codes = [null, null] }: {
  holder?: DepositHolder; chot?: string | null; codes?: [string | null, string | null];
} = {}): LandlordOperationOptions {
  const last = terms[terms.length - 1]!;
  return {
    current: {
      landlord_name: 'Chủ nhà A', manager_percent: last.manager_percent, manager_fixed_amount: last.manager_fixed_amount,
      landlord_account_ids: [SO], deposit_holder: holder, landlord_book_code: codes[0], manager_book_code: codes[1],
      terms_from: last.valid_from, effective_from: '2026-10-01', note: null, is_active: true,
      opening_balance: 0, opening_confirmed_at: '2026-10-20T00:00:00Z', opening_confirmation_stale: false,
      opening_confirmed_pre_start: 0, pre_start_landlord_deposits: 0, first_closed_month: chot,
      last_closed_month: chot, next_terms_month: chot ? '2026-11-01' : '2026-10-01', terms, updated_at: '2026-10-22T00:00:00Z',
    },
    accounts: [{ id: SO, name: 'Sổ chủ nhà', code: null, is_virtual: false, is_deleted: false, income_count_120d: 3, other_building_count_120d: 0 }],
    history: [],
  };
}

const hop = (preset: { initialTermsMonth?: string; initialDepositHolder?: DepositHolder } = {}) => (
  <OperationConfigDialog open onOpenChange={vi.fn()} initialBuildingId={TOA} {...preset}
    candidates={[{ building_id: TOA, building_name: 'Toà A', organization_id: TOA, configured: true }]} />
);
const o = (nhan: string) => screen.getByLabelText(nhan) as HTMLInputElement;
const PCT = 'Quản lý nhận (%)';
const CO_DINH = 'Quản lý nhận tiền cố định (đ/tháng)';
const THANG = 'Phần quản lý và sổ chủ nhà áp từ tháng';
const so = (v: string) => Number(v.replace(/\D/g, '') || 0);
const luu = () => fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));
const guiLan = (i: number) => m.save.mock.calls[i]?.[0] as Record<string, unknown>;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  m.save.mockResolvedValue({ building_id: TOA, created: false, terms_from: '2026-11-01', opening_needs_reconfirm: false, opening_needs_confirm: false });
  m.codes.mockResolvedValue({ status: 'UPDATED', landlord_book_code: 'CG', manager_book_code: 'ET' });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('thêm tiền cố định cạnh %: xem trước nêu đổi, gửi đúng số và LUÔN gửi tháng đang xem', async () => {
  m.options = options([dk('2026-10-01', 30, 0)]);
  render(hop());
  expect(so(o(CO_DINH).value)).toBe(0);
  expect(o(PCT).value).toBe('30');
  fireEvent.change(o(CO_DINH), { target: { value: '5000000' } });
  expect(screen.getByTestId('landlord-terms-preview').textContent).toMatch(/Từ tháng 11\/2026: tiền cố định 0\s*đ → 5\.000\.000\s*đ\/tháng\./);
  luu();
  await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
  expect(guiLan(0)).toMatchObject({ managerPercent: 30, managerFixedAmount: 5_000_000, termsFrom: '2026-11-01' });
});

it('chỉ tiền cố định (0%) lưu được; cả % lẫn tiền cố định bằng 0 ⇒ báo lỗi, không gửi', async () => {
  m.options = options([dk('2026-10-01', 30, 0)]);
  render(hop());
  fireEvent.change(o(PCT), { target: { value: '' } });
  luu();
  expect((await screen.findByText(/không để cả hai bằng 0/)).textContent).toMatch(/Nhập % lợi nhuận hoặc tiền cố định/);
  expect(m.save).not.toHaveBeenCalled();
  fireEvent.change(o(CO_DINH), { target: { value: '5000000' } });
  luu();
  await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
  expect(guiLan(0)).toMatchObject({ managerPercent: 0, managerFixedAmount: 5_000_000 });
});

it('đổi tháng đang xem: trường chưa sửa nạp theo điều khoản tháng mới, trường đã sửa (so với tháng NẠP) giữ nguyên', async () => {
  m.options = options([dk('2026-10-01', 30, 0), dk('2026-12-01', 30, 2_000_000)]);
  render(hop());
  // tháng 11 đang áp điều khoản 10: 30% + 0đ (không phải mốc mới nhất 12: 2tr); sửa % lên 40
  expect([o(PCT).value, so(o(CO_DINH).value)]).toEqual(['30', 0]);
  fireEvent.change(o(PCT), { target: { value: '40' } });
  fireEvent.change(o(THANG), { target: { value: '2026-12' } });
  // tiền cố định chưa sửa ⇒ nạp 2tr của mốc 12; % đã sửa ⇒ giữ 40
  expect(so(o(CO_DINH).value)).toBe(2_000_000);
  expect(o(PCT).value).toBe('40');
  // sửa tiền cố định rồi đổi về tháng 11: tiền cố định giữ số đã sửa
  fireEvent.change(o(CO_DINH), { target: { value: '3000000' } });
  fireEvent.change(o(THANG), { target: { value: '2026-11' } });
  expect(so(o(CO_DINH).value)).toBe(3_000_000);
  luu();
  await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
  expect(guiLan(0)).toMatchObject({ managerPercent: 40, managerFixedAmount: 3_000_000, termsFrom: '2026-11-01' });
});

it('đổi từ tháng đã chốt (kể cả chỉ đổi tiền cố định) ⇒ báo trước khi gửi', async () => {
  m.options = options([dk('2026-10-01', 30, 0)]);
  render(hop());
  fireEvent.change(o(THANG), { target: { value: '2026-10' } });
  fireEvent.change(o(CO_DINH), { target: { value: '1000000' } });
  luu();
  expect(await screen.findByText(/Đã chốt tới tháng 10\/2026/)).toBeTruthy();
  expect(m.save).not.toHaveBeenCalled();
});

it('toà CHƯA chốt tháng nào, mở từ nút gạt: chọn sẵn "Chủ nhà", nêu đổi áp mọi tháng (không phải điều khoản tháng), gửi depositHolder', async () => {
  m.options = options([dk('2026-10-01', 30, 0)], { chot: null });
  render(hop({ initialTermsMonth: '2026-11', initialDepositHolder: 'LANDLORD' }));
  expect(screen.getByRole('radio', { name: 'Chủ nhà' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByTestId('landlord-holder').textContent).toMatch(/Quản lý → Chủ nhà: áp lại cho mọi tháng từ 10\/2026/);
  // không phải thay đổi điều khoản theo tháng
  expect(screen.queryByTestId('landlord-terms-preview')).toBeNull();
  luu();
  await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
  expect(guiLan(0)).toMatchObject({ depositHolder: 'LANDLORD', managerPercent: 30 });
});

it('toà ĐÃ chốt tháng: người giữ cọc khoá, nêu lý do; mở từ nút gạt với giá trị khác ⇒ báo lỗi, không gửi', async () => {
  m.options = options([dk('2026-10-01', 30, 0)]);
  render(hop({ initialDepositHolder: 'LANDLORD' }));
  expect(screen.getByTestId('landlord-holder').textContent).toMatch(/đã chốt tháng 10\/2026 nên không đổi được nữa/);
  for (const r of screen.getAllByRole('radio')) expect((r as HTMLButtonElement).disabled).toBe(true);
  luu();
  expect(await screen.findByText(/người giữ cọc chỉ đổi được khi chưa chốt tháng nào/)).toBeTruthy();
  expect(m.save).not.toHaveBeenCalled();
});

it('mở bình thường: người giữ cọc của toà, lưu gửi lại đúng giá trị đó', async () => {
  m.options = options([dk('2026-10-01', 30, 0), dk('2026-12-01', 30, 1_000_000)], { holder: 'LANDLORD' });
  render(hop());
  expect(screen.getByRole('radio', { name: 'Chủ nhà' }).getAttribute('aria-checked')).toBe('true');
  // đổi tháng đang xem không đổi người giữ cọc (không theo điều khoản tháng)
  fireEvent.change(o(THANG), { target: { value: '2026-12' } });
  expect(screen.getByRole('radio', { name: 'Chủ nhà' }).getAttribute('aria-checked')).toBe('true');
  luu();
  await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
  expect(guiLan(0)).toMatchObject({ depositHolder: 'LANDLORD', termsFrom: '2026-12-01' });
});

it('ký hiệu sổ: nạp sẵn, đổi thì gửi RPC riêng (chuẩn hoá chữ hoa) TRƯỚC khi lưu cài đặt; không đổi thì không gọi', async () => {
  m.options = options([dk('2026-10-01', 30, 0)], { codes: ['CN', null] });
  render(hop());
  await waitFor(() => expect(o('Sổ chủ nhà').value).toBe('CN'));
  expect(o('Sổ quản lý').value).toBe('');
  expect(o('Sổ quản lý').placeholder).toBe('QL');
  fireEvent.change(o('Sổ chủ nhà'), { target: { value: ' cg ' } });
  fireEvent.change(o('Sổ quản lý'), { target: { value: 'et' } });
  luu();
  await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
  expect(m.codes).toHaveBeenCalledWith({ buildingId: TOA, landlordCode: 'CG', managerCode: 'ET' });
  expect(m.codes.mock.invocationCallOrder[0]).toBeLessThan(m.save.mock.invocationCallOrder[0]);
  cleanup();
  vi.clearAllMocks();
  m.save.mockResolvedValue({ building_id: TOA, created: false, terms_from: '2026-11-01', opening_needs_reconfirm: false, opening_needs_confirm: false });
  m.options = options([dk('2026-10-01', 30, 0)], { codes: ['CG', 'ET'] });
  render(hop());
  await waitFor(() => expect(o('Sổ chủ nhà').value).toBe('CG'));
  luu();
  await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
  expect(m.codes).not.toHaveBeenCalled();
});

it('ký hiệu sổ sai (trùng ký hiệu đang hiện, quá 4 ký tự) ⇒ báo lỗi, không gửi gì; RPC ký hiệu lỗi ⇒ không lưu cài đặt', async () => {
  m.options = options([dk('2026-10-01', 30, 0)]);
  render(hop());
  await waitFor(() => expect(o('Sổ chủ nhà').value).toBe(''));
  fireEvent.change(o('Sổ chủ nhà'), { target: { value: 'ql' } });
  luu();
  expect(await screen.findByText('Ký hiệu sổ chủ nhà và sổ quản lý phải khác nhau.')).toBeTruthy();
  fireEvent.change(o('Sổ chủ nhà'), { target: { value: 'CHUNHA' } });
  luu();
  expect(await screen.findByText('Ký hiệu sổ tối đa 4 ký tự, không có khoảng trắng.')).toBeTruthy();
  expect(m.codes).not.toHaveBeenCalled();
  expect(m.save).not.toHaveBeenCalled();
  m.codes.mockRejectedValueOnce({ code: '42501', message: 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành' });
  fireEvent.change(o('Sổ chủ nhà'), { target: { value: 'CG' } });
  luu();
  expect(await screen.findByText(/Chỉ chủ công ty hoặc quản trị hệ thống/)).toBeTruthy();
  expect(m.save).not.toHaveBeenCalled();
});
