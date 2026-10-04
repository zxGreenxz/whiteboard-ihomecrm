// @vitest-environment jsdom
// Danh mục chi chuẩn 03/10/2026: ô chọn hạng mục chỉ hiện mục chọn được, gom theo nhóm,
// tìm cả theo cụm từ; nút thêm/sửa chỉ cho superadmin / chủ công ty.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  types: [] as Array<Record<string, unknown>>,
  canManage: false,
  canRestricted: false,
}));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({ useIncomeExpenseTypes: () => ({ data: h.types, isLoading: false }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: () => h.canRestricted }));
vi.mock('@/hooks/useCanManageIeTypes', () => ({ useCanManageIeTypes: () => ({ canManage: h.canManage, isLoading: false }) }));
vi.mock('@/components/income-expense-types/IncomeExpenseTypeForm', () => ({ default: () => <div>form tạo hạng mục</div> }));
vi.mock('@/components/income-expense-types/EditIncomeExpenseTypeDialog', () => ({ default: () => null }));
import IncomeExpenseItemSelector from '../IncomeExpenseItemSelector';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
afterEach(() => { cleanup(); h.canManage = false; h.canRestricted = false; });

const t = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, type: 'expense', category: null, ...extra });
const CATALOG = [
  t('rac', 'Tiền rác', { category: 'Cố định hằng tháng', sort_order: 20 }),
  t('nha', 'Tiền nhà', { category: 'Cố định hằng tháng', sort_order: 10 }),
  t('dl', 'Điện lạnh', { category: 'Sửa chữa – bảo trì', sort_order: 30, keywords: ['bơm gas'] }),
  t('old', 'Sửa Máy Lạnh', { category: 'Sửa chữa – bảo trì', archived_at: '2026-10-03', merged_into_id: 'dl' }),
  t('hh', 'Hoa hồng môi giới', { category: 'HOA HỒNG', system_only: true }),
  t('vs', 'vệ sinh máy lạnh', { category: 'Sửa chữa – bảo trì', manual_hidden: true }),
  t('hc', 'Chi hạn chế', { is_restricted: true }),
];

const renderSelector = (selectedTypeIds: string[] = []) =>
  render(<IncomeExpenseItemSelector open onOpenChange={vi.fn()} voucherType="EXPENSE" onSelect={vi.fn()} selectedTypeIds={selectedTypeIds} />);

it('chỉ hiện mục chọn được, gom nhóm theo thứ tự danh mục; người thường không thấy nút thêm/sửa', () => {
  h.types = CATALOG;
  renderSelector();
  const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
  expect(groups).toEqual(['Cố định hằng tháng', 'Sửa chữa – bảo trì']);
  const names = screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent);
  expect(names).toEqual(['Tiền nhà', 'Tiền rác', 'Điện lạnh']);
  expect(screen.queryByText('Sửa Máy Lạnh')).toBeNull();
  expect(screen.queryByText('Hoa hồng môi giới')).toBeNull();
  expect(screen.queryByText('vệ sinh máy lạnh')).toBeNull();
  expect(screen.queryByText('Chi hạn chế')).toBeNull();
  expect(screen.queryByRole('button', { name: /Thêm loại chi mới/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Sửa hạng mục/ })).toBeNull();
  expect(screen.getByText('Cần hạng mục mới? Báo chủ công ty thêm.')).toBeTruthy();
});

it('phiếu cũ đang gắn mục đã lưu trữ vẫn thấy và vẫn được chọn', () => {
  h.types = CATALOG;
  renderSelector(['old']);
  expect(screen.getByText('Sửa Máy Lạnh')).toBeTruthy();
  expect(screen.getByText('Đã lưu trữ — chỉ giữ cho phiếu cũ')).toBeTruthy();
});

it('tìm theo cụm từ hay nói, bỏ nhóm khi đang tìm', () => {
  h.types = CATALOG;
  renderSelector();
  fireEvent.change(screen.getByLabelText('Tìm hạng mục'), { target: { value: 'bom gas' } });
  expect(screen.queryAllByRole('group')).toHaveLength(0);
  expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual(['Điện lạnh']);
});

it('superadmin / chủ công ty thấy nút thêm, sửa và mục hạn chế khi có quyền', () => {
  h.types = CATALOG;
  h.canManage = true;
  h.canRestricted = true;
  renderSelector();
  expect(screen.getByRole('button', { name: /Thêm loại chi mới/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sửa hạng mục Điện lạnh' })).toBeTruthy();
  expect(screen.getByText('Chi hạn chế')).toBeTruthy();
  expect(screen.queryByText('Cần hạng mục mới? Báo chủ công ty thêm.')).toBeNull();
});
