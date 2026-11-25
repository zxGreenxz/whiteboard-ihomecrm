// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/MainLayout', () => ({ default: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock('@/hooks/use-mobile', () => ({ usePhoneViewport: () => false }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: () => true }));
vi.mock('@/components/sale-phong/ShareTokensTab', () => ({ default: () => <p>Nội dung link</p> }));
vi.mock('@/components/sale-phong/DisplaySettingsTab', () => ({ default: () => <p>Nội dung cài đặt</p> }));
vi.mock('@/components/sale-phong/PassListingsTab', () => ({ default: () => <p>Nội dung pass</p> }));
vi.mock('@/components/sale-phong/AnalyticsTab', () => ({ default: () => <p>Nội dung thống kê</p> }));
vi.mock('@/components/sale-phong/SaleRoomWorkspace', () => ({ default: () => <p>Nội dung cập nhật phòng</p> }));
vi.mock('@/components/sale-phong/SaleImagesTab', () => ({
  default: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) =>
    <button type="button" onClick={() => onDirtyChange?.(true)}>Sửa thông tin sale thử</button>,
}));
vi.mock('@/components/sale-phong/floor-editor/FloorPlanEditorTab', () => ({
  default: ({ onDirtyChange, onBusyChange }: { onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void }) => <div>
    <button type="button" onClick={() => onBusyChange?.(true)}>Đang lưu sơ đồ thử</button>
    <button type="button" onClick={() => onBusyChange?.(false)}>Lưu xong sơ đồ thử</button>
    <button type="button" onClick={() => onDirtyChange?.(true)}>Kéo phòng thử</button>
    <button type="button" onClick={() => onDirtyChange?.(false)}>Lưu sơ đồ thử</button>
  </div>,
}));

import SalePhongPage from '../SalePhongPage';

const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });

beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(false); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('đủ 7 tab, tab Cập nhật phòng luôn có và không còn dòng "chỉ có quyền xem" chết', () => {
  render(<SalePhongPage />);
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
    'Cập nhật phòng', 'Link chia sẻ', 'Cài đặt hiển thị', 'Thông tin sale', 'Khách nhờ sale', 'Sơ đồ tòa nhà', 'Thống kê',
  ]);
  expect(screen.getByText('Nội dung cập nhật phòng')).toBeTruthy();
  expect(screen.queryByText(/Bạn chỉ có quyền xem trang này/)).toBeNull();
});

it.each([
  ['Sơ đồ tòa nhà', 'Kéo phòng thử'],
  ['Thông tin sale', 'Sửa thông tin sale thử'],
])('tab %s còn thay đổi chưa lưu: đổi tab phải hỏi; huỷ thì ở lại, đồng ý thì chuyển', (tab, edit) => {
  render(<SalePhongPage />);
  openTab(tab);
  // Chưa sửa gì: đổi tab không hỏi.
  openTab('Thống kê');
  expect(window.confirm).not.toHaveBeenCalled();
  expect(screen.getByText('Nội dung thống kê')).toBeTruthy();
  openTab(tab);
  fireEvent.click(screen.getByRole('button', { name: edit }));
  openTab('Thống kê');
  expect(window.confirm).toHaveBeenCalledWith('Tab đang mở còn thay đổi chưa lưu. Bỏ các thay đổi này và chuyển tab?');
  expect(screen.getByRole('button', { name: edit })).toBeTruthy();
  expect(screen.queryByText('Nội dung thống kê')).toBeNull();
  vi.mocked(window.confirm).mockReturnValueOnce(true);
  openTab('Thống kê');
  expect(screen.getByText('Nội dung thống kê')).toBeTruthy();
  // Sang tab khác rồi đổi tiếp: bản cũ đã bỏ nên không hỏi lại.
  vi.mocked(window.confirm).mockClear();
  openTab('Link chia sẻ');
  expect(window.confirm).not.toHaveBeenCalled();
});

it('đã lưu xong sơ đồ thì đổi tab không hỏi', () => {
  render(<SalePhongPage />);
  openTab('Sơ đồ tòa nhà');
  fireEvent.click(screen.getByRole('button', { name: 'Kéo phòng thử' }));
  fireEvent.click(screen.getByRole('button', { name: 'Lưu sơ đồ thử' }));
  openTab('Cập nhật phòng');
  expect(window.confirm).not.toHaveBeenCalled();
  expect(screen.getByText('Nội dung cập nhật phòng')).toBeTruthy();
});

it('sơ đồ đang lưu thì khoá đổi tab (không mất câu báo xung đột/từ chối), lưu xong mở lại', () => {
  render(<SalePhongPage />);
  openTab('Sơ đồ tòa nhà');
  fireEvent.click(screen.getByRole('button', { name: 'Đang lưu sơ đồ thử' }));
  expect(screen.getByRole('tab', { name: 'Thống kê' })).toHaveProperty('disabled', true);
  openTab('Thống kê');
  expect(screen.queryByText('Nội dung thống kê')).toBeNull();
  expect(window.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Lưu xong sơ đồ thử' }));
  openTab('Thống kê');
  expect(screen.getByText('Nội dung thống kê')).toBeTruthy();
});
