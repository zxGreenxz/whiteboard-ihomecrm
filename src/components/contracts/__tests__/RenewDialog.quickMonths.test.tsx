// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import { RenewDialog } from '../RenewDialog';
// Nút "+6 / +12 tháng": ngày mới do hàm SQL dùng chung tính (service mock), điền vào ô ngày; lỗi thì báo và để người dùng chọn tay.
const actions=vi.hoisted(()=>({renew:vi.fn(),fetch:vi.fn()}));
vi.mock('@/hooks/useContractOperations',()=>({useRenewContract:()=>({mutate:actions.renew,isPending:false})}));
vi.mock('@/lib/contractRenewalEndDate',()=>({RENEWAL_QUICK_MONTHS:[6,12],fetchRenewalEndDate:actions.fetch}));
vi.mock('@/components/ui/date-input',()=>({DateInput:({onChange,...props}:{onChange?:(value:string)=>void;id?:string;name?:string;value?:string})=><input {...props} onChange={event=>onChange?.(event.target.value)}/>}));
const contract={id:'00000000-0000-4000-8000-000000000007',end_date:'2027-02-28',rent_price:4000000,total_deposit:4000000,expected_move_out_date:null,updated_at:'2026-10-01T00:00:00+00:00'} as ContractWithRelations;
afterEach(()=>{cleanup();actions.renew.mockClear();actions.fetch.mockReset();});

it('fills the new end date from the shared SQL rule and still submits as a normal renewal', async()=>{
  actions.fetch.mockResolvedValue('2027-08-31');
  render(<RenewDialog open onOpenChange={vi.fn()} contract={contract}/>);
  fireEvent.click(screen.getByRole('button',{name:'+6 tháng'}));
  await waitFor(()=>expect((screen.getByLabelText(/Ngày kết thúc mới/) as HTMLInputElement).value).toBe('2027-08-31'));
  expect(actions.fetch).toHaveBeenCalledWith('2027-02-28',6);
  fireEvent.change(screen.getByLabelText(/Lý do gia hạn/),{target:{value:'Gia hạn theo thỏa thuận của khách thuê'}});
  fireEvent.click(screen.getByRole('button',{name:'Gia hạn'}));
  await waitFor(()=>expect(actions.renew).toHaveBeenCalledTimes(1));
  expect(actions.renew.mock.calls[0][0]).toMatchObject({newEndDate:'2027-08-31',noticeChoice:'KEEP'});
});

it('shows a fallback message and leaves the date empty when the shared rule cannot be reached', async()=>{
  actions.fetch.mockRejectedValue(new Error('offline'));
  render(<RenewDialog open onOpenChange={vi.fn()} contract={contract}/>);
  fireEvent.click(screen.getByRole('button',{name:'+12 tháng'}));
  await screen.findByText('Chưa tính được ngày mới, hãy chọn ngày bằng tay.');
  expect((screen.getByLabelText(/Ngày kết thúc mới/) as HTMLInputElement).value).toBe('');
  expect(actions.fetch).toHaveBeenCalledWith('2027-02-28',12);
});
