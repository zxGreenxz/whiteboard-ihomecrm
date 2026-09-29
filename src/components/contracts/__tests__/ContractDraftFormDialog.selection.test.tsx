// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyContractDraftPayload, type ContractDraft, type ContractDraftPayload } from '@/lib/contractDrafts';
import type { ContractCreateRequest } from '@/lib/contractCreateRpc';
import { ContractDraftFormDialog } from '../ContractDraftFormDialog';

const actions = vi.hoisted(() => ({ save: vi.fn(), export: vi.fn(), submit: vi.fn(), templates: [] as unknown[], templatesLoading: false, templatesError: false, payload: {} as ContractDraftPayload, draftIds: [] as (string | undefined)[],
  request: undefined as ContractCreateRequest | undefined, onCreateRequest: undefined as ((request: ContractCreateRequest) => Promise<void>) | undefined,
}));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: '11111111-1111-4111-8111-111111111111' }) }));
vi.mock('@/hooks/useDocumentTemplates', () => ({ useDocumentTemplatesByType: () => ({ data: actions.templatesLoading || actions.templatesError ? undefined : actions.templates, isLoading: actions.templatesLoading, isError: actions.templatesError }) }));
vi.mock('@/hooks/useContractDrafts', () => ({
  useSaveContractDraft: () => ({ mutateAsync: actions.save, isPending: false }),
  useExportContractDraft: () => ({ mutateAsync: actions.export, isPending: false }),
  useDownloadContractDraftDocument: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../contract-form/useContractFormState', async () => {
  const { useForm } = await import('react-hook-form');
  const { useEffect } = await import('react');
  return { useContractFormState: ({draft}:{draft?:ContractDraft}) => {
    actions.draftIds.push(draft?.id);
    const form = useForm({defaultValues:{...emptyContractDraftPayload().form,contract_template_id:draft?.template_id ?? null}});
    useEffect(() => { form.setValue('contract_template_id',draft?.template_id ?? null); },[draft?.id,draft?.template_id,form]);
    return {form,selectedBuildingId:'22222222-2222-4222-8222-222222222222',selectedCustomers:[],selectedServices:[],
      isEditMode:false,isPending:false,blockByDepositDebt:true,customerDialogOpen:false,serviceDialogOpen:false,typedDepositTotal:0,approvedOrphanTotal:0,
      getDraftPayload:()=>structuredClone(actions.payload),onInvalid:vi.fn()};
  }};
});
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{__superadmin:true}})}));
vi.mock('../contract-form/useContractSubmit',()=>({useContractSubmit:({onCreateRequest}:{onCreateRequest?: (request:ContractCreateRequest)=>Promise<void>})=>{
  actions.onCreateRequest=onCreateRequest;return actions.submit;
}}));
vi.mock('../PrintContractDraftDialog',async()=>{const{Dialog,DialogContent,DialogTitle}=await import('@/components/ui/dialog');return {PrintContractDraftDialog:({draft,onDraftSaved,onPrinted,onOpenChange}:{draft:ContractDraft;onDraftSaved:(draft:ContractDraft)=>void;onPrinted:(draft:ContractDraft)=>void;onOpenChange:(open:boolean)=>void})=><Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>In hợp đồng</DialogTitle>
  <p>Đang in phiên bản {draft.revision}</p>
  <button onClick={()=>{onDraftSaved({...draft,revision:3,template_id:activeId});onOpenChange(false);}}>Đổi mẫu xong, xuất lỗi rồi hủy</button>
  <button onClick={()=>onOpenChange(false)}>Hủy in</button>
  <button onClick={()=>onPrinted({...draft,revision:3,template_id:activeId,documents:[{id:'88888888-8888-4888-8888-888888888888',draft_id:draft.id,revision:3,document_path:'document',template_path:'template',document_sha256:'a'.repeat(64),template_sha256:'b'.repeat(64),template_snapshot:{id:activeId,name:'Mẫu hoạt động',updated_at:'2026-09-29'},created_at:'2026-09-29'}]})}>Tải xuống .docx</button>
</DialogContent></Dialog>}});
vi.mock('../ConfirmContractSigningDialog',async()=>{const{Dialog,DialogContent,DialogTitle}=await import('@/components/ui/dialog');return {ConfirmContractSigningDialog:({draft}:{draft:ContractDraft})=><Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>Xác nhận ký</DialogTitle>Phiên bản ký {draft.revision} · {draft.documents[0]?.id}</DialogContent></Dialog>}});
vi.mock('../contract-form/RentDepositSection',()=>({RentDepositSection:()=> <p>RentDepositSection</p>}));
vi.mock('../contract-form/FirstInvoicePreview',()=>({FirstInvoicePreview:()=> <p>FirstInvoicePreview</p>}));
vi.mock('../CommissionVoucherModal',()=>({CommissionVoucherModal:()=>null}));
vi.mock('../contract-form/GeneralSection', () => ({ GeneralSection: () => null }));
vi.mock('../contract-form/CustomersSection', () => ({ CustomersSection: () => null }));
vi.mock('../contract-form/ServicesSection', () => ({ ServicesSection: () => null }));
vi.mock('../CustomerSelectionDialog', () => ({ CustomerSelectionDialog: () => null }));
vi.mock('../ServiceSelectionDialog', () => ({ ServiceSelectionDialog: () => null }));
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/date-input', () => ({ DateInput: () => null }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: React.ReactNode }) => <select value={value} onChange={event => onValueChange(event.target.value)}>{children}</select>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
  SelectTrigger: () => null, SelectValue: () => null,
}));
const org = '11111111-1111-4111-8111-111111111111';
const activeId = '00000000-0000-4000-8000-000000000001';
const inactiveId = '00000000-0000-4000-8000-000000000002';
const otherId = '00000000-0000-4000-8000-000000000003';
const draft = (templateId: string): ContractDraft => ({ id: '77777777-7777-4777-8777-777777777777', organization_id: org,
  building_id: '22222222-2222-4222-8222-222222222222', room_id: null, payload: emptyContractDraftPayload(), template_id: templateId,
  revision: 1, created_by: '66666666-6666-4666-8666-666666666666', created_at: '2026-09-28', updated_at: '2026-09-28', documents: [] });
afterEach(cleanup);
beforeEach(() => {
  actions.templates = [{ id: activeId, name: 'Mẫu hoạt động', organization_id: org, is_active: true },
    { id: inactiveId, name: 'Mẫu đã tắt', organization_id: org, is_active: false },
    { id: otherId, name: 'Mẫu tổ chức khác', organization_id: '99999999-9999-4999-8999-999999999999', is_active: true }];
  actions.payload = { ...emptyContractDraftPayload(), form: { ...emptyContractDraftPayload().form, notes: 'Nội dung đang soạn' } };
  actions.save.mockReset().mockImplementation(async (input: { templateId: string | null }) => ({ ...draft(activeId), payload: actions.payload, template_id: input.templateId, revision: 2 }));
  actions.export.mockReset();
  actions.templatesLoading=false;actions.templatesError=false;
  actions.request=undefined;actions.onCreateRequest=undefined;
  actions.submit.mockReset().mockImplementation(()=>actions.request ? actions.onCreateRequest?.(actions.request) : undefined);
  actions.draftIds = [];
});
it('opens the complete official form and saves incomplete input as draft without submitting a contract', async () => {
  render(<ContractDraftFormDialog open onOpenChange={vi.fn()} />);
  screen.getByRole('heading', { name: 'Tạo hợp đồng mới' });
  screen.getByText('RentDepositSection'); screen.getByText('FirstInvoicePreview');
  fireEvent.click(screen.getByRole('button', { name: /^Lưu$/ }));
  const choice = screen.getByRole('dialog', { name: 'Bạn muốn lưu hợp đồng thế nào?' });
  expect(actions.save).not.toHaveBeenCalled(); expect(actions.submit).not.toHaveBeenCalled();
  fireEvent.click(within(choice).getByRole('button', { name: 'Lưu nháp' }));
  await waitFor(() => expect(actions.save).toHaveBeenCalledOnce());
  expect(actions.submit).not.toHaveBeenCalled();
  await waitFor(() => expect(actions.draftIds.at(-1)).toBe('77777777-7777-4777-8777-777777777777'));
});
it('requires an explicit signing choice before using the official submit path', async () => {
  render(<ContractDraftFormDialog open onOpenChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /^Lưu$/ }));
  const choice = screen.getByRole('dialog', { name: 'Bạn muốn lưu hợp đồng thế nào?' });
  fireEvent.click(within(choice).getByRole('button', { name: 'Xác nhận ký' }));
  await waitFor(() => expect(actions.submit).toHaveBeenCalledOnce());
  expect(actions.save).not.toHaveBeenCalled();
});
it('keeps the official deposit-adjustment note in the saved draft document terms', async () => {
  const empty = emptyContractDraftPayload();
  actions.payload = { ...empty, form: { ...empty.form, rent_price: 4000000, total_deposit: 3000000, notes: 'Thoả thuận' } };
  render(<ContractDraftFormDialog open onOpenChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
  await waitFor(() => expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
    form: expect.objectContaining({ notes: expect.stringContaining('[Điều chỉnh cọc]') }),
  }) })));
});
it('saves an unavailable-template draft without exposing print controls in the editor', async () => {
  render(<ContractDraftFormDialog open draft={draft(inactiveId)} onOpenChange={vi.fn()} />);
  expect(screen.queryByText('Thông tin chủ nhà trên tài liệu')).toBeNull();
  expect(screen.queryByText('Mẫu hợp đồng')).toBeNull();
  expect(screen.queryByRole('button', { name: /xuất nháp|Nháp v/i })).toBeNull();
  expect(screen.queryByRole('option', { name: 'Mẫu hoạt động' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'Mẫu đã tắt' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'Mẫu tổ chức khác' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
  await waitFor(() => expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ templateId: null, expectedRevision: 1 })));
});
it('preserves a previously selected active template while saving from the plain editor', async () => {
  render(<ContractDraftFormDialog open draft={draft(activeId)} onOpenChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
  await waitFor(() => expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ templateId: activeId })));
  expect(actions.export).not.toHaveBeenCalled();
});
it.each(['loading','error'])('preserves the saved template when template lookup is %s',async lookup=>{
  actions.templatesLoading=lookup==='loading';actions.templatesError=lookup==='error';
  render(<ContractDraftFormDialog open draft={draft(activeId)} onOpenChange={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Lưu nháp'}));
  await waitFor(()=>expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({templateId:activeId})));
});
function prepareSigningInput() {
  const contract: ContractCreateRequest['payload']['contract'] = {room_id:'44444444-4444-4444-8444-444444444444',signed_date:'2026-09-28',start_date:'2026-09-28',end_date:'2027-09-28',start_billing_date:'2026-09-28',end_billing_date:'2026-09-30',notes:'Nội dung đã kiểm tra',rent_price:0,total_deposit:0,payment_cycle:'MONTHLY'};
  actions.payload={...emptyContractDraftPayload(),form:{...emptyContractDraftPayload().form,...contract},customers:[{id:'55555555-5555-4555-8555-555555555555',full_name:'Owned customer',phone:'0900000000',id_number:'012345678901',is_representative:true,notes:null}]};
  actions.request={idempotencyKey:crypto.randomUUID(),payload:{contract,customers:[],services:[]}};
}
async function confirmSigningChoice() {
  fireEvent.click(screen.getByRole('button',{name:/^Lưu$/}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'Bạn muốn lưu hợp đồng thế nào?'})).getByRole('button',{name:'Xác nhận ký'}));
}
it('saves signing terms without a template then continues with the exact revision returned by printing',async()=>{
  prepareSigningInput();render(<ContractDraftFormDialog open draft={draft('')} canExport onOpenChange={vi.fn()}/>);
  await confirmSigningChoice();
  const print=await screen.findByRole('dialog',{name:'In hợp đồng'});
  expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({templateId:null,payload:actions.payload}));
  expect(screen.queryByRole('dialog',{name:'Xác nhận ký'})).toBeNull();
  fireEvent.click(within(print).getByRole('button',{name:'Tải xuống .docx'}));
  expect((await screen.findByRole('dialog',{name:'Xác nhận ký'})).textContent).toContain('Phiên bản ký 3 · 88888888-8888-4888-8888-888888888888');
  expect(actions.export).not.toHaveBeenCalled();
});
it('cancelling print leaves the saved draft available without opening signing',async()=>{
  prepareSigningInput();render(<ContractDraftFormDialog open draft={draft('')} canExport onOpenChange={vi.fn()}/>);
  await confirmSigningChoice();
  const print=await screen.findByRole('dialog',{name:'In hợp đồng'});
  fireEvent.click(within(print).getByRole('button',{name:'Hủy in'}));
  expect(screen.queryByRole('dialog',{name:'Xác nhận ký'})).toBeNull();
  expect(screen.getByRole('heading',{name:/Tạo hợp đồng mới/}).textContent).toContain('phiên bản 2');
});
it('uses the newly saved revision after a print failure is cancelled and signing is retried',async()=>{
  prepareSigningInput();render(<ContractDraftFormDialog open draft={draft('')} canExport onOpenChange={vi.fn()}/>);
  await confirmSigningChoice();
  fireEvent.click(within(await screen.findByRole('dialog',{name:'In hợp đồng'})).getByRole('button',{name:'Đổi mẫu xong, xuất lỗi rồi hủy'}));
  expect(screen.queryByRole('dialog',{name:'Xác nhận ký'})).toBeNull();
  await confirmSigningChoice();
  expect((await screen.findByRole('dialog',{name:'In hợp đồng'})).textContent).toContain('Đang in phiên bản 3');
  expect(actions.save).toHaveBeenCalledOnce();
});
