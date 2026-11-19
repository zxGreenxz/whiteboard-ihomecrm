// @vitest-environment jsdom
// Hộp "Ghi nhận thanh toán" quyết toán: không ghi trùng tiền và không nuốt lỗi khi lần gửi treo rồi người
// dùng đóng hộp, đổi toà, mở lại hoặc sửa nội dung.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ add: vi.fn(), success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('@/hooks/useLandlordSettlement', () => ({
  useAddLandlordPayment: () => ({ isPending: false, mutateAsync: m.add }),
  useCloseLandlordMonth: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useReopenLandlordMonth: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useVoidLandlordPayment: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: m.success, info: m.info, error: m.error } }));

import { PaymentDialog } from '../SettlementActionDialogs';

interface Args { idempotencyKey: string; buildingId: string; amount: number }
const goi = (i: number) => m.add.mock.calls[i]?.[0] as Args;
function treo() {
  let xong!: (v: unknown) => void;
  let hong!: (e: unknown) => void;
  const p = new Promise((res, rej) => { xong = res; hong = rej; });
  return { p, xong, hong };
}
const hop = (buildingId: string, open: boolean, onOpenChange = vi.fn()) => (
  <PaymentDialog open={open} onOpenChange={onOpenChange} buildingId={buildingId} buildingName={`Toà ${buildingId}`}
    suggestedDirection="LANDLORD_TO_MANAGER" />
);
const nhapTien = (v: string) => fireEvent.change(screen.getByLabelText('Số tiền'), { target: { value: v } });
const bamGhi = () => fireEvent.click(screen.getByRole('button', { name: 'Ghi nhận' }));
const tienDangHien = () => (screen.getByLabelText('Số tiền') as HTMLInputElement).value.replace(/\D/g, '');
const coCanhBao = () => screen.queryByText(/Lần ghi trước chưa xác nhận được/) !== null;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('mạng rớt: mở lại điền đúng khoản, bấm lại dùng lại khoá cũ (server không ghi thêm)', async () => {
  m.add.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  const dong = vi.fn();
  const v = render(hop('toa-1', true, dong));
  nhapTien('5000000');
  bamGhi();
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  v.rerender(hop('toa-1', false, dong));
  v.rerender(hop('toa-1', true, dong));
  expect(tienDangHien()).toBe('5000000');
  expect(coCanhBao()).toBe(true);
  m.add.mockResolvedValueOnce({ status: 'REPLAYED' });
  bamGhi();
  await waitFor(() => expect(m.info).toHaveBeenCalled());
  expect(goi(1).idempotencyKey).toBe(goi(0).idempotencyKey);
  expect(dong).toHaveBeenCalledWith(false);
});

it('lần gửi của toà A lỗi khi hộp đang mở cho toà B ⇒ vẫn báo, và toà A còn nhớ khoản đó', async () => {
  const t = treo();
  m.add.mockReturnValueOnce(t.p);
  const v = render(hop('toa-a', true));
  nhapTien('5000000');
  bamGhi();
  v.rerender(hop('toa-a', false));
  v.rerender(hop('toa-b', false));
  v.rerender(hop('toa-b', true));
  expect(tienDangHien()).toBe('');
  t.hong(new TypeError('Failed to fetch'));
  await waitFor(() => expect(m.error).toHaveBeenCalledTimes(1));
  expect(String(m.error.mock.calls[0]?.[0])).toMatch(/Toà toa-a — 5\.000\.000/);
  expect(screen.queryByRole('alert')).toBeNull();
  // ghi một khoản cho toà B không đè khoản chưa xác nhận của toà A
  m.add.mockResolvedValueOnce({ status: 'CREATED' });
  nhapTien('700000');
  bamGhi();
  await waitFor(() => expect(m.success).toHaveBeenCalled());
  v.rerender(hop('toa-b', false));
  v.rerender(hop('toa-a', false));
  v.rerender(hop('toa-a', true));
  expect(tienDangHien()).toBe('5000000');
  expect(coCanhBao()).toBe(true);
});

it('server từ chối hẳn (có mã) ⇒ không giữ khoá: bấm lại là một lần gửi mới', async () => {
  m.add.mockRejectedValueOnce({ code: '22023', message: 'Ngày thanh toán không hợp lệ' });
  render(hop('toa-2', true));
  nhapTien('300000');
  bamGhi();
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(coCanhBao()).toBe(false);
  m.add.mockResolvedValueOnce({ status: 'CREATED' });
  bamGhi();
  await waitFor(() => expect(m.success).toHaveBeenCalled());
  expect(goi(1).idempotencyKey).not.toBe(goi(0).idempotencyKey);
});

it('đọc biên nhận hỏng SAU khi server đã ghi (không có mã) ⇒ vẫn giữ khoá để thử lại không trùng', async () => {
  m.add.mockRejectedValueOnce(Object.assign(new Error('Expected object'), { name: 'ZodError' }));
  render(hop('toa-3', true));
  nhapTien('400000');
  bamGhi();
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  m.add.mockResolvedValueOnce({ status: 'REPLAYED' });
  bamGhi();
  await waitFor(() => expect(m.info).toHaveBeenCalled());
  expect(goi(1).idempotencyKey).toBe(goi(0).idempotencyKey);
});

it('mở lại rồi sửa sang khoản khác: lần cũ thành công không đóng hộp đang nhập khoản mới', async () => {
  const t = treo();
  m.add.mockReturnValueOnce(t.p);
  const dong = vi.fn();
  const v = render(hop('toa-4', true, dong));
  nhapTien('5000000');
  bamGhi();
  v.rerender(hop('toa-4', false, dong));
  v.rerender(hop('toa-4', true, dong));
  expect(tienDangHien()).toBe('5000000');
  nhapTien('6000000');
  dong.mockClear();
  t.xong({ status: 'CREATED' });
  await waitFor(() => expect(m.success).toHaveBeenCalled());
  expect(dong).not.toHaveBeenCalledWith(false);
  expect(tienDangHien()).toBe('6000000');
});

it('mở lại, điền đúng khoản đang treo: lần cũ thành công thì đóng hộp (bấm lại sẽ sinh khoá mới, ghi trùng)', async () => {
  const t = treo();
  m.add.mockReturnValueOnce(t.p);
  const dong = vi.fn();
  const v = render(hop('toa-5', true, dong));
  nhapTien('5000000');
  bamGhi();
  v.rerender(hop('toa-5', false, dong));
  v.rerender(hop('toa-5', true, dong));
  dong.mockClear();
  t.xong({ status: 'CREATED' });
  await waitFor(() => expect(dong).toHaveBeenCalledWith(false));
});
