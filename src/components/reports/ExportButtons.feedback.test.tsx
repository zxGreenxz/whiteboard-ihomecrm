// @vitest-environment jsdom
import type { PropsWithChildren, ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), write: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error, info: vi.fn() } }));
vi.mock('xlsx', () => ({ utils: { json_to_sheet: () => ({}), book_new: () => ({}), book_append_sheet: vi.fn() }, writeFile: mocks.write }));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({children}: PropsWithChildren) => children, DropdownMenuContent: ({children}: PropsWithChildren) => children,
  DropdownMenuTrigger: ({children}: PropsWithChildren) => children, DropdownMenuLabel: ({children}: PropsWithChildren) => children,
  DropdownMenuSeparator: () => null, DropdownMenuItem: ({children,...props}: ComponentProps<'button'>) => <button {...props}>{children}</button>,
}));
import { ExportButtons } from './ExportButtons';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('never announces success after the spreadsheet writer failed', async () => {
  mocks.write.mockImplementation(() => { throw new Error('write failure'); });
  render(<ExportButtons data={[{ Phòng: '101' }]} filename="phong-trong" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excel (.xlsx)' }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalled());
  expect(mocks.success).not.toHaveBeenCalled();
});
it('reports prepared filename and rows without claiming a file was saved on the device', async () => {
  mocks.write.mockImplementation(() => undefined);
  render(<ExportButtons data={[{ Phòng: '101' }]} filename="phong-trong" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excel (.xlsx)' }));
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith(expect.stringContaining('phong-trong.xlsx, gồm 1 dòng')));
});
