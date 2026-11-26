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
// Ô chọn của Radix thay bằng ô chọn gốc để chọn loại kiểm kê / nhà cung cấp trong jsdom.
vi.mock('@/components/ui/select', () => ({
  Select: (p: { children: React.ReactNode; value: string; onValueChange: (value: string) => void }) => <select value={p.value ?? ''} onChange={e => p.onValueChange(e.target.value)}>{p.children}</select>,
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: (p: { children: React.ReactNode }) => <>{p.children}</>,
  SelectItem: (p: { value: string; children: React.ReactNode }) => <option value={p.value}>{p.children}</option>,
}));
import type React from 'react';
import { seedLegacyPending, pendingKeys } from '@/hooks/__tests__/fakeRecordServer';
import { FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import MaterialUsageFormDialog from '../MaterialUsageFormDialog';
import MaterialUsageSection from '../MaterialUsageSection';
import MaterialPurchaseFormDialog from '../MaterialPurchaseFormDialog';
import MaterialAdjustmentFormDialog from '../MaterialAdjustmentFormDialog';
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a'); });

// Đợt 9 (luật 5): tạo phiếu vật tư dùng mã do trình duyệt sinh (đầu phiếu và dòng), nên kết quả chưa rõ KHÔNG khoá form.
// Trước đợt 9 test này tên «phiếu nhập partial giữ dòng và ID sau đóng/mở, không gửi lại» và chốt lần bấm sau bị chặn. Nay:
// giữ dòng và mã qua đóng/mở, nút bấm được, bấm lại gửi đúng nội dung và đúng mã bản nháp (hook dùng lại đúng mã phiếu);
// tạo xong mở form lại là bản nháp mới.
const unclear = (id: string, label: string): Array<[string, () => Error]> => [
  ['lặp lại được', () => new RepeatableWriteUnknownError(`tạo ${label}`, undefined, [{ id, label }])],
  ['kiểu cũ «partial»', () => new FinancialWorkflowError(`${label} đã tạo một phần.`, 'partial', [{ id, label }])],
];
it.each(unclear('purchase-1', 'phiếu nhập'))('phiếu nhập chưa rõ kết quả (%s): giữ dòng và mã qua đóng/mở, KHÔNG khoá; bấm lại gửi đúng nội dung và bản nháp', async (_label, failure) => {
  state.createPurchase.mockReset().mockRejectedValueOnce(failure()).mockResolvedValue({ id: 'purchase-1' });
  const onOpenChange = vi.fn();
  const view = render(<MaterialPurchaseFormDialog open onOpenChange={onOpenChange} editing={null}/>);
  fireEvent.change(screen.getByLabelText('Vật tư'), { target: { value: 'm-1' } });
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu nhập' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('purchase-1'));
  expect(onOpenChange).not.toHaveBeenCalled();
  view.rerender(<MaterialPurchaseFormDialog open={false} onOpenChange={onOpenChange} editing={null}/>);
  view.rerender(<MaterialPurchaseFormDialog open onOpenChange={onOpenChange} editing={null}/>);
  expect(screen.getAllByRole('spinbutton')[0].getAttribute('value')).toBe('3');
  expect((screen.getByRole('button', { name: 'Tạo phiếu nhập' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu nhập' }));
  await waitFor(() => expect(state.createPurchase).toHaveBeenCalledTimes(2));
  expect(state.createPurchase.mock.calls[1][0]).toEqual(state.createPurchase.mock.calls[0][0]);
  expect(state.createPurchase.mock.calls[0][0]).toMatchObject({ draftKey: expect.any(String), items: [{ material_id: 'm-1', quantity: 3 }] });
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  view.rerender(<MaterialPurchaseFormDialog open={false} onOpenChange={onOpenChange} editing={null}/>);
  view.rerender(<MaterialPurchaseFormDialog open onOpenChange={onOpenChange} editing={null}/>);
  fireEvent.change(screen.getByLabelText('Vật tư'), { target: { value: 'm-1' } });
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu nhập' }));
  await waitFor(() => expect(state.createPurchase).toHaveBeenCalledTimes(3));
  expect((state.createPurchase.mock.calls[2][0] as { draftKey: string }).draftKey).not.toBe((state.createPurchase.mock.calls[0][0] as { draftKey: string }).draftKey);
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

const fillTwoCounts = () => {
  fireEvent.change(screen.getByLabelText('Vật tư'), { target: { value: 'm-1' } });
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Thêm dòng' }));
  fireEvent.change(screen.getAllByLabelText('Vật tư')[1], { target: { value: 'm-2' } });
  fireEvent.change(screen.getAllByRole('spinbutton')[1], { target: { value: '4' } });
};

// Đợt 9: kiểm kê nhiều vật tư không giữ dấu lồng nữa. Trước đợt 9 test này tên «SET nhiều dòng giữ ID dòng đã lưu khi dòng
// sau lỗi, khóa lập lại toàn bộ». Nay: báo mã phiếu đã lưu, KHÔNG khoá; bấm lại chạy lại cả vòng — mỗi lần đặt tồn, hook đọc
// lại tồn hiện tại trên máy chủ nên vật tư đã khớp không ghi thêm. Form không gửi số tồn của màn.
it('kiểm kê nhiều vật tư: dòng sau chưa rõ ⇒ báo mã phiếu đã lưu, KHÔNG khoá; bấm lại chạy lại cả vòng, không gửi tồn của màn', async () => {
  state.setStock.mockReset()
    .mockResolvedValueOnce({ id: 'adjustment-1' })
    .mockRejectedValueOnce(new RepeatableWriteUnknownError('điều chỉnh tồn kho'))
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: 'adjustment-2' });
  const onOpenChange = vi.fn();
  render(<MaterialAdjustmentFormDialog open onOpenChange={onOpenChange}/>);
  fillTwoCounts();
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu kiểm kê' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('adjustment-1'));
  expect(screen.getByRole('alert').textContent).toContain('Bấm lại');
  expect(onOpenChange).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Tạo phiếu kiểm kê' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu kiểm kê' }));
  await waitFor(() => expect(state.setStock).toHaveBeenCalledTimes(4));
  expect(state.setStock.mock.calls[0][0]).toEqual({ material_id: 'm-1', target_quantity: 3, reason: expect.any(String) });
  expect(state.setStock.mock.calls[2][0]).toEqual(state.setStock.mock.calls[0][0]);
  expect(state.setStock.mock.calls[3][0]).toEqual(state.setStock.mock.calls[1][0]);
  expect(state.setStock.mock.calls[3][0]).toMatchObject({ material_id: 'm-2', target_quantity: 4 });
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

it('kiểm kê nhiều vật tư: dòng sau bị từ chối rõ ⇒ báo mã phiếu đã lưu, không lộ lỗi gốc, không khoá', async () => {
  state.setStock.mockReset().mockResolvedValueOnce({ id: 'adjustment-1' }).mockRejectedValueOnce({ code: '42501', message: 'raw SQL' });
  render(<MaterialAdjustmentFormDialog open onOpenChange={vi.fn()}/>);
  fillTwoCounts();
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu kiểm kê' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('adjustment-1'));
  expect(screen.getByRole('alert').textContent).not.toContain('raw SQL');
  expect((screen.getByRole('button', { name: 'Tạo phiếu kiểm kê' }) as HTMLButtonElement).disabled).toBe(false);
});

it('kiểm kê nhiều vật tư: dấu bản trước (khoá create) gieo sẵn không chặn; lưu xong thì gỡ', async () => {
  seedLegacyPending({ namespace: 'material-adjustment-batch', userId: 'actor', organizationId: 'org-a', businessKey: 'create' }, new Date(Date.now() - 10 * 60_000));
  state.setStock.mockReset().mockResolvedValue({ id: 'adjustment-1' });
  const onOpenChange = vi.fn();
  render(<MaterialAdjustmentFormDialog open onOpenChange={onOpenChange}/>);
  fireEvent.change(screen.getByLabelText('Vật tư'), { target: { value: 'm-1' } });
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu kiểm kê' }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(state.setStock).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(pendingKeys()).toEqual([]));
});

it.each(unclear('adjustment-1', 'phiếu kiểm kê'))('phiếu kiểm kê IN chưa rõ kết quả (%s): KHÔNG khoá; bấm lại gửi đúng nội dung và bản nháp', async (_label, failure) => {
  state.createAdjustment.mockReset().mockRejectedValueOnce(failure()).mockResolvedValue({ id: 'adjustment-1' });
  const onOpenChange = vi.fn();
  render(<MaterialAdjustmentFormDialog open onOpenChange={onOpenChange}/>);
  const typeSelect = screen.getAllByRole('combobox').find(element => element.querySelector('option[value="IN"]'))!;
  fireEvent.change(typeSelect, { target: { value: 'IN' } });
  fireEvent.change(screen.getByLabelText('Vật tư'), { target: { value: 'm-1' } });
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu kiểm kê' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('adjustment-1'));
  expect((screen.getByRole('button', { name: 'Tạo phiếu kiểm kê' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu kiểm kê' }));
  await waitFor(() => expect(state.createAdjustment).toHaveBeenCalledTimes(2));
  expect(state.createAdjustment.mock.calls[1][0]).toEqual(state.createAdjustment.mock.calls[0][0]);
  expect(state.createAdjustment.mock.calls[0][0]).toMatchObject({ type: 'IN', draftKey: expect.any(String), items: [{ material_id: 'm-1', quantity: 2 }] });
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

// Đợt 9: trước đợt 9 test này tên «phiếu xuất partial giữ bản nháp và ID sau đóng/mở, khóa tạo lại». Nay không khoá.
it.each(unclear('usage-1', 'phiếu xuất'))('phiếu xuất chưa rõ kết quả (%s): giữ bản nháp và mã qua đóng/mở, KHÔNG khoá; bấm lại gửi đúng nội dung và bản nháp', async (_label, failure) => {
  state.createUsage.mockReset().mockRejectedValueOnce(failure()).mockResolvedValue('usage-1');
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
  expect((screen.getByRole('button', { name: 'Tạo phiếu xuất' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Tạo phiếu xuất' }));
  await waitFor(() => expect(state.createUsage).toHaveBeenCalledTimes(2));
  expect(state.createUsage.mock.calls[1][0]).toEqual(state.createUsage.mock.calls[0][0]);
  expect(state.createUsage.mock.calls[0][0]).toMatchObject({ draftKey: expect.any(String), items: [{ material_id: 'm-1', quantity: 3 }] });
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
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
