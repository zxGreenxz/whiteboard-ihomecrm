// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { ContractTransferLinkDialog } from '../ContractTransferLinkDialog';
import { emptyContractDraftPayload,type ContractDraft } from '@/lib/contractDrafts';
import type { ContractExitCase } from '@/lib/contractExitCases';
const actions=vi.hoisted(()=>({save:vi.fn(),reset:vi.fn()}));
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const draft:ContractDraft={id:id(8),organization_id:id(1),building_id:id(3),room_id:id(4),revision:2,status:'EDITABLE',created_by:id(2),created_at:'2026-09-28',updated_at:'2026-09-28',documents:[],template_id:null,
  payload:{...emptyContractDraftPayload(),form:{...emptyContractDraftPayload().form,room_id:id(4),start_date:'2026-10-01',end_date:'2026-12-31',total_deposit:4000000}}};
const exit:ContractExitCase={id:id(7),organization_id:id(1),building_id:id(3),contract_id:id(5),room_at_handover_id:id(4),actual_move_out_on:'2026-09-28',initial_kind:'EARLY_RETURN',current_kind:'EARLY_RETURN',settlement_mode:'DEFERRED',state:'PENDING',version:3,created_at:'2026-09-28',updated_at:'2026-09-28',kind_history:[],settlement_result:null};
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'00000000-0000-4000-8000-000000000001'})}));
vi.mock('@/hooks/useContractDrafts',()=>({useContractDrafts:()=>({data:[],isLoading:false,isError:false})}));
vi.mock('@/hooks/useContractExitCases',()=>({useContractExitCases:()=>({data:{items:[]},isLoading:false,isError:false})}));
vi.mock('@/hooks/contracts/useContractTransferLinks',()=>({useCreateContractTransferLink:()=>({mutateAsync:actions.save,reset:actions.reset,isPending:false,isError:false})}));
afterEach(cleanup);beforeEach(()=>{actions.save.mockReset().mockResolvedValue({});actions.reset.mockClear();});
it('captures unsupported offset explicitly and submits only link data with pinned revisions',async()=>{
  render(<ContractTransferLinkDialog open onOpenChange={vi.fn()} exitCase={exit} draft={draft}/>);
  fireEvent.change(screen.getByRole('combobox',{name:'Cọc khách mới'}),{target:{value:'OLD_DEPOSIT_OFFSET'}});
  expect(screen.getByRole('alert').textContent).toContain('Cọc chưa được chuyển');
  fireEvent.change(screen.getByRole('textbox',{name:'Lý do / ghi chú liên kết'}),{target:{value:'Khách tự tìm'}});
  fireEvent.click(screen.getByRole('button',{name:'Lưu liên kết nhượng'}));
  await waitFor(()=>expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({oldExitCaseId:exit.id,newDraftId:draft.id,expectedExitVersion:3,expectedDraftRevision:2,depositMode:'OLD_DEPOSIT_OFFSET'})));
  const input=actions.save.mock.calls[0][0] as Record<string,unknown>;
  expect(input.deposit_refund).toBeUndefined();expect(input.commission_voucher_id).toBeUndefined();
});
it('broker choice requires recipient and keeps new-payment mode, with mandatory 50% preview copy',async()=>{
  render(<ContractTransferLinkDialog open onOpenChange={vi.fn()} exitCase={exit} draft={draft}/>);
  fireEvent.change(screen.getByRole('combobox',{name:'Nguồn khách mới'}),{target:{value:'BROKER'}});
  expect(screen.queryByRole('option',{name:/Dự kiến cấn cọc cũ/})).toBeNull();
  expect(screen.getByText(/Phí nhượng bằng 50% cọc cũ/)).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox',{name:'Lý do / ghi chú liên kết'}),{target:{value:'Qua môi giới'}});
  expect((screen.getByRole('button',{name:'Lưu liên kết nhượng'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox',{name:'Tên môi giới / người nhận hoa hồng'}),{target:{value:'Môi giới A'}});
  fireEvent.click(screen.getByRole('button',{name:'Lưu liên kết nhượng'}));
  await waitFor(()=>expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({mode:'BROKER',brokerName:'Môi giới A',depositMode:'NEW_PAYMENT'})));
});
