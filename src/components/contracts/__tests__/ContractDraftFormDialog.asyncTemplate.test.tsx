// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {emptyContractDraftPayload,type ContractDraft} from '@/lib/contractDrafts';
import {ContractDraftFormDialog} from '../ContractDraftFormDialog';

const org='11111111-1111-4111-8111-111111111111',template='00000000-0000-4000-8000-000000000001';
const actions=vi.hoisted(()=>({save:vi.fn(),loading:true,templates:[] as unknown[],payload:{}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'11111111-1111-4111-8111-111111111111'})}));
vi.mock('@/hooks/useDocumentTemplates',()=>({useDocumentTemplatesByType:()=>({data:actions.templates,isLoading:actions.loading,isError:false})}));
vi.mock('@/hooks/useContractDrafts',()=>({useSaveContractDraft:()=>({mutateAsync:actions.save,isPending:false}),useExportContractDraft:()=>({mutateAsync:vi.fn(),isPending:false}),useDownloadContractDraftDocument:()=>({mutate:vi.fn(),isPending:false})}));
vi.mock('../contract-form/useContractFormState', async () => {
  const { useForm } = await import('react-hook-form');
  const { useEffect } = await import('react');
  return { useContractFormState: ({draft}:{draft?:ContractDraft}) => {
    const form = useForm({defaultValues:{...emptyContractDraftPayload().form,contract_template_id:draft?.template_id ?? null}});
    useEffect(() => { form.setValue('contract_template_id',draft?.template_id ?? null); },[draft?.id,draft?.template_id,form]);
    return {form,selectedBuildingId:'22222222-2222-4222-8222-222222222222',selectedCustomers:[],selectedServices:[],
      sourceIssues:[],isEditMode:false,isPending:false,blockByDepositDebt:true,customerDialogOpen:false,serviceDialogOpen:false,
      getDraftPayload:()=>structuredClone(actions.payload),onInvalid:vi.fn()};
  }};
});
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{__superadmin:true}})}));
vi.mock('../contract-form/useContractSubmit',()=>({useContractSubmit:()=>vi.fn()}));
vi.mock('../contract-form/RentDepositSection',()=>({RentDepositSection:()=> <p>RentDepositSection</p>}));
vi.mock('../contract-form/FirstInvoicePreview',()=>({FirstInvoicePreview:()=> <p>FirstInvoicePreview</p>}));
vi.mock('../CommissionVoucherModal',()=>({CommissionVoucherModal:()=>null}));
vi.mock('../contract-form/GeneralSection',()=>({GeneralSection:()=>null}));
vi.mock('../contract-form/CustomersSection',()=>({CustomersSection:()=>null}));
vi.mock('../contract-form/ServicesSection',()=>({ServicesSection:()=>null}));
vi.mock('../CustomerSelectionDialog',()=>({CustomerSelectionDialog:()=>null}));
vi.mock('../ServiceSelectionDialog',()=>({ServiceSelectionDialog:()=>null}));
vi.mock('@/components/ui/scroll-area',()=>({ScrollArea:({children}:{children:React.ReactNode})=><div>{children}</div>}));
vi.mock('@/components/ui/date-input',()=>({DateInput:()=>null}));
afterEach(cleanup);

it('retains the saved template when the catalog loads without adding a template control to the editor',async()=>{
 actions.loading=true;actions.templates=[];actions.payload={...emptyContractDraftPayload(),form:{...emptyContractDraftPayload().form,notes:'Edited saved draft'}};
 const draft:ContractDraft={id:'77777777-7777-4777-8777-777777777777',organization_id:org,building_id:'22222222-2222-4222-8222-222222222222',room_id:null,payload:emptyContractDraftPayload(),template_id:template,revision:1,created_by:'66666666-6666-4666-8666-666666666666',created_at:'2026-09-28',updated_at:'2026-09-28',documents:[]};
 actions.save.mockReset().mockImplementation(async()=>({...draft,payload:actions.payload}));
 const props={open:true,draft,onOpenChange:vi.fn()};const view=render(<ContractDraftFormDialog {...props}/>);
 expect(screen.queryByRole('combobox')).toBeNull();
 await act(async()=>{actions.loading=false;actions.templates=[{id:template,name:'Saved active template',organization_id:org,is_active:true}];view.rerender(<ContractDraftFormDialog {...props}/>);});
 expect(screen.queryByRole('combobox')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Lưu nháp'}));
 await waitFor(()=>expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({templateId:template,expectedRevision:1})));
});
