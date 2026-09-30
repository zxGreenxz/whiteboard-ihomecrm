// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import type { ContractDraft } from '@/lib/contractDrafts';
const fixtures = vi.hoisted(() => {
  const id='11111111-1111-4111-8111-111111111111';
  return { id, draft: { id, organization_id:id, building_id:id, room_id:id, revision:1,
    template_id:id, payload:{form:{},customers:[],services:[],use_custom_services:false},
    documents:[{id,revision:1}], created_by:id,created_at:'2026-09-29',updated_at:'2026-09-29' },
    request:{idempotencyKey:id,payload:{contract:{},customers:[],services:[]}} };
});
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:fixtures.id})}));
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{__superadmin:true}})}));
vi.mock('@/hooks/useMyBuildingScope',()=>({useMyBuildingScope:()=>({hasAnyScope:true})}));
vi.mock('@/components/contracts/contract-form/useContractDraftEditor',()=>({useContractDraftEditor:()=>({current:fixtures.draft,errors:[],pending:false,matchesSavedDocument:()=>true,persist:vi.fn()})}));
vi.mock('@/components/contracts/contract-form/useContractSubmit',()=>({useContractSubmit:({onCreateRequest}:{onCreateRequest:(request:typeof fixtures.request)=>void})=>()=>onCreateRequest(fixtures.request)}));
vi.mock('@/components/contracts/contract-form/useContractFormState',async()=>{
  const {useForm}=await import('react-hook-form'); const {useState}=await import('react');
  return {useContractFormState:()=>{
    const [commissionContractId,setCommissionContractId]=useState<string|null>(null);
    return {form:useForm(),sourceIssues:[],isEditMode:false,isPending:false,blockByDepositDebt:false,selectedBuildingId:fixtures.id,
      selectedCustomers:[],selectedServices:[],typedDepositTotal:0,approvedOrphanTotal:0,
      commissionContractId,setCommissionContractId,onInvalid:vi.fn()};
  }};
});
vi.mock('@/components/contracts/ContractDraftList',()=>({ContractDraftList:({onEdit}:{onEdit:(draft:typeof fixtures.draft)=>void})=><button onClick={()=>onEdit(fixtures.draft)}>Mở nháp kiểm tra</button>}));
vi.mock('@/components/contracts/ConfirmContractSigningDialog',async()=>{const {Dialog,DialogContent,DialogTitle}=await import('@/components/ui/dialog');return {ConfirmContractSigningDialog:({onSigned}:{onSigned:(signing:{contract_id:string})=>void})=><Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>Ký kiểm tra</DialogTitle><button onClick={()=>onSigned({contract_id:fixtures.id})}>Hoàn tất ký kiểm tra</button></DialogContent></Dialog>};});
vi.mock('@/components/contracts/CommissionVoucherModal',()=>({CommissionVoucherModal:({open}:{open:boolean})=>open?<div role="dialog" aria-label="Tạo phiếu chi hoa hồng">Hoa hồng và thưởng Sale</div>:null}));
vi.mock('@/components/contracts/contract-form/RentDepositSection',()=>({RentDepositSection:()=>null}));
vi.mock('@/components/contracts/contract-form/FirstInvoicePreview',()=>({FirstInvoicePreview:()=>null}));
vi.mock('@/components/contracts/contract-form/GeneralSection',()=>({GeneralSection:()=>null}));
vi.mock('@/components/contracts/contract-form/CustomersSection',()=>({CustomersSection:()=>null}));
vi.mock('@/components/contracts/contract-form/ServicesSection',()=>({ServicesSection:()=>null}));
vi.mock('@/components/contracts/CustomerSelectionDialog',()=>({CustomerSelectionDialog:()=>null}));
vi.mock('@/components/contracts/ServiceSelectionDialog',()=>({ServiceSelectionDialog:()=>null}));
vi.mock('@/components/ui/scroll-area',()=>({ScrollArea:({children}:{children:ReactNode})=><div>{children}</div>}));
import { ContractFormDialog } from '@/components/contracts/ContractFormDialog';
import { ContractDraftWorkspace } from '@/components/contracts/ContractDraftWorkspace';
function PersistentForm(){const [open,setOpen]=useState(true);return <ContractFormDialog open={open} onOpenChange={setOpen} draft={fixtures.draft as unknown as ContractDraft}/>;}
async function sign(){
  const form=await screen.findByRole('dialog',{name:/Tạo hợp đồng mới/});
  fireEvent.click(within(form).getByRole('button',{name:'Lưu'}));
  fireEvent.click(within(await screen.findByRole('dialog',{name:'Bạn muốn lưu hợp đồng thế nào?'})).getByRole('button',{name:'Xác nhận ký'}));
  fireEvent.click(await screen.findByRole('button',{name:'Hoàn tất ký kiểm tra'}));
}
afterEach(cleanup);
it('control: keeping the form mounted opens commission after signing',async()=>{
  render(<PersistentForm/>);await sign();
  expect(await screen.findByRole('dialog',{name:'Tạo phiếu chi hoa hồng'})).toBeTruthy();
});
it('saved-draft workspace must retain the commission dialog after signing',async()=>{
  render(<ContractDraftWorkspace alwaysExpanded/>);
  fireEvent.click(await screen.findByRole('button',{name:'Mở nháp kiểm tra'}));
  await sign();
  expect(await screen.findByRole('dialog',{name:'Tạo phiếu chi hoa hồng'})).toBeTruthy();
});
