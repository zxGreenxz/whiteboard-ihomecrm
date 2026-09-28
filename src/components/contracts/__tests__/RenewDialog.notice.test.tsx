// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import { RenewDialog } from '../RenewDialog';
const actions=vi.hoisted(()=>({renew:vi.fn()}));
vi.mock('@/hooks/useContractOperations',()=>({useRenewContract:()=>({mutate:actions.renew,isPending:false})}));
vi.mock('@/components/ui/date-input',()=>({DateInput:({onChange,...props}:{onChange?:(value:string)=>void;id?:string;name?:string;value?:string})=><input {...props} onChange={event=>onChange?.(event.target.value)}/>}));
const contract={id:'00000000-0000-4000-8000-000000000006',end_date:'2026-12-31',rent_price:4000000,total_deposit:4000000,expected_move_out_date:'2026-10-01',updated_at:'2026-09-28T00:00:00+00:00'} as ContractWithRelations;
afterEach(()=>{cleanup();actions.renew.mockClear();});
it('requires an explicit notice choice and reuses the request identity for the same renewal intent',async()=>{
  render(<RenewDialog open onOpenChange={vi.fn()} contract={contract}/>);
  const submit=screen.getByRole('button',{name:'Gia hạn'}) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByRole('combobox',{name:'Giữ hoặc hủy báo dọn khi gia hạn'}),{target:{value:'CANCEL'}});
  fireEvent.change(screen.getByLabelText(/Ngày kết thúc mới/),{target:{value:'2027-12-31'}});
  fireEvent.click(submit);
  await waitFor(()=>expect(actions.renew).toHaveBeenCalledTimes(1));
  expect(actions.renew.mock.calls[0][0]).toMatchObject({noticeChoice:'CANCEL',expectedUpdatedAt:contract.updated_at,newDeposit:4000000,newRentPrice:4000000});
  fireEvent.click(submit);await waitFor(()=>expect(actions.renew).toHaveBeenCalledTimes(2));
  expect(actions.renew.mock.calls[1][0].requestId).toBe(actions.renew.mock.calls[0][0].requestId);
});
