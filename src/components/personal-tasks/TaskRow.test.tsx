// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createTask } from '@/lib/personal-tasks/model';
import { TaskRow } from './TaskRow';
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('nút xong/hẹn hoạt động và nội dung HTML luôn là văn bản', () => {
  const onDone = vi.fn(); const onDue = vi.fn();
  render(<TaskRow task={createTask('a', '<img src=x onerror=alert(1)>')} area="todo" now={new Date()} busy={false} onDone={onDone} onDue={onDue} onUndo={vi.fn()} onDelete={vi.fn()} />);
  expect(screen.queryByRole('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Đánh dấu xong' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hẹn giờ' }));
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(onDue).toHaveBeenCalledTimes(1);
});

function pointer(element: HTMLElement, type: string, x = 100, y = 100) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0, clientX: x, clientY: y });
  fireEvent(element, event);
}
it('giữ 600ms chỉ yêu cầu xác nhận xóa, thả tay không hoàn thành', () => {
  vi.useFakeTimers();
  const onDelete = vi.fn(); const onDone = vi.fn();
  const view = render(<TaskRow task={createTask('a', 'Giữ để xóa')} area="todo" now={new Date()} busy={false} onDone={onDone} onDue={vi.fn()} onUndo={vi.fn()} onDelete={onDelete} />);
  const row = view.container.querySelector<HTMLElement>('.ptask-row-face')!;
  pointer(row, 'pointerdown');
  act(() => { vi.advanceTimersByTime(599); });
  expect(onDelete).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); });
  expect(onDelete).toHaveBeenCalledTimes(1);
  pointer(row, 'pointerup');
  expect(onDone).not.toHaveBeenCalled();
});
it.each(['move', 'cancel', 'release', 'unmount'])('hủy giữ khi %s, không mở xác nhận ngoài ý muốn', reason => {
  vi.useFakeTimers();
  const onDelete = vi.fn();
  const view = render(<TaskRow task={createTask('a', 'Cuộn')} area="todo" now={new Date()} busy={false} onDone={vi.fn()} onDue={vi.fn()} onUndo={vi.fn()} onDelete={onDelete} />);
  const row = view.container.querySelector<HTMLElement>('.ptask-row-face')!;
  pointer(row, 'pointerdown');
  if (reason === 'move') pointer(row, 'pointermove', 100, 125);
  if (reason === 'cancel') pointer(row, 'pointercancel');
  if (reason === 'release') pointer(row, 'pointerup');
  if (reason === 'unmount') view.unmount();
  act(() => { vi.advanceTimersByTime(700); });
  expect(onDelete).not.toHaveBeenCalled();
});
