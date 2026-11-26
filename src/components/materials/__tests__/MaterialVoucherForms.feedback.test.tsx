// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ createPurchase: vi.fn(), updatePurchase: vi.fn(), createAdjustment: vi.fn(), setStock: vi.fn(), createUsage: vi.fn(), upsertUsage: vi.fn() }));
vi.mock('@/hooks/useMaterialPurchases', () => ({ useCreateMaterialPurchase: () => ({ mutateAsync: state.createPurchase, isPending: false }), useUpdateMaterialPurchase: () => ({ mutateAsync: state.updatePurchase, isPending: false }) }));
vi.mock('@/hooks/useMaterialAdjustments', () => ({ useCreateMaterialAdjustment: () => ({ mutateAsync: state.createAdjustment, isPending: false }), useSetMaterialStock: () => ({ mutateAsync: state.setStock, isPending: false }) }));
vi.mock('@/hooks/useMaterials', () => ({ useMaterials: () => ({ data: [{ id: 'm-1', name: 'Ống', on_hand: 1 }, { id: 'm-2', name: 'Đinh', on_hand: 2 }], isPending: false, isError: false, refetch: vi.fn() }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [], isPending: false, isError: false, refetch: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('@/components/materials/MaterialPicker', () => ({ MaterialPicker: ({ value, onChange }: { value: string | null; onChange: (id: string) => void }) => <select aria-label="Vật tư" value={value ?? ''} onChange={e => onChange(e.target.value)}><option value=""/><option value="m-1">Ống</option><option value="m-2">Đinh</option></select> }));
vi.mock('@/hooks/useMaterialUsages', () => ({ useCreateMaterialUsage: () => ({ mutateAsync: state.createUsage, isPending: false }), useUpsertJobMaterialUsage: () => ({ mutateAsync: state.upsertUsage, isPending: false }), useMaterialUsageByJob: () => ({ data: null, isPending: false, isError: false, refetch: vi.fn() }) }));
import { FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import MaterialUsageFormDialog from '../MaterialUsageFormDialog';
import MaterialUsageSection from '../MaterialUsageSection';
import MaterialPurchaseFormDialog from '../MaterialPurchaseFormDialog';
import MaterialAdjustmentFormDialog from '../MaterialAdjustmentFormDialog';
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a'); });

it('phiếu nhập partial giữ dòng và ID sau đóng/mở, không gửi lại', async () => {
  state.createPurchase.mockRejectedValue(new FinancialWorkflowError('Phiếu đã tạo một phần.', 'partial', [{ id: 'purchase-1', label: 'Phiếu nhập' }]));
  const onOpenChange = vi.fn();
  const view = render(<MaterialPurchaseFormDialog open onOpenChange={onOpenChange} editing={null}/>);
  fireEvent.change(screen.getByLabelText('Vật tư'), { target: { value: 'm-1' } });
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu nhập' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('purchase-1'));
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getAllByRole('spinbutton')[0].getAttribute('value')).toBe('3');
  view.rerender(<MaterialPurchaseFormDialog open={false} onOpenChange={onOpenChange} editing={null}/>);
  view.rerender(<MaterialPurchaseFormDialog open onOpenChange={onOpenChange} editing={null}/>);
  expect(screen.getAllByRole('spinbutton')[0].getAttribute('value')).toBe('3');
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu nhập' }));
  expect(state.createPurchase).toHaveBeenCalledTimes(1);
});

it('phiếu nhập giữ dòng nhập dở để sửa và không gửi thiếu dòng', async () => {
  render(<MaterialPurchaseFormDialog open onOpenChange={vi.fn()} editing={null}/>);
  fireEvent.change(screen.getByLabelText('Vật tư'), { target: { value: 'm-1' } });
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Thêm dòng' }));
  fireEvent.change(screen.getAllByRole('spinbutton')[2], { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu nhập' }));
  expect(state.createPurchase).not.toHaveBeenCalled();
  expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
});

it('SET nhiều dòng giữ ID dòng đã lưu khi dòng sau lỗi, khóa lập lại toàn bộ', async () => {
  state.setStock.mockResolvedValueOnce({ id: 'adjustment-1' }).mockRejectedValueOnce({ code: '42501', message: 'raw SQL' });
  render(<MaterialAdjustmentFormDialog open onOpenChange={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('Vật tư'), { target: { value: 'm-1' } });
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Thêm dòng' }));
  fireEvent.change(screen.getAllByLabelText('Vật tư')[1], { target: { value: 'm-2' } });
  fireEvent.change(screen.getAllByRole('spinbutton')[1], { target: { value: '4' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu kiểm kê' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('adjustment-1'));
  expect(screen.getByRole('alert').textContent).not.toContain('raw SQL');
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu kiểm kê' }));
  expect(state.setStock).toHaveBeenCalledTimes(2);
});


it('phiếu xuất partial giữ bản nháp và ID sau đóng/mở, khóa tạo lại', async () => {
  state.createUsage.mockRejectedValue(new FinancialWorkflowError('Phiếu xuất mới lưu một phần.', 'partial', [{ id: 'usage-1', label: 'Phiếu xuất' }]));
  const onOpenChange = vi.fn();
  const view = render(<MaterialUsageFormDialog open onOpenChange={onOpenChange}/>);
  fireEvent.change(screen.getByLabelText('Vật tư'), { target: { value: 'm-1' } });
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu xuất' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('usage-1'));
  expect(onOpenChange).not.toHaveBeenCalled();
  view.rerender(<MaterialUsageFormDialog open={false} onOpenChange={onOpenChange}/>);
  view.rerender(<MaterialUsageFormDialog open onOpenChange={onOpenChange}/>);
  expect(screen.getByRole('spinbutton').getAttribute('value')).toBe('3');
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu xuất' }));
  expect(state.createUsage).toHaveBeenCalledTimes(1);
});

// Đợt 8 (luật 5): lưu vật tư công việc ghi lặp lại được (xoá rồi chèn lại toàn bộ dòng) nên kết quả chưa rõ không khoá
// form: giữ dòng đang nhập, báo rõ, bấm lại gửi lại đúng bộ dòng đó. (Trước đợt 8 test này chốt «khóa lưu lại toàn bộ».)
it('vật tư công việc chưa rõ kết quả: báo rõ, giữ dòng, KHÔNG khoá; bấm lại gửi lại đúng bộ dòng', async () => {
  state.upsertUsage.mockReset().mockRejectedValueOnce(new RepeatableWriteUnknownError('lưu vật tư công việc')).mockResolvedValueOnce('usage-1');
  render(<MaterialUsageSection jobId="job-1"/>);
  fireEvent.change(screen.getByLabelText('Vật tư'), { target: { value: 'm-1' } });
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu vật tư' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Bấm lại'));
  expect(screen.getByRole('spinbutton').getAttribute('value')).toBe('3');
  expect((screen.getByRole('spinbutton') as HTMLInputElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: 'Lưu vật tư' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Lưu vật tư' }));
  await waitFor(() => expect(state.upsertUsage).toHaveBeenCalledTimes(2));
  expect(state.upsertUsage.mock.calls[1][0]).toEqual(state.upsertUsage.mock.calls[0][0]);
  expect(state.upsertUsage.mock.calls[1][0]).toMatchObject({ job_id: 'job-1', items: [{ material_id: 'm-1', quantity: 3 }] });
});

const purchaseOf = (id: string, quantity: number) => ({ id, code: `MP-${id}`, purchase_date: '2026-09-01', supplier_id: null, notes: null, total: 0, items: [{ id: `${id}-line`, purchase_id: id, material_id: 'm-1', quantity, unit_price: 100, line_total: quantity * 100 }] }) as unknown as Parameters<typeof MaterialPurchaseFormDialog>[0]['editing'];

it('sửa phiếu nhập chưa rõ kết quả: không khoá, đóng/mở lại đúng phiếu giữ bản nháp, bấm lại gửi lại', async () => {
  state.updatePurchase.mockReset().mockRejectedValueOnce(new RepeatableWriteUnknownError('cập nhật phiếu nhập')).mockResolvedValueOnce(undefined);
  const onOpenChange = vi.fn();
  const editing = purchaseOf('p-1', 5);
  const view = render(<MaterialPurchaseFormDialog open onOpenChange={onOpenChange} editing={editing}/>);
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Bấm lại'));
  expect(onOpenChange).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Cập nhật' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole('button', { name: 'Huỷ' })).toBeTruthy();
  view.rerender(<MaterialPurchaseFormDialog open={false} onOpenChange={onOpenChange} editing={editing}/>);
  view.rerender(<MaterialPurchaseFormDialog open onOpenChange={onOpenChange} editing={purchaseOf('p-1', 0)}/>);
  expect(screen.getAllByRole('spinbutton')[0].getAttribute('value')).toBe('7');
  fireEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
  await waitFor(() => expect(state.updatePurchase).toHaveBeenCalledTimes(2));
  expect(state.updatePurchase.mock.calls[1][0]).toEqual(state.updatePurchase.mock.calls[0][0]);
  expect(state.updatePurchase.mock.calls[1][0]).toMatchObject({ id: 'p-1', input: { items: [{ material_id: 'm-1', quantity: 7, unit_price: 100 }] } });
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

it('sửa phiếu nhập lỗi rồi mở PHIẾU KHÁC: không mang bản nháp và lời báo của phiếu trước sang', async () => {
  state.updatePurchase.mockReset().mockRejectedValueOnce(new RepeatableWriteUnknownError('cập nhật phiếu nhập')).mockResolvedValueOnce(undefined);
  const onOpenChange = vi.fn();
  const view = render(<MaterialPurchaseFormDialog open onOpenChange={onOpenChange} editing={purchaseOf('p-1', 5)}/>);
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  view.rerender(<MaterialPurchaseFormDialog open={false} onOpenChange={onOpenChange} editing={purchaseOf('p-1', 5)}/>);
  view.rerender(<MaterialPurchaseFormDialog open onOpenChange={onOpenChange} editing={purchaseOf('p-2', 9)}/>);
  await waitFor(() => expect(screen.getAllByRole('spinbutton')[0].getAttribute('value')).toBe('9'));
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
  await waitFor(() => expect(state.updatePurchase).toHaveBeenCalledTimes(2));
  expect(state.updatePurchase.mock.calls[1][0]).toMatchObject({ id: 'p-2', input: { items: [{ quantity: 9 }] } });
});
