import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Printer } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useContract } from '@/hooks/useContracts';
import { useDocumentTemplatesByType, type DocumentTemplate } from '@/hooks/useDocumentTemplates';
import { useDownloadContractDraftDocument, useExportContractDraft, useSaveContractDraft } from '@/hooks/useContractDrafts';
import { draftErrorMessage, type ContractDraft } from '@/lib/contractDrafts';
import { ContractTemplatePicker, type ContractTemplateOption } from './ContractTemplatePicker';
import { PrintContractDialog } from './PrintContractDialog';

export interface PrintContractDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: ContractDraft;
  canEdit: boolean;
  onDraftSaved?: (draft: ContractDraft) => void;
  onPrinted?: (draft: ContractDraft) => void;
}

function SignedDraftPrint({ open, onOpenChange, draft }: Pick<PrintContractDraftDialogProps, 'open' | 'onOpenChange' | 'draft'>) {
  const { selectedOrganizationId } = useOrganization();
  const id = open && selectedOrganizationId === draft.organization_id ? draft.converted_contract_id ?? undefined : undefined;
  const contract = useContract(id);
  if (!id || contract.isError || (!contract.isPending && !contract.data)) return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg"><DialogHeader><DialogTitle>In hợp đồng</DialogTitle>
      <DialogDescription>Không thể mở hợp đồng chính thức để in.</DialogDescription></DialogHeader>
      <p role="alert" className="text-sm text-destructive">Không thể tải hợp đồng đã ký từ bản nháp này.</p>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
  if (contract.isPending) return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg"><DialogHeader><DialogTitle>In hợp đồng</DialogTitle>
      <DialogDescription>Đang tải dữ liệu hợp đồng chính thức.</DialogDescription></DialogHeader>
      <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Đang tải hợp đồng đã ký…</p>
    </DialogContent>
  </Dialog>;
  return <PrintContractDialog open={open} onOpenChange={onOpenChange} contract={contract.data} />;
}

/** A saved draft uses the same print picker as an official contract. */
export function PrintContractDraftDialog({ open, onOpenChange, draft, canEdit, onDraftSaved, onPrinted }: PrintContractDraftDialogProps) {
  const { selectedOrganizationId } = useOrganization();
  const templatesQuery = useDocumentTemplatesByType('lease_contract', { enabled: open && draft.status !== 'SIGNED' });
  const save = useSaveContractDraft();
  const exportDocument = useExportContractDraft();
  const download = useDownloadContractDraftDocument();
  const [current, setCurrent] = useState(draft);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const intent = useRef<{ key: string; requestId: string } | null>(null);
  const activeTemplates = useMemo(() => (templatesQuery.data ?? []).filter(template =>
    template.is_active && template.organization_id === draft.organization_id), [templatesQuery.data, draft.organization_id]);
  const currentDocument = current.documents.find(document => document.revision === current.revision);
  const options = useMemo<ContractTemplateOption[]>(() => {
    const choices: ContractTemplateOption[] = [...activeTemplates];
    // An old template can no longer issue a new draft document, but its
    // already exported bytes remain downloadable through the same picker.
    if (currentDocument && current.template_id && !choices.some(template => template.id === current.template_id)) {
      const old = (templatesQuery.data ?? []).find(template => template.id === current.template_id
        && template.organization_id === draft.organization_id);
      choices.unshift(old ?? { id: current.template_id, name: currentDocument.template_snapshot.name,
        file_name: 'Bản đã xuất', is_default: false, is_active: false });
    }
    return choices;
  }, [activeTemplates, currentDocument, current.template_id, templatesQuery.data, draft.organization_id]);
  useEffect(() => {
    if (!open) return;
    setCurrent(draft); setSelectedId(''); setError(''); intent.current = null;
    // A background list refresh must not replace a just-saved/exported revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft.id]);
  useEffect(() => {
    if (!open || !options.length) return;
    setSelectedId(previous => previous && options.some(option => option.id === previous) ? previous
      : options.find(option => option.id === current.template_id)?.id
        ?? options.find(option => option.is_default)?.id ?? options[0].id);
  }, [open, options, current.template_id]);

  if (draft.status === 'SIGNED') return <SignedDraftPrint open={open} onOpenChange={onOpenChange} draft={draft} />;

  const sameDocument = !!currentDocument && selectedId === current.template_id
    && currentDocument.template_snapshot.id === selectedId;
  const selected = activeTemplates.find(template => template.id === selectedId) as DocumentTemplate | undefined;
  const orgReady = !!selectedOrganizationId && selectedOrganizationId === draft.organization_id;
  const canDownload = orgReady && !!selectedId && (sameDocument || (canEdit && !!selected));
  const pending = busy || save.isPending || exportDocument.isPending || download.isPending;
  const handlePrint = async () => {
    if (!canDownload || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (sameDocument && currentDocument) {
        await download.mutateAsync(currentDocument);
        onOpenChange(false); onPrinted?.(current);
        return;
      }
      if (!selected || !canEdit) return;
      let printable = current;
      if (selected.id !== current.template_id) {
        const key = JSON.stringify([current.id, current.revision, selected.id]);
        if (intent.current?.key !== key) intent.current = { key, requestId: crypto.randomUUID() };
        printable = await save.mutateAsync({ organizationId: current.organization_id, buildingId: current.building_id,
          payload: current.payload, templateId: selected.id, draftId: current.id,
          expectedRevision: current.revision, requestId: intent.current.requestId });
        setCurrent(printable);
        onDraftSaved?.(printable);
      }
      const result = await exportDocument.mutateAsync({ draft: printable, template: selected });
      const printed = { ...printable, documents: [result.document, ...printable.documents.filter(item => item.id !== result.document.id)] };
      setCurrent(printed);
      onOpenChange(false); onPrinted?.(printed);
    } catch (cause) {
      setError(draftErrorMessage(cause));
    } finally { inFlight.current = false; setBusy(false); }
  };

  return <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value); }}>
    <DialogContent className="max-w-lg">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><Printer className="h-5 w-5 text-green-600" />In hợp đồng</DialogTitle>
        <DialogDescription>Chọn mẫu để tải tài liệu của phiên bản nháp hiện tại.</DialogDescription></DialogHeader>
      <div className="space-y-3">
        <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
          <div className="font-medium">Bản nháp · phiên bản {current.revision}</div>
          <div className="text-xs text-muted-foreground">{current.payload.customers.find(customer => customer.is_representative)?.full_name || 'Chưa chọn khách đại diện'}</div>
        </div>
        <ContractTemplatePicker templates={options} selectedId={selectedId} onSelect={setSelectedId}
          isLoading={templatesQuery.isLoading} isError={templatesQuery.isError} idPrefix="draft-tpl" />
        {!orgReady && <p role="alert" className="text-sm text-destructive">Tổ chức đang chọn đã đổi. Mở lại bản nháp để in.</p>}
        {orgReady && selectedId && !sameDocument && !canEdit && <p role="alert" className="text-sm text-destructive">Cần quyền sửa nháp để lưu mẫu và xuất phiên bản mới.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Hủy</Button>
        <Button className="bg-green-600 hover:bg-green-700" disabled={!canDownload || pending} onClick={() => void handlePrint()}>
          {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Tải xuống .docx
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
