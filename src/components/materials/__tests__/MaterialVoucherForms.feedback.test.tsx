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
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
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

it('vật tư công việc partial hiện ID và giữ dòng, khóa lưu lại toàn bộ', async () => {
  state.upsertUsage.mockRejectedValue(new FinancialWorkflowError('Phiếu vật tư mới lưu một phần.', 'partial', [{ id: 'job-usage-1', label: 'Phiếu xuất' }]));
  render(<MaterialUsageSection jobId="job-1"/>);
  fireEvent.change(screen.getByLabelText('Vật tư'), { target: { value: 'm-1' } });
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lưu vật tư' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('job-usage-1'));
  expect(screen.getByRole('spinbutton').getAttribute('value')).toBe('3');
  fireEvent.click(screen.getByRole('button', { name: 'Lưu vật tư' }));
  expect(state.upsertUsage).toHaveBeenCalledTimes(1);
});
