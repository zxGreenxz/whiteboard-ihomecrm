// @vitest-environment jsdom
// Link tên miền cho chủ nhà (24/10/2026): chưa có phiên ⇒ hỏi PIN; đăng nhập xong máy nhớ phiên; link nhiều toà có ô
// chọn toà; thoát / phiên chết ⇒ về ô PIN; xác nhận đã xem số liệu đi qua RPC của link (theo người xem). Tên giả.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  login: vi.fn(), logout: vi.fn(), confirm: vi.fn(), success: vi.fn(),
  portal: null as unknown, args: [] as unknown[][],
}));
vi.mock('@/hooks/useLandlordPortal', () => ({
  useLandlordPortalLogin: () => ({ isPending: false, mutateAsync: m.login }),
  useLandlordPortalLogout: () => ({ mutate: m.logout }),
  useConfirmLandlordPortalMonth: () => ({ mutateAsync: m.confirm }),
  useLandlordPortal: (...a: unknown[]) => { m.args.push(a); return m.portal; },
}));
vi.mock('@/hooks/useLandlordSettlement', () => ({
  useConfirmLandlordMonth: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useUpdateLandlordHandoverNote: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: m.success, info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import LandlordPortalPage from '../LandlordPortalPage';
import { closedMonth, monthV3, overviewV3 } from '@/components/landlord-settlement/__tests__/settlementFixtures';

const PHIEN = 'P'.repeat(43);
const KHOA = 'landlord-portal-session:agiang';
const goi = (p: Record<string, unknown> = {}) => ({
  viewer: 'Người xem A',
  buildings: [{ key: 'k1', building_name: 'Toà A', landlord_name: 'Chủ A' }, { key: 'k2', building_name: 'Toà B', landlord_name: 'Chủ A' }],
  selected: 'k1', overview: overviewV3(), month: monthV3(), ...p,
});
const query = (data: unknown) => ({
  data, isLoading: false, isSuccess: true, isError: false, isFetching: false, isPlaceholderData: false, error: null, refetch: vi.fn(),
});
const ve = () => render(<MemoryRouter><LandlordPortalPage slug="agiang" /></MemoryRouter>);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  m.args = [];
  m.portal = query(null);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('chưa có phiên ⇒ ô PIN; PIN sai báo số lần còn; khoá báo phút; PIN đúng ⇒ máy nhớ phiên và mở trang', async () => {
  ve();
  expect(screen.getByTestId('portal-login')).toBeTruthy();
  const o = screen.getByLabelText('Mã PIN') as HTMLInputElement;
  fireEvent.change(o, { target: { value: '12ab3' } });
  expect(o.value).toBe('123');
  fireEvent.click(screen.getByRole('button', { name: 'Vào xem' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Nhập đủ 6 số của mã PIN.');
  expect(m.login).not.toHaveBeenCalled();

  m.login.mockResolvedValueOnce({ status: 'INVALID', attempts_left: 7 });
  fireEvent.change(o, { target: { value: '502817' } });
  fireEvent.click(screen.getByRole('button', { name: 'Vào xem' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/không đúng — còn 7 lần thử/));
  expect(m.login).toHaveBeenCalledWith({ slug: 'agiang', pin: '502817' });

  m.login.mockResolvedValueOnce({ status: 'LOCKED', retry_after_seconds: 130 });
  fireEvent.change(o, { target: { value: '502817' } });
  fireEvent.click(screen.getByRole('button', { name: 'Vào xem' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/khoảng 3 phút/));

  m.portal = query(goi());
  m.login.mockResolvedValueOnce({ status: 'OK', session: PHIEN, viewer: 'Người xem A', expires_at: '2027-04-22T00:00:00Z' });
  fireEvent.change(o, { target: { value: '482916' } });
  fireEvent.click(screen.getByRole('button', { name: 'Vào xem' }));
  await waitFor(() => expect(screen.getByTestId('portal-viewer').textContent).toBe('Người xem A'));
  expect(localStorage.getItem(KHOA)).toBe(PHIEN);
  expect(m.args.at(-1)).toEqual(['agiang', PHIEN, null, null]);
});

it('đã nhớ phiên: vào thẳng; link nhiều toà ⇒ ô chọn toà (đổi toà thì về tháng mặc định); Thoát ⇒ xoá phiên, về ô PIN', () => {
  localStorage.setItem(KHOA, PHIEN);
  m.portal = query(goi());
  ve();
  const chon = screen.getByTestId('portal-building-picker') as HTMLSelectElement;
  expect([...chon.options].map((x) => x.textContent)).toEqual(['Toà A', 'Toà B']);
  expect(chon.value).toBe('k1');
  fireEvent.click(screen.getByRole('button', { name: 'Tháng trước' }));
  expect(m.args.at(-1)?.[3]).toBe('2026-09-01');
  fireEvent.change(chon, { target: { value: 'k2' } });
  expect(m.args.at(-1)).toEqual(['agiang', PHIEN, 'k2', null]);
  fireEvent.click(screen.getByRole('button', { name: /Thoát/ }));
  expect(localStorage.getItem(KHOA)).toBeNull();
  expect(m.logout).toHaveBeenCalledWith({ slug: 'agiang', session: PHIEN });
  expect(screen.getByTestId('portal-login')).toBeTruthy();
});

it('một toà ⇒ không có ô chọn toà; phiên chết (server trả NULL) ⇒ xoá phiên, hỏi lại PIN', async () => {
  localStorage.setItem(KHOA, PHIEN);
  m.portal = query(goi({ buildings: [{ key: 'k1', building_name: 'Toà A', landlord_name: 'Chủ A' }] }));
  ve();
  expect(screen.queryByTestId('portal-building-picker')).toBeNull();
  cleanup();
  m.portal = query(null);
  ve();
  await waitFor(() => expect(screen.getByTestId('portal-login')).toBeTruthy());
  expect(localStorage.getItem(KHOA)).toBeNull();
});

it('tháng đã chốt: "Xác nhận đã xem số liệu" gửi qua RPC của link với đúng phiên, toà, lần chốt', async () => {
  localStorage.setItem(KHOA, PHIEN);
  m.portal = query(goi({ month: closedMonth() }));
  m.confirm.mockResolvedValue({ status: 'CONFIRMED', confirmed_at: '2026-11-02T03:00:00Z' });
  ve();
  fireEvent.click(screen.getByRole('tab', { name: /Bàn giao/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận đã xem số liệu' }));
  await waitFor(() => expect(m.confirm).toHaveBeenCalledWith({
    slug: 'agiang', session: PHIEN, building: 'k1', month: '2026-10-01', revision: 3, note: null,
  }));
  expect(m.success).toHaveBeenCalled();
});
