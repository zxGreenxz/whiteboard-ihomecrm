import { useEffect, useRef, useState } from 'react';
import { Loader2, FileDown, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Input } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PAYMENT_CYCLE_LABELS } from '@/types/contract';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useDocumentTemplatesByType } from '@/hooks/useDocumentTemplates';
import { useSaveContractDraft, useExportContractDraft, useDownloadContractDraftDocument } from '@/hooks/useContractDrafts';
import { useContractDraftForm } from '@/hooks/contracts/useContractDraftForm';
import { validateDraftForExport, type ContractDraft, type DraftFieldError } from '@/lib/contractDrafts';
import { GeneralSection } from './contract-form/GeneralSection';
import { CustomersSection } from './contract-form/CustomersSection';
import { ServicesSection } from './contract-form/ServicesSection';
import type { ContractPrefill } from './contract-form/types';
import { CustomerSelectionDialog } from './CustomerSelectionDialog';
import { ServiceSelectionDialog } from './ServiceSelectionDialog';

export interface ContractDraftFormDialogProps {
  open: boolean; onOpenChange: (open: boolean) => void; draft?: ContractDraft;
  prefill?: ContractPrefill; canExport?: boolean; onSaved?: (draft: ContractDraft) => void;
}
export function ContractDraftFormDialog({ open, onOpenChange, draft, prefill, canExport = false, onSaved }: ContractDraftFormDialogProps) {
  const state = useContractDraftForm(open, draft, prefill);
  const { selectedOrganizationId } = useOrganization();
  const save = useSaveContractDraft();
  const exportDocument = useExportContractDraft();
  const download = useDownloadContractDraftDocument();
  const templatesQuery = useDocumentTemplatesByType('lease_contract', { enabled: open });
  const templates = (templatesQuery.data ?? []).filter(template => template.is_active && template.organization_id === selectedOrganizationId);
  const [current, setCurrent] = useState<ContractDraft | undefined>(draft);
  const [templateId, setTemplateId] = useState('');
  const [fieldErrors, setFieldErrors] = useState<DraftFieldError[]>([]);
  const draftIdentity = useRef('');
  const saveIntent = useRef<{ key: string; requestId: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setCurrent(draft); setTemplateId(draft?.template_id ?? ''); setFieldErrors([]);
    draftIdentity.current = draft?.id ?? crypto.randomUUID(); saveIntent.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.id]);
  const pending = save.isPending || exportDocument.isPending || download.isPending;
  const handleSave = async (exportAfter: boolean) => {
    if (!selectedOrganizationId || !state.selectedBuildingId) {
      setFieldErrors([{ field: 'building', label: 'Toà nhà', message: 'Chọn toà nhà để xác định phạm vi bản nháp' }]);
      return;
    }
    if (templateId && (templatesQuery.isLoading || templatesQuery.isError)) {
      setFieldErrors([{ field: 'template', label: 'Mẫu hợp đồng', message: 'Tải lại mẫu đã chọn hoặc bỏ chọn mẫu để chỉ lưu nội dung nháp.' }]);
      return;
    }
    const payload = state.getPayload();
    const selected = templates.find(t => t.id === templateId);
    if (exportAfter) {
      const errors = validateDraftForExport(payload);
      if (!selected) errors.push({ field: 'template', label: 'Mẫu hợp đồng', message: 'Chọn mẫu đang hoạt động để xuất DOCX' });
      setFieldErrors(errors);
      if (errors.length) return;
    } else setFieldErrors([]);
    try {
      const intentKey = JSON.stringify({ payload, templateId: selected?.id ?? null, revision: current?.revision ?? null, buildingId: state.selectedBuildingId });
      if (saveIntent.current?.key !== intentKey) saveIntent.current = { key: intentKey, requestId: crypto.randomUUID() };
      const unchanged = current && JSON.stringify(current.payload) === JSON.stringify(payload)
        && current.template_id === (selected?.id ?? null);
      const saved = unchanged ? current : await save.mutateAsync({ organizationId: selectedOrganizationId, buildingId: state.selectedBuildingId,
        payload, templateId: selected?.id ?? null, draftId: draftIdentity.current, expectedRevision: current?.revision,
        requestId: saveIntent.current.requestId });
      setCurrent(saved); onSaved?.(saved);
      if (exportAfter && selected) {
        const result = await exportDocument.mutateAsync({ draft: saved, template: selected });
        setCurrent({ ...saved, documents: [result.document, ...saved.documents.filter(document => document.id !== result.document.id)] });
      } else toast.success(`Đã lưu bản nháp · phiên bản ${saved.revision}`);
    } catch (error) {
      // Each domain mutation reports its classified error; preserve the user's input.
      console.error('Draft editor operation failed', error);
    }
  };
  return <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value); }}>
    <DialogContent className="max-w-4xl max-h-[90vh] p-0">
      <DialogHeader className="px-6 pt-6"><DialogTitle>{current ? `Sửa bản nháp · phiên bản ${current.revision}` : 'Soạn hợp đồng nháp'}</DialogTitle><DialogDescription>Lưu nội dung đang soạn hoặc chọn mẫu để xuất tài liệu gửi khách xem trước.</DialogDescription></DialogHeader>
      <ScrollArea className="max-h-[calc(90vh-100px)] px-6 pb-6">
        <Alert className="my-4"><AlertDescription>Bản nháp dùng để soạn và gửi khách xem. Lưu hoặc xuất nháp chưa giữ phòng, chưa ký hợp đồng và chưa thu tiền.</AlertDescription></Alert>
        <Form {...state.form}><form className="space-y-6" onSubmit={event => { event.preventDefault(); void handleSave(false); }}>
          {fieldErrors.length > 0 && <Alert variant="destructive"><AlertDescription><ul className="list-disc pl-4">{fieldErrors.map(e => <li key={`${e.field}-${e.label}`}>{e.label}: {e.message}</li>)}</ul></AlertDescription></Alert>}
          <fieldset disabled={pending} className="space-y-6">
            <GeneralSection {...state} buildingDisabled={!!current} />
            <CustomersSection {...state} />
            <div className="space-y-3"><h3 className="text-sm font-semibold border-b pb-2">Chủ nhà trên tài liệu</h3><p className="text-xs text-muted-foreground">Tên và điện thoại để trống sẽ lấy từ hồ sơ chủ toà. Giấy tờ chỉ cần điền khi mẫu yêu cầu.</p><div className="grid md:grid-cols-3 gap-3">{([
              ['name', 'Tên chủ nhà'], ['phone', 'Điện thoại chủ nhà'], ['id_number', 'CCCD/hộ chiếu chủ nhà'], ['id_issue_place', 'Nơi cấp giấy tờ'], ['id_issue_date', 'Ngày cấp giấy tờ'], ['birthday', 'Ngày sinh chủ nhà'],
            ] as const).map(([key, label]) => <div key={key} className="space-y-1"><Label htmlFor={`draft-owner-${key}`}>{label}</Label>{key === 'id_issue_date' || key === 'birthday' ? <DateInput name={`draft-owner-${key}`} value={state.owner[key]} onChange={value => state.setOwner(previous => ({ ...previous, [key]: value }))} /> : <Input id={`draft-owner-${key}`} value={state.owner[key]} onChange={event => state.setOwner(previous => ({ ...previous, [key]: event.target.value }))} />}</div>)}</div></div>
            <div className="grid md:grid-cols-3 gap-4">
              {(['rent_price', 'total_deposit'] as const).map(name => <FormField key={name} control={state.form.control} name={name} render={({ field }) => <FormItem><FormLabel>{name === 'rent_price' ? 'Tiền thuê dự kiến' : 'Tiền cọc thoả thuận'}</FormLabel><FormControl><CurrencyInput value={field.value} onChange={field.onChange} /></FormControl><FormMessage /></FormItem>} />)}
              <FormField control={state.form.control} name="payment_cycle" render={({ field }) => <FormItem><FormLabel>Chu kỳ thanh toán</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent>{Object.entries(PAYMENT_CYCLE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></FormItem>} />
            </div>
            <ServicesSection {...state} />
            <div className="space-y-2"><Label>Mẫu hợp đồng</Label>
              {templatesQuery.isError ? <p className="text-destructive text-sm">Không thể tải mẫu. <Button type="button" variant="link" onClick={() => void templatesQuery.refetch()}>Thử lại</Button></p> : <Select value={templateId || 'NO_TEMPLATE'} onValueChange={value => {
                // Radix's native select emits an empty value before async options arrive.
                // Clearing is an explicit NO_TEMPLATE choice, never that loading event.
                if (value) setTemplateId(value === 'NO_TEMPLATE' ? '' : value);
              }} disabled={templatesQuery.isLoading}><SelectTrigger><SelectValue placeholder={templatesQuery.isLoading ? 'Đang tải mẫu…' : 'Chọn mẫu khi cần xuất nháp'} /></SelectTrigger><SelectContent><SelectItem value="NO_TEMPLATE">Chưa chọn mẫu (chỉ lưu nháp)</SelectItem>{templates.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent></Select>}
              {templateId && <Button type="button" size="sm" variant="ghost" onClick={() => setTemplateId('')}>Bỏ chọn mẫu</Button>}
              {templateId && !templates.some(t => t.id === templateId) && <p className="text-sm text-muted-foreground">Mẫu đã ngừng hoạt động hoặc bị xoá. Các tài liệu nháp đã xuất vẫn tải được; chọn mẫu mới để xuất tiếp.</p>}
            </div>
          </fieldset>
          {canExport && !!current?.documents.length && <div className="space-y-2"><Label>Tài liệu đã xuất</Label>{current.documents.map(document => <Button key={document.id} type="button" variant="outline" size="sm" className="mr-2" disabled={pending} onClick={() => download.mutate(document)}><FileDown className="h-4 w-4 mr-1" />Nháp v{document.revision} · {document.template_snapshot.name}</Button>)}</div>}
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Đóng</Button>
            <Button type="submit" disabled={pending}><Save className="h-4 w-4 mr-2" />{save.isPending ? 'Đang lưu…' : 'Lưu nháp'}</Button>
            {canExport && <Button type="button" variant="secondary" disabled={pending} onClick={() => void handleSave(true)}>{exportDocument.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileDown className="h-4 w-4 mr-2" />}Lưu và xuất nháp .docx</Button>}
          </div>
        </form></Form>
      </ScrollArea>
      <CustomerSelectionDialog open={state.customerDialogOpen} onOpenChange={state.setCustomerDialogOpen} selectedCustomerIds={state.selectedCustomers.map(c => c.id)} onSelect={state.handleCustomersSelected} />
      <ServiceSelectionDialog open={state.serviceDialogOpen} onOpenChange={state.setServiceDialogOpen} selectedServiceIds={state.selectedServices.map(s => s.id)} onSelect={state.handleServicesSelected} buildingId={state.selectedBuildingId || undefined} />
    </DialogContent>
  </Dialog>;
}
