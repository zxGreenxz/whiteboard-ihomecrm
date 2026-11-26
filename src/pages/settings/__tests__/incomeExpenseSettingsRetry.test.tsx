// @vitest-environment jsdom
// Đợt 8 (luật 5): sửa / xoá loại thu chi, sửa / xoá / đặt mặc định mẫu in ghi lặp lại được. Sau một kết quả CHƯA RÕ (mất
// phản hồi) form và hộp xác nhận KHÔNG tự khoá: báo rõ, giữ nội dung đang nhập, bấm lại cho đúng một kết quả. Chạy với hook
// thật trên máy chủ giả. Đợt 9: đường TẠO mẫu in cũng không khoá (mã mẫu do trình duyệt sinh).
import { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, type FakeRecordServer } from '@/hooks/__tests__/fakeRecordServer';

type Row = Record<string, unknown>;
const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer, typesQuery: {} as Row, categoriesQuery: {} as Row, templatesQuery: {} as Row }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table), get rpc() { return io.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/ieTypesCache', () => ({ invalidateIeTypesCache: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/layout/MainLayout', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/hooks/useIncomeExpenseTypes', async original => ({ ...await original<typeof import('@/hooks/useIncomeExpenseTypes')>(), useIncomeExpenseTypes: () => io.typesQuery, useIncomeExpenseTypeCategories: () => io.categoriesQuery }));
vi.mock('@/hooks/useIncomeExpenseTemplates', async original => ({ ...await original<typeof import('@/hooks/useIncomeExpenseTemplates')>(), useIncomeExpenseTemplates: () => io.templatesQuery }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: () => false }));
vi.mock('@/hooks/useCanManageIeTypes', () => ({ useCanManageIeTypes: () => ({ canManage: true, isLoading: false }) }));
vi.mock('@/components/income-expense-types/CategoryCombobox', () => ({ default: (props: { value: string; onChange: (value: string) => void }) => <input aria-label="Nhóm" value={props.value} onChange={event => props.onChange(event.target.value)} /> }));
vi.mock('@/components/income-expense-types/IncomeExpenseTypeList', () => ({
  default: (props: { types: Row[]; onEdit?: (type: Row) => void; onDelete?: (id: string) => void }) => <div>{props.types.map(type => <span key={String(type.id)}>
    <button type="button" onClick={() => props.onEdit?.(type)}>Sửa {String(type.id)}</button>
    <button type="button" onClick={() => props.onDelete?.(String(type.id))}>Xoá {String(type.id)}</button>
  </span>)}</div>,
}));
vi.mock('@/components/income-expense-templates/IncomeExpenseTemplateList', () => ({
  default: (props: { templates: Row[]; onDelete: (id: string) => void; onToggleDefault: (id: string, isDefault: boolean, isIncome: boolean) => void; defaultPending?: boolean }) => <div>{props.templates.map(template => <span key={String(template.id)}>
    <button type="button" onClick={() => props.onDelete(String(template.id))}>Xoá {String(template.id)}</button>
    <button type="button" disabled={props.defaultPending} onClick={() => props.onToggleDefault(String(template.id), true, template.is_income_template === true)}>Mặc định {String(template.id)}</button>
  </span>)}</div>,
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

import EditIncomeExpenseTypeDialog from '@/components/income-expense-types/EditIncomeExpenseTypeDialog';
import IncomeExpenseTemplateForm from '@/components/income-expense-templates/IncomeExpenseTemplateForm';
import IncomeExpenseTypesPage from '../IncomeExpenseTypesPage';
import IncomeExpenseTemplatesPage from '../IncomeExpenseTemplatesPage';

const query = (data: unknown) => ({ data, status: 'success', fetchStatus: 'idle', isLoading: false, isError: false, error: null, refetch: vi.fn() });
const renderWithClient = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{ui}</QueryClientProvider>);
const rowOf = (table: string, id: string) => (io.server.rows[table] ?? []).find(row => row.id === id);
const button = (name: string, root: HTMLElement = document.body) => within(root).getByRole('button', { name }) as HTMLButtonElement;
const TYPE = { id: 't1', organization_id: 'org-a', user_id: 'actor', name: 'Điện', type: 'expense', category: 'Dịch vụ', description: null, is_default: false, is_restricted: false, hide_in_report: false };
const TEMPLATES = [
  { id: 'm1', user_id: 'actor', name: 'Mẫu thu A', description: null, template_file_url: null, is_income_template: true, is_default: true, deleted_at: null },
  { id: 'm2', user_id: 'actor', name: 'Mẫu thu B', description: null, template_file_url: null, is_income_template: true, is_default: false, deleted_at: null },
];

beforeEach(() => {
  io.server = fakeRecordServer();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  io.server.rows.income_expense_types = [{ ...TYPE }];
  io.server.rows.income_expense_items = [];
  io.server.rows.income_expense_templates = TEMPLATES.map(row => ({ ...row }));
  io.typesQuery = query([{ ...TYPE }]);
  io.categoriesQuery = query(['Dịch vụ']);
  io.templatesQuery = query(TEMPLATES.map(row => ({ ...row })));
});
afterEach(cleanup);

describe('hộp Sửa hạng mục thu chi', () => {
  const open = (onOpenChange = vi.fn(), onDeleted = vi.fn()) => {
    renderWithClient(<EditIncomeExpenseTypeDialog open onOpenChange={onOpenChange} onDeleted={onDeleted} type={{ ...TYPE } as never} />);
    return { onOpenChange, onDeleted };
  };

  it('lưu mất phản hồi: báo rõ, giữ tên đang sửa, nút Lưu không khoá; bấm lại lưu xong', async () => {
    const { onOpenChange } = open();
    io.server.failNext('income_expense_types', 'update', 'drop-after');
    fireEvent.change(screen.getByPlaceholderText('VD: Vệ sinh máy lạnh'), { target: { value: 'Điện tầng 1' } });
    fireEvent.click(button('Lưu'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Bấm lại'));
    expect((screen.getByPlaceholderText('VD: Vệ sinh máy lạnh') as HTMLInputElement).value).toBe('Điện tầng 1');
    expect(button('Lưu').disabled).toBe(false);
    fireEvent.click(button('Lưu'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(rowOf('income_expense_types', 't1')?.name).toBe('Điện tầng 1');
    expect(pendingKeys()).toEqual([]);
  });

  it('xoá mất phản hồi: hộp xác nhận báo rõ, nút Xoá không khoá; bấm lại báo đã xoá', async () => {
    const { onDeleted } = open();
    io.server.failNext('income_expense_types', 'delete', 'drop-after');
    fireEvent.click(button('Xoá'));
    const confirm = screen.getByRole('alertdialog');
    fireEvent.click(button('Xoá', confirm));
    await waitFor(() => expect(within(confirm).getByRole('alert').textContent).toContain('Bấm lại'));
    expect(button('Xoá', confirm).disabled).toBe(false);
    fireEvent.click(button('Xoá', confirm));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('t1'));
    expect(rowOf('income_expense_types', 't1')).toBeUndefined();
    expect(pendingKeys()).toEqual([]);
  });
});

describe('trang Loại thu chi', () => {
  it('sửa loại mất phản hồi: form không khoá, bấm lại lưu xong và đóng form', async () => {
    renderWithClient(<IncomeExpenseTypesPage />);
    fireEvent.click(button('Sửa t1'));
    const name = await screen.findByPlaceholderText('VD: Tiền thuê phòng') as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Điện'));
    io.server.failNext('income_expense_types', 'update', 'drop-after');
    fireEvent.change(name, { target: { value: 'Điện tầng 2' } });
    fireEvent.click(button('Lưu'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Bấm lại'));
    expect(button('Lưu').disabled).toBe(false);
    expect(name.disabled).toBe(false);
    fireEvent.click(button('Lưu'));
    await waitFor(() => expect(screen.queryByPlaceholderText('VD: Tiền thuê phòng')).toBeNull());
    expect(rowOf('income_expense_types', 't1')?.name).toBe('Điện tầng 2');
  });

  it('xoá loại không tới máy chủ: nút Xoá không khoá, bấm lại xoá được', async () => {
    renderWithClient(<IncomeExpenseTypesPage />);
    fireEvent.click(button('Xoá t1'));
    const confirm = await screen.findByRole('alertdialog');
    io.server.failNext('income_expense_types', 'delete', 'drop-before');
    fireEvent.click(button('Xoá', confirm));
    await waitFor(() => expect(within(confirm).getByRole('alert').textContent).toContain('Bấm lại'));
    expect(button('Xoá', confirm).disabled).toBe(false);
    fireEvent.click(button('Xoá', confirm));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(rowOf('income_expense_types', 't1')).toBeUndefined();
  });
});

describe('form mẫu in thu chi', () => {
  it('sửa mẫu mất phản hồi: form không khoá, bấm lại lưu xong', async () => {
    const onOpenChange = vi.fn();
    renderWithClient(<IncomeExpenseTemplateForm open onOpenChange={onOpenChange} template={{ ...TEMPLATES[1] } as never} />);
    const name = screen.getByPlaceholderText('VD: Mẫu biên lai thu tiền') as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Mẫu thu B'));
    io.server.failNext('income_expense_templates', 'update', 'drop-after');
    fireEvent.change(name, { target: { value: 'Mẫu thu C' } });
    fireEvent.click(button('Lưu'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Bấm lại'));
    expect(button('Lưu').disabled).toBe(false);
    fireEvent.click(button('Lưu'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(rowOf('income_expense_templates', 'm2')?.name).toBe('Mẫu thu C');
  });

  // Đợt 9 (luật 5): TẠO mẫu cũng không khoá — mã mẫu do trình duyệt sinh, bấm lại gửi đúng mã cũ. Trước đợt 9: «TẠO mẫu mất
  // phản hồi vẫn khoá như cũ».
  it('TẠO mẫu mất phản hồi (đọc lại cũng hỏng): form không khoá, không dấu; bấm lại ra đúng một mẫu', async () => {
    const close = vi.fn();
    renderWithClient(<IncomeExpenseTemplateForm open onOpenChange={close} template={null} />);
    io.server.failNext('income_expense_templates', 'insert', 'drop-after');
    io.server.failNext('income_expense_templates', 'read', 'drop-before');
    fireEvent.change(screen.getByPlaceholderText('VD: Mẫu biên lai thu tiền'), { target: { value: 'Mẫu mới' } });
    fireEvent.click(button('Lưu'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(button('Lưu').disabled).toBe(false);
    expect(pendingKeys()).toEqual([]);
    fireEvent.click(button('Lưu'));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect((io.server.rows.income_expense_templates ?? []).filter(row => row.name === 'Mẫu mới')).toHaveLength(1);
  });
});

describe('trang Mẫu in thu chi', () => {
  it('xoá mẫu mất phản hồi: nút Xoá không khoá, bấm lại báo đã xoá và đóng hộp', async () => {
    renderWithClient(<IncomeExpenseTemplatesPage />);
    fireEvent.click(button('Xoá m2'));
    const confirm = await screen.findByRole('alertdialog');
    io.server.failNext('income_expense_templates', 'update', 'drop-after');
    fireEvent.click(button('Xoá', confirm));
    await waitFor(() => expect(within(confirm).getByRole('alert').textContent).toContain('Bấm lại'));
    const deletedAt = rowOf('income_expense_templates', 'm2')?.deleted_at;
    expect(deletedAt).toEqual(expect.any(String));
    expect(button('Xoá', confirm).disabled).toBe(false);
    fireEvent.click(button('Xoá', confirm));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(rowOf('income_expense_templates', 'm2')?.deleted_at).toBe(deletedAt);
  });

  it('đặt mặc định mất phản hồi giữa chừng: nút chọn mặc định không khoá, bấm lại ra đúng một mẫu mặc định', async () => {
    renderWithClient(<IncomeExpenseTemplatesPage />);
    io.server.failNext('income_expense_templates', 'update', 'drop-after');
    fireEvent.click(button('Mặc định m2'));
    await waitFor(() => expect(rowOf('income_expense_templates', 'm1')?.is_default).toBe(false));
    await waitFor(() => expect(button('Mặc định m2').disabled).toBe(false));
    fireEvent.click(button('Mặc định m2'));
    await waitFor(() => expect(rowOf('income_expense_templates', 'm2')?.is_default).toBe(true));
    expect(io.server.rows.income_expense_templates.filter(row => row.is_default === true).map(row => row.id)).toEqual(['m2']);
    expect(pendingKeys()).toEqual([]);
  });
});
