// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePersonalTasks } from '../usePersonalTasks';
import { createTask } from '@/lib/personal-tasks/model';
import { serializeTasks, storageKey } from '@/lib/personal-tasks/storage';
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
afterEach(() => { cleanup(); localStorage.clear(); });
function Board({ userId }: { userId: string }) {
  const { tasks, loading } = usePersonalTasks(userId);
  return <div>{loading ? 'loading' : tasks.map(task => task.text).join(',')}</div>;
}
it('đổi tài khoản bỏ ngay state cũ, kho của mỗi người vẫn còn', async () => {
  localStorage.setItem(storageKey('a'), serializeTasks([createTask('a', 'Việc A')]));
  localStorage.setItem(storageKey('b'), serializeTasks([createTask('b', 'Việc B')]));
  const view = render(<Board key="a" userId="a" />);
  await screen.findByText('Việc A');
  view.rerender(<Board key="b" userId="b" />);
  expect(screen.queryByText('Việc A')).toBeNull();
  await screen.findByText('Việc B');
  view.rerender(<Board key="a" userId="a" />);
  await screen.findByText('Việc A');
});
it('nhận thay đổi từ tab khác của cùng tài khoản', async () => {
  render(<Board userId="a" />);
  act(() => {
    localStorage.setItem(storageKey('a'), serializeTasks([createTask('a', 'Việc từ tab khác')]));
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('a') }));
  });
  await waitFor(() => expect(screen.queryByText('Việc từ tab khác')).not.toBeNull());
});
