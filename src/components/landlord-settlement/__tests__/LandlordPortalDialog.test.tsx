// @vitest-environment jsdom
// Hộp "Link tên miền cho chủ nhà": hai link cố định; tick toà rồi lưu (link mới phải có toà); thêm người xem (PIN tự
// chọn bị chặn khi sai dạng / dễ đoán trước khi gửi; PIN hiện đúng một lần); thu hồi phải bấm hai lần. Tên giả.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LandlordOperation } from '@/lib/landlordSettlement';

const m = vi.hoisted(() => ({ save: vi.fn(), add: vi.fn(), revoke: vi.fn(), data: null as unknown }));
vi.mock('@/hooks/useLandlordPortal', () => ({
  useLandlordPortals: () => ({ data: m.data, isLoading: false, isError: false, error: null }),
  useSaveLandlordPortal: () => ({ isPending: false, mutateAsync: m.save }),
  useAddLandlordPortalViewer: () => ({ isPending: false, mutateAsync: m.add }),
  useRevokeLandlordPortalViewer: () => ({ isPending: false, mutateAsync: m.revoke }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { LandlordPortalDialog } from '../LandlordPortalDialog';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const op = (n: number, ten: string): LandlordOperation => ({
  building_id: id(n), building_name: ten, landlord_name: 'Chủ A', is_active: true,
} as unknown as LandlordOperation);
const OPS = [op(1, 'Toà A'), op(2, 'Toà B'), op(3, 'Toà C')];
const nguoi = (n: number, label: string, revoked: string | null = null) =>
  ({ id: id(100 + n), label, created_at: '2026-10-24T00:00:00Z', last_login_at: null, revoked_at: revoked });

const ve = () => render(<LandlordPortalDialog open onOpenChange={vi.fn()} operations={OPS} />);
const the = (slug: string) => within(screen.getByTestId(`portal-${slug}`));

beforeEach(() => {
  m.data = { portals: [{ slug: 'agiang', building_ids: [id(1)], updated_at: 'x', viewers: [nguoi(1, 'Người xem A'), nguoi(2, 'Cũ', '2026-10-20T00:00:00Z')] }] };
  m.save.mockResolvedValue({ slug: 'agiang', building_ids: [id(1), id(2)] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('hai link cố định; gộp thêm toà rồi lưu; link chưa có thì phải chọn toà mới tạo được', async () => {
  ve();
  expect(screen.getByText('cgiang.chillhome.io.vn')).toBeTruthy();
  expect(screen.getByText('agiang.chillhome.io.vn')).toBeTruthy();
  const a = the('agiang');
  expect(a.queryByRole('button', { name: 'Lưu toà của link' })).toBeNull();
  fireEvent.click(a.getByRole('checkbox', { name: 'Toà B trong agiang.chillhome.io.vn' }));
  fireEvent.click(a.getByRole('button', { name: 'Lưu toà của link' }));
  await waitFor(() => expect(m.save).toHaveBeenCalledWith({ slug: 'agiang', buildingIds: [id(1), id(2)] }));
  const c = the('cgiang');
  const tao = c.getByRole('button', { name: 'Tạo link với các toà đã chọn' }) as HTMLButtonElement;
  expect(tao.disabled).toBe(true);
  fireEvent.click(c.getByRole('checkbox', { name: 'Toà C trong cgiang.chillhome.io.vn' }));
  expect(tao.disabled).toBe(false);
});

it('người xem: PIN sai dạng / dễ đoán chặn trước khi gửi; để trống ⇒ server tạo, PIN hiện một lần', async () => {
  m.add.mockResolvedValue({ id: id(103), label: 'Người xem B', pin: '730518' });
  ve();
  const a = the('agiang');
  expect(a.getAllByTestId('portal-viewer-row').map((r) => r.textContent)).toEqual([
    expect.stringContaining('Người xem A'), expect.stringContaining('Cũ'),
  ]);
  fireEvent.change(a.getByLabelText('Tên người xem'), { target: { value: 'Người xem B' } });
  fireEvent.change(a.getByLabelText('PIN 6 số (để trống: tự tạo)'), { target: { value: '123456' } });
  fireEvent.click(a.getByRole('button', { name: /Thêm/ }));
  expect(a.getByRole('alert').textContent).toMatch(/quá dễ đoán/);
  fireEvent.change(a.getByLabelText('PIN 6 số (để trống: tự tạo)'), { target: { value: '123' } });
  fireEvent.click(a.getByRole('button', { name: /Thêm/ }));
  expect(a.getByRole('alert').textContent).toMatch(/đúng 6 chữ số/);
  expect(m.add).not.toHaveBeenCalled();
  fireEvent.change(a.getByLabelText('PIN 6 số (để trống: tự tạo)'), { target: { value: '' } });
  fireEvent.click(a.getByRole('button', { name: /Thêm/ }));
  await waitFor(() => expect(m.add).toHaveBeenCalledWith({ slug: 'agiang', label: 'Người xem B', pin: null }));
  expect(a.getByTestId('portal-new-pin').textContent).toMatch(/Người xem B.*730518/);
});

it('thu hồi phải bấm hai lần; người đã thu hồi không có nút', async () => {
  m.revoke.mockResolvedValue({ status: 'REVOKED' });
  ve();
  const a = the('agiang');
  expect(a.getAllByRole('button', { name: /Thu hồi/ })).toHaveLength(1);
  fireEvent.click(a.getByRole('button', { name: 'Thu hồi' }));
  expect(m.revoke).not.toHaveBeenCalled();
  fireEvent.click(a.getByRole('button', { name: 'Bấm lần nữa để thu hồi' }));
  await waitFor(() => expect(m.revoke).toHaveBeenCalledWith({ viewerId: id(101) }));
});
