// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CategoryShareBlock } from '../IncomeBreakdown';

afterEach(cleanup);

// Số liệu giả, tròn — không phải dữ liệu thật.
const cats = [
  { name: 'Tiền nhà', amount: 27_000_000 },
  { name: 'Đóng tiền điện', amount: 7_000_000 },
  { name: 'Hoa hồng môi giới', amount: 3_000_000 },
];

describe('CategoryShareBlock', () => {
  it('nơi dùng không bật ô tích (Quyết toán vận hành) ⇒ không có ô tích, bố cục dòng như cũ', () => {
    const { container } = render(
      <CategoryShareBlock cats={cats} total={37_000_000} kind="EXPENSE" open onToggle={() => {}} testId="cats" />,
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(3);
    for (const li of items) expect(li.className).toContain('grid-cols-[10px_minmax(0,1fr)_auto_44px]');
    // thanh tỷ trọng không bị làm mờ
    expect(container.querySelector('.opacity-30')).toBeNull();
  });

  it('bật ô tích ⇒ mỗi hạng mục một ô; bấm ô hoặc bấm chữ đều báo đúng tên', () => {
    const onToggleSelect = vi.fn();
    render(
      <CategoryShareBlock cats={cats} total={37_000_000} kind="EXPENSE" open onToggle={() => {}} testId="cats"
        selected={new Set<string>()} onToggleSelect={onToggleSelect} />,
    );
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    fireEvent.click(screen.getByRole('checkbox', { name: /Tiền nhà/ }));
    expect(onToggleSelect).toHaveBeenLastCalledWith('Tiền nhà');
    fireEvent.click(screen.getByText('Hoa hồng môi giới'));
    expect(onToggleSelect).toHaveBeenLastCalledWith('Hoa hồng môi giới');
  });

  it('đã tích ⇒ ô được tích, các đoạn thanh của mục khác mờ đi', () => {
    const { container } = render(
      <CategoryShareBlock cats={cats} total={37_000_000} kind="INCOME" open onToggle={() => {}} testId="cats"
        selected={new Set(['Đóng tiền điện'])} onToggleSelect={() => {}} />,
    );
    expect(screen.getByRole('checkbox', { name: /Đóng tiền điện/ }).getAttribute('data-state')).toBe('checked');
    expect(screen.getByRole('checkbox', { name: /Tiền nhà/ }).getAttribute('data-state')).toBe('unchecked');
    expect(container.querySelectorAll('.opacity-30')).toHaveLength(2);
  });

  it('khối thu gọn ⇒ chưa hiện ô tích (chỉ thanh tỷ trọng)', () => {
    render(
      <CategoryShareBlock cats={cats} total={37_000_000} kind="EXPENSE" open={false} onToggle={() => {}}
        selected={new Set<string>()} onToggleSelect={() => {}} />,
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});
