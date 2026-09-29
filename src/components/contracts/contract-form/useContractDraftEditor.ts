import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useDocumentTemplatesByType } from '@/hooks/useDocumentTemplates';
import { useSaveContractDraft, useExportContractDraft, useDownloadContractDraftDocument } from '@/hooks/useContractDrafts';
import { draftErrorMessage, emptyDraftOwner, validateDraftForExport, type ContractDraft, type ContractDraftPayload, type DraftFieldError } from '@/lib/contractDrafts';
import type { ContractCreateRequest } from '@/lib/contractCreateRpc';
import { applyDepositAdjustmentNote } from '@/lib/contractPriceAdjustment';
import type { ContractFormState } from './useContractFormState';

export function useContractDraftEditor({ open, draft, state, onSaved }: {
  open: boolean; draft?: ContractDraft; state: ContractFormState; onSaved?: (draft: ContractDraft) => void;
}) {
  const { selectedOrganizationId } = useOrganization();
  const save = useSaveContractDraft();
  const exportDocument = useExportContractDraft();
  const download = useDownloadContractDraftDocument();
  const templatesQuery = useDocumentTemplatesByType('lease_contract', { enabled: open && !state.isEditMode });
  const templates = (templatesQuery.data ?? []).filter(t => t.is_active && t.organization_id === selectedOrganizationId);
  const [current, setCurrent] = useState<ContractDraft | undefined>(draft);
  const [owner, setOwner] = useState(draft?.payload.owner ?? emptyDraftOwner());
  const [errors, setErrors] = useState<DraftFieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const identity = useRef('');
  const intent = useRef<{ key: string; requestId: string } | null>(null);
  const inFlight = useRef(false);
  const templateId = state.form.watch('contract_template_id') ?? '';
  useEffect(() => {
    if (!open) return;
    setCurrent(draft); setOwner(draft?.payload.owner ?? emptyDraftOwner()); setErrors([]);
    identity.current = draft?.id ?? crypto.randomUUID(); intent.current = null;
    // Only an explicit reopen/new identity replaces local edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.id]);

  const getPayload = (signingRequest?: ContractCreateRequest) => {
    const payload = state.getDraftPayload(owner);
    payload.form.notes = applyDepositAdjustmentNote(payload.form.notes, payload.form.rent_price, payload.form.total_deposit) ?? '';
    if (signingRequest) {
      const contract = signingRequest.payload.contract;
      payload.form.start_billing_date = contract.start_billing_date ?? '';
      payload.form.end_billing_date = contract.end_billing_date ?? '';
      payload.form.notes = contract.notes ?? '';
    }
    return payload;
  };

  const persist = async ({ exportAfter = false, signingRequest }: {
    exportAfter?: boolean; signingRequest?: ContractCreateRequest;
  } = {}): Promise<ContractDraft | undefined> => {
    if (inFlight.current) return;
    if (!selectedOrganizationId || !state.selectedBuildingId) {
      setErrors([{ field: 'building', label: 'Toà nhà', message: 'Chọn toà nhà để lưu bản nháp' }]); return;
    }
    if (templateId && (templatesQuery.isLoading || templatesQuery.isError)) {
      setErrors([{ field: 'template', label: 'Mẫu hợp đồng', message: 'Tải lại mẫu đã chọn hoặc bỏ chọn mẫu để chỉ lưu nháp.' }]); return;
    }
    let payload: ContractDraftPayload;
    try { payload = getPayload(signingRequest); }
    catch (error) {
      setErrors([{ field: 'payload', label: 'Nội dung', message: draftErrorMessage(error) }]); return;
    }
    const selected = templates.find(t => t.id === templateId);
    const validation = exportAfter || signingRequest ? validateDraftForExport(payload) : [];
    if ((exportAfter || signingRequest) && !selected) validation.push({ field: 'template', label: 'Mẫu hợp đồng', message: 'Chọn mẫu đang hoạt động để xuất tài liệu trước khi ký' });
    setErrors(validation);
    if (validation.length) return;
    inFlight.current = true; setBusy(true);
    try {
      const selectedId = selected?.id ?? null;
      const key = JSON.stringify({ payload, templateId: selectedId, revision: current?.revision ?? null, buildingId: state.selectedBuildingId });
      if (intent.current?.key !== key) intent.current = { key, requestId: crypto.randomUUID() };
      const unchanged = current && JSON.stringify(current.payload) === JSON.stringify(payload) && current.template_id === selectedId;
      let saved = unchanged ? current : await save.mutateAsync({ organizationId: selectedOrganizationId,
        buildingId: state.selectedBuildingId, payload, templateId: selectedId, draftId: identity.current,
        expectedRevision: current?.revision, requestId: intent.current.requestId });
      setCurrent(saved); onSaved?.(saved);
      const hasDocument = saved.documents.some(document => document.revision === saved.revision);
      if (selected && (exportAfter || (signingRequest && !hasDocument))) {
        const result = await exportDocument.mutateAsync({ draft: saved, template: selected });
        saved = { ...saved, documents: [result.document, ...saved.documents.filter(d => d.id !== result.document.id)] };
        setCurrent(saved);
      } else if (!signingRequest) toast.success(`Đã lưu bản nháp · phiên bản ${saved.revision}`);
      return saved;
    } catch (error) {
      setErrors([{ field: 'operation', label: 'Bản nháp', message: draftErrorMessage(error) }]);
      return undefined;
    } finally { inFlight.current = false; setBusy(false); }
  };
  return { current, owner, setOwner, errors, templates, templatesQuery, templateId,
    matchesSavedDocument: (request?: ContractCreateRequest) => {
      if (!current || current.template_id !== (templateId || null)) return false;
      try {
        const payload = getPayload(request);
        // Receipt/invoice inputs are recorded in signing options; document terms must match.
        const terms = ({ editor_state: _editor, ...rest }: typeof payload) => rest;
        return JSON.stringify(terms(payload)) === JSON.stringify(terms(current.payload));
      } catch { return false; } // Invalid editor input must take the validating save path.
    },
    setTemplateId: (value: string) => state.form.setValue('contract_template_id', value || null),
    persist, download, pending: busy || save.isPending || exportDocument.isPending || download.isPending };
}
