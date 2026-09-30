// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const update = vi.fn();
vi.mock('@/hooks/useServices', () => ({
  ServiceQuotaPartialError: class ServiceQuotaPartialError extends Error {
    constructor(public quotaId: string) { super(`Định mức ${quotaId} đã lưu, nhưng bậc giá chưa hoàn tất.`); }
  },
  useUpdateServiceQuota: () => ({ mutateAsync: update, isPending: false }),
}));
import { ServiceQuotaPartialError } from '@/hooks/useServices';
import { EditQuotaDialog } from '../EditQuotaDialog';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
afterEach(() => { cleanup(); update.mockReset(); });

it('khóa lần lưu tiếp theo sau khi core đã lưu nhưng bậc giá lỗi', async () => {
  update.mockRejectedValueOnce(new ServiceQuotaPartialError('quota-1', new Error('offline')));
  const close = vi.fn();
  render(<EditQuotaDialog open onOpenChange={close} quota={{
    id: 'quota-1', name: 'Điện', description: null,
    service_quota_tiers: [{ tier_number: 1, from_value: 0, to_value: null, unit_price: 1000 }],
  } as never} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cập nhật' }));
  await screen.findByText(/quota-1 đã lưu, nhưng bậc giá chưa hoàn tất/);
  const submit = screen.getByRole('button', { name: 'Cập nhật' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(submit);
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(close).not.toHaveBeenCalled();
});

it('unknown outcome keeps draft after refreshed quota and close/reopen, and blocks another submit',async()=>{
 const {FinancialWorkflowError}=await import('@/lib/financialWorkflow');
 update.mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận định mức.','unknown',[{id:'quota-1',label:'Đã lưu định mức'}]));
 const quota={id:'quota-1',name:'Điện',description:null,service_quota_tiers:[{tier_number:1,from_value:0,to_value:null,unit_price:1000}]} as never;
 const close=vi.fn();const view=render(<EditQuotaDialog open onOpenChange={close} quota={quota}/>);
 fireEvent.change(screen.getByPlaceholderText('Nhập tên định mức'),{target:{value:'Draft giữ'}});fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));
 await screen.findByRole('alert');view.rerender(<EditQuotaDialog open={false} onOpenChange={close} quota={{...quota as object,name:'Reloaded'} as never}/>);view.rerender(<EditQuotaDialog open onOpenChange={close} quota={{...quota as object,name:'Reloaded'} as never}/>);
 expect((screen.getByPlaceholderText('Nhập tên định mức') as HTMLInputElement).value).toBe('Draft giữ');
 expect(screen.getByRole('alert').textContent).toContain('quota-1');fireEvent.click(screen.getByRole('button',{name:'Cập nhật'}));expect(update).toHaveBeenCalledTimes(1);
});