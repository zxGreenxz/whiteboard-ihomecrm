// @vitest-environment jsdom
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
const h=vi.hoisted(()=>({create:vi.fn(),error:false}));
function query(data:unknown,error:unknown=null){return {data,error,isLoading:false,isError:!!error,status:error?'error':'success',fetchStatus:'idle',refetch:vi.fn()};}
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>query({id:'u'})}));
vi.mock('@/hooks/useAccounts',()=>({useAccounts:()=>query([{id:'b',name:'Sổ Thu',user_id:'u'}])}));
vi.mock('@/hooks/useStaffUsers',()=>({useStaffUsers:()=>query([{id:'other',full_name:'An'}])}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o'})}));
vi.mock('@/hooks/useReceivingCashbooks',()=>({useReceivingCashbooks:()=>query({personalCashBook:{id:'b',name:'Sổ Thu'}})}));
vi.mock('@/hooks/useCashHandovers',()=>({
 useUnhandedVouchers:()=>({...query(h.error?undefined:[{id:'v',code:'PT1',total_amount:100,type:'INCOME'}],h.error?new Error('SQL internal'):null),accountId:'b'}),
 useCashHandoverList:()=>({...query([]),actionCount:0}),
 useCreateHandover:()=>({mutateAsync:h.create,isPending:false}),
 useConfirmHandover:()=>({mutateAsync:vi.fn(),isPending:false}),useConfirmCancelHandover:()=>({mutateAsync:vi.fn(),isPending:false}),
 useRequestCancelHandover:()=>({mutateAsync:vi.fn(),isPending:false}),useRejectCancelHandover:()=>({mutateAsync:vi.fn(),isPending:false}),
}));
import {HandoverSheet} from './HandoverSheet';
beforeEach(()=>{h.create.mockReset();h.error=false;});afterEach(cleanup);
describe('handover field feedback',()=>{
 it('shows the missing receiver and moves focus to that selector',async()=>{
  render(<HandoverSheet show onClose={vi.fn()} />);fireEvent.click(screen.getByRole('button',{name:/Xác nhận giao/}));
  await screen.findByText('Chọn người nhận bàn giao.');
  await waitFor(()=>expect(document.activeElement?.getAttribute('name')).toBe('receiver'));
  expect(h.create).not.toHaveBeenCalled();
 });
 it('does not display no-vouchers text when loading failed',()=>{
  h.error=true;render(<HandoverSheet show onClose={vi.fn()} />);
  expect(screen.getByText(/Chưa tải được phiếu và danh mục bàn giao/)).toBeTruthy();
  expect(document.body.textContent).not.toContain('Không còn phiếu');expect(document.body.textContent).not.toContain('SQL internal');
 });
});
