// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createTask } from '@/lib/personal-tasks/model';
import { TaskRow } from './TaskRow';
afterEach(cleanup);
it('nút xong/hẹn hoạt động và nội dung HTML luôn là văn bản', () => {
  const onDone = vi.fn(); const onDue = vi.fn();
  render(<TaskRow task={createTask('a', '<img src=x onerror=alert(1)>')} area="todo" now={new Date()} busy={false} onDone={onDone} onDue={onDue} onUndo={vi.fn()} />);
  expect(screen.queryByRole('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Đánh dấu xong' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hẹn giờ' }));
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(onDue).toHaveBeenCalledTimes(1);
});
