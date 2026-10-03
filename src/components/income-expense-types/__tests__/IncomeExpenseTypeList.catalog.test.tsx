// @vitest-environment jsdom
// Trang Cài đặt › Loại thu chi theo danh mục chi chuẩn 03/10/2026: nhóm theo danh mục, mục
// lưu trữ gập trong "Đã lưu trữ" (kèm "→ gộp vào"), người thường chỉ xem.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import IncomeExpenseTypeList from '../IncomeExpenseTypeList';
import type { IncomeExpenseType } from '@/hooks/useIncomeExpenseTypes';

afterEach(cleanup);

const t = (id: string, name: string, extra: Partial<IncomeExpenseType> = {}) =>
  ({ id, name, type: 'expense', category: null, description: null, is_default: false, ...extra }) as IncomeExpenseType;
const TYPES = [
  t('nha', 'Tiền nhà', { category: 'Cố định hằng tháng', sort_order: 10 }),
  t('dl', 'Điện lạnh', { category: 'Sửa chữa – bảo trì', sort_order: 30 }),
  t('old', 'Sửa Máy Lạnh', { category: 'Sửa chữa – bảo trì', archived_at: '2026-10-03', merged_into_id: 'dl' }),
  t('thu', 'Tiền phòng', { type: 'income', category: 'Thu' }),
];

it('người thường: chỉ xem, có nhóm, mục lưu trữ gập riêng và ghi đích gộp', () => {
  render(<IncomeExpenseTypeList types={TYPES} isLoading={false} />);
  expect(screen.queryByRole('columnheader', { name: 'Thao tác' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Sửa / })).toBeNull();
  expect(screen.getByText('Chi · Cố định hằng tháng')).toBeTruthy();
  expect(screen.getByText('Chi · Sửa chữa – bảo trì')).toBeTruthy();
  expect(screen.getByText('Thu · Thu')).toBeTruthy();
  expect(screen.queryByText('Sửa Máy Lạnh')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Đã lưu trữ \(1\)/ }));
  expect(screen.getByText('Sửa Máy Lạnh')).toBeTruthy();
  expect(screen.getByText('→ gộp vào Điện lạnh')).toBeTruthy();
});

it('superadmin / chủ công ty: có nút sửa, xoá', () => {
  const onEdit = vi.fn();
  render(<IncomeExpenseTypeList types={TYPES} isLoading={false} onEdit={onEdit} onDelete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sửa Điện lạnh' }));
  expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'dl' }));
  expect(screen.getByRole('button', { name: 'Xoá Tiền nhà' })).toBeTruthy();
});
