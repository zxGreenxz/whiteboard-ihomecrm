// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Package } from 'lucide-react';
vi.mock('@/components/layout/MainLayout', () => ({ default: ({children}: {children: React.ReactNode}) => <>{children}</> }));
import CategoryCrudPage from './CategoryCrudPage';
import { FLOOR_ERROR_RULES } from '@/lib/categoryFeedback';
afterEach(cleanup);
function page(onCreate: () => Promise<unknown>) {
  return render(<MemoryRouter><CategoryCrudPage title="Kho" subtitle="Kho" icon={Package} data={[]} isLoading={false} columns={[]} fields={[{key:'name',label:'Tên kho',required:true}]} getId={() => ''} onCreate={onCreate} onUpdate={async () => {}} onDelete={async () => {}} /></MemoryRouter>);
}
it('keeps draft and dialog until save actually succeeds', async () => {
  let reject!: (reason: unknown) => void;
  const save = vi.fn(() => new Promise((_resolve, no) => { reject = no; }));
  page(save);
  fireEvent.click(screen.getByRole('button', {name:/Thêm mới/}));
  fireEvent.change(screen.getByLabelText(/Tên kho/), {target:{value:'Kho mới'}});
  fireEvent.click(screen.getAllByRole('button',{name:'Thêm mới'}).at(-1)!);
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(screen.getByRole('dialog')).toBeTruthy();
  reject(new Error('database technical failure'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Chưa'));
  expect((screen.getByLabelText(/Tên kho/) as HTMLInputElement).value).toBe('Kho mới');
});
it('marks and focuses a missing required field before calling create', async () => {
  const save = vi.fn(async () => {});
  page(save);
  fireEvent.click(screen.getByRole('button', {name:/Thêm mới/}));
  fireEvent.click(screen.getAllByRole('button',{name:'Thêm mới'}).at(-1)!);
  await waitFor(() => expect(screen.getByLabelText(/Tên kho/).getAttribute('aria-invalid')).toBe('true'));
  expect(document.activeElement).toBe(screen.getByLabelText(/Tên kho/));
  expect(save).not.toHaveBeenCalled();
});
it('marks the exact server-verified duplicate floor field and preserves the draft', async () => {
  render(<MemoryRouter><CategoryCrudPage title="Tầng" subtitle="Tầng" icon={Package} data={[]} isLoading={false} columns={[]} fields={[{key:'floor_number',label:'Số tầng',type:'number',required:true}]} getId={() => ''} errorRules={FLOOR_ERROR_RULES} onCreate={async () => {throw {code:'23505', message:'duplicate key value violates unique constraint "floors_unique_building_floor"'};}} onUpdate={async () => {}} onDelete={async () => {}} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button',{name:'Thêm mới'}));
  fireEvent.change(screen.getByLabelText(/Số tầng/),{target:{value:'2'}});
  fireEvent.click(screen.getAllByRole('button',{name:'Thêm mới'}).at(-1)!);
  await waitFor(() => expect(screen.getByLabelText(/Số tầng/).getAttribute('aria-invalid')).toBe('true'));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Số tầng/)));
  expect((screen.getByLabelText(/Số tầng/) as HTMLInputElement).value).toBe('2');
  expect(screen.getByText('Số tầng này đã có trong tòa. Nhập số tầng khác.')).toBeTruthy();
});
