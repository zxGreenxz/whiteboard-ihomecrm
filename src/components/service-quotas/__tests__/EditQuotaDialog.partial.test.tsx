// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const update = vi.fn();
vi.mock('@/hooks/useServices', () => ({
  useUpdateServiceQuota: () => ({ mutateAsync: update, isPending: false }),
}));
import { FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import { EditQuotaDialog } from '../EditQuotaDialog';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
afterEach(() => { cleanup(); update.mockReset(); });

// Đợt 8: sửa định mức lặp lại được (xoá rồi chèn lại bậc giá cho đúng một bộ) ⇒ lỗi sau khi đã gỡ bậc cũ chỉ báo rõ,
// nút Cập nhật không khoá: bấm lại là ghi lại đủ bậc giá.
it('core đã lưu nhưng bậc giá lỗi: báo rõ đã gỡ bậc cũ, không khoá, bấm Cập nhật lại gửi lại', async () => {
  update.mockRejectedValueOnce(new FinancialWorkflowError('Đã gỡ các bậc giá cũ của định mức (1 bậc) nhưng chưa lưu được bậc giá mới. Bấm Cập nhật để lưu lại đủ bậc giá.', 'failure', []))
    .mockResolvedValueOnce({ id: 'quota-1' });
  const close = vi.fn();
  render(<EditQuotaDialog open onOpenChange={close} quota={{
    id: 'quota-1', name: 'Điện', description: null,
    service_quota_tiers: [{ tier_number: 1, from_value: 0, to_value: null, unit_price: 1000 }],
  } as never} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
  await screen.findByText(/Đã gỡ các bậc giá cũ.*chưa lưu được bậc giá mới/);
  expect(close).not.toHaveBeenCalled();
  const submit = screen.getByRole('button', { name: 'Cập nhật' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
});

it.each([
 ['lặp lại được',()=>new RepeatableWriteUnknownError('lưu bậc giá mới sau khi đã gỡ bậc giá cũ',undefined,[{id:'quota-1',label:'Đã lưu định mức'}])],
 ['chưa rõ kiểu cũ',()=>new FinancialWorkflowError('Chưa xác nhận định mức.','unknown',[{id:'quota-1',label:'Đã lưu định mức'}])],
])('unknown outcome (%s) keeps draft after refreshed quota and close/reopen, and allows another submit',async(_label,failure)=>{
 update.mockRejectedValueOnce(failure());
 const quota={id:'quota-1',name:'Điện',description:null,service_quota_tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:1000}]} as never;
 const close=vi.fn();const view=render(<EditQuotaDialog open onOpenChange={close} quota={quota}/>);
 fireEvent.change(screen.getByPlaceholderText('Nhập tên định mức'),{target:{value:'Draft giữ'}});fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));
 await screen.findByRole('alert');view.rerender(<EditQuotaDialog open={false} onOpenChange={close} quota={{...quota as object,name:'Reloaded'} as never}/>);view.rerender(<EditQuotaDialog open onOpenChange={close} quota={{...quota as object,name:'Reloaded'} as never}/>);
 expect((screen.getByPlaceholderText('Nhập tên định mức') as HTMLInputElement).value).toBe('Draft giữ');
 expect(screen.getByRole('alert').textContent).toContain('quota-1');fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));
 await waitFor(()=>expect(update).toHaveBeenCalledTimes(2));expect(update).toHaveBeenLastCalledWith(expect.objectContaining({id:'quota-1',name:'Draft giữ'}));
});