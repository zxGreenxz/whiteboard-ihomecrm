// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyContractDraftPayload, type ContractDraft } from '@/lib/contractDrafts';
import { ContractDraftFormDialog } from '../ContractDraftFormDialog';

const actions = vi.hoisted(() => ({ save: vi.fn(), export: vi.fn(), submit: vi.fn(), templates: [] as unknown[], payload: {}, draftIds: [] as (string | undefined)[] }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: '11111111-1111-4111-8111-111111111111' }) }));
vi.mock('@/hooks/useDocumentTemplates', () => ({ useDocumentTemplatesByType: () => ({ data: actions.templates, isLoading: false, isError: false }) }));
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
      isEditMode:false,isPending:false,blockByDepositDebt:true,customerDialogOpen:false,serviceDialogOpen:false,
      getDraftPayload:()=>structuredClone(actions.payload),onInvalid:vi.fn()};
  }};
});
vi.mock('@/hooks/useMyPermissions',()=>({useMyPermissions:()=>({data:{__superadmin:true}})}));
vi.mock('../contract-form/useContractSubmit',()=>({useContractSubmit:()=>actions.submit}));
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
  actions.submit.mockReset();
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
it('offers only active templates in the selected organization and saves an unavailable-template draft without a template', async () => {
  render(<ContractDraftFormDialog open draft={draft(inactiveId)} onOpenChange={vi.fn()} />);
  screen.getByRole('option', { name: 'Mẫu hoạt động' });
  expect(screen.queryByRole('option', { name: 'Mẫu đã tắt' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'Mẫu tổ chức khác' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
  await waitFor(() => expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ templateId: null, expectedRevision: 1 })));
});
it('allows clearing a selected active template while keeping incomplete content saveable', async () => {
  render(<ContractDraftFormDialog open draft={draft(activeId)} onOpenChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Bỏ chọn mẫu' }));
  fireEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
  await waitFor(() => expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ templateId: null })));
});
it('re-exporting an immutable saved document retains one download entry for its identity',async()=>{
  actions.payload={...emptyContractDraftPayload(),form:{...emptyContractDraftPayload().form,room_id:'44444444-4444-4444-8444-444444444444',signed_date:'2026-09-28',start_date:'2026-09-28',end_date:'2027-09-28',notes:'Edited'},customers:[{id:'55555555-5555-4555-8555-555555555555',full_name:'Owned customer',phone:'0900000000',id_number:'012345678901',is_representative:true,notes:null}]};
  actions.export.mockResolvedValue({document:{id:'88888888-8888-4888-8888-888888888888',revision:2,template_snapshot:{name:'Mẫu hoạt động'}},blob:new Blob()});
  render(<ContractDraftFormDialog open draft={draft(activeId)} canExport onOpenChange={vi.fn()}/>);
  const button=screen.getByRole('button',{name:'Lưu và xuất nháp .docx'});
  fireEvent.click(button);await waitFor(()=>expect(actions.export).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect(screen.getAllByRole('button',{name:'Nháp v2 · Mẫu hoạt động'})).toHaveLength(1));
  fireEvent.click(button);await waitFor(()=>expect(actions.export).toHaveBeenCalledTimes(2));
  await waitFor(()=>expect(screen.getAllByRole('button',{name:'Nháp v2 · Mẫu hoạt động'})).toHaveLength(1));
});
