// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InlineSkeleton, LOADING_SLOW_AFTER_MS, LoadingState, RefreshBar } from '../LoadingState';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

// Chủ chốt 02/10/2026: không hiện chữ "Đang tải…" trên màn hình; chữ chỉ còn cho
// trình đọc màn hình, phần nhìn thấy là khối xám (hiện sau 0,3 s bằng lớp ld-appear).
it('block loading keeps the label for screen readers only and draws a delayed skeleton', () => {
  const { container } = render(<LoadingState label="danh sách khách hàng" variant="list" />);
  const status = screen.getByRole('status');
  expect(status.textContent).toContain('Đang tải danh sách khách hàng…');
  expect(status.querySelector('.sr-only')?.textContent).toBe('Đang tải danh sách khách hàng…');
  const visible = container.querySelector('.ld-appear');
  expect(visible?.getAttribute('aria-hidden')).toBe('true');
  expect(visible?.textContent).toBe('');
});

it('says the network is slow only after 8 seconds, with a retry that calls back', () => {
  const retry = vi.fn();
  render(<LoadingState label="phiếu" onRetry={retry} />);
  act(() => { vi.advanceTimersByTime(LOADING_SLOW_AFTER_MS - 1); });
  expect(screen.queryByText('Mạng đang chậm, vẫn đang tải.')).toBeNull();
  act(() => { vi.advanceTimersByTime(1); });
  expect(screen.getByText('Mạng đang chậm, vẫn đang tải.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  expect(retry).toHaveBeenCalledOnce();
});

it('status-only and inline variants never show the slow notice', () => {
  render(<><LoadingState label="nhật ký phiếu" variant="none" /><LoadingState label="lịch sử sửa phiếu" variant="inline" /></>);
  act(() => { vi.advanceTimersByTime(LOADING_SLOW_AFTER_MS * 2); });
  expect(screen.queryByText('Mạng đang chậm, vẫn đang tải.')).toBeNull();
  const statuses = screen.getAllByRole('status').map((el) => el.textContent);
  expect(statuses).toEqual(['Đang tải nhật ký phiếu…', 'Đang tải lịch sử sửa phiếu…']);
});

it('inline skeleton sits inside the cell as a hidden-text status', () => {
  render(<InlineSkeleton label="thông tin hợp đồng" width="14rem" />);
  const status = screen.getByRole('status');
  expect(status.tagName).toBe('SPAN');
  expect(status.textContent).toBe('Đang tải thông tin hợp đồng…');
});

it('refresh bar renders only while active and has no visible text', () => {
  const { rerender, container } = render(<RefreshBar active label="Đang cập nhật phiếu" />);
  expect(screen.getByRole('status').textContent).toBe('Đang cập nhật phiếu');
  expect(container.querySelector('.ld-bar')).not.toBeNull();
  rerender(<RefreshBar active={false} label="Đang cập nhật phiếu" />);
  expect(screen.queryByRole('status')).toBeNull();
});
