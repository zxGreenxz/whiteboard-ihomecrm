import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useDocumentTemplatesByType } from '@/hooks/useDocumentTemplates';
import { useSaveContractDraft } from '@/hooks/useContractDrafts';
import { draftErrorMessage, emptyDraftOwner, validateDraftForExport, type ContractDraft, type ContractDraftPayload, type DraftFieldError } from '@/lib/contractDrafts';
import type { ContractCreateRequest } from '@/lib/contractCreateRpc';
import { applyDepositAdjustmentNote } from '@/lib/contractPriceAdjustment';
import type { ContractFormState } from './useContractFormState';

export function useContractDraftEditor({ open, draft, state, onSaved }: {
  open: boolean; draft?: ContractDraft; state: ContractFormState; onSaved?: (draft: ContractDraft) => void;
}) {
  const { selectedOrganizationId } = useOrganization();
  const save = useSaveContractDraft();
  const [current, setCurrent] = useState<ContractDraft | undefined>(draft);
  const templatesQuery = useDocumentTemplatesByType('lease_contract', { enabled: open && !!current?.template_id });
  const templates = (templatesQuery.data ?? []).filter(t => t.is_active && t.organization_id === selectedOrganizationId);
  const [errors, setErrors] = useState<DraftFieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const identity = useRef('');
  const intent = useRef<{ key: string; requestId: string } | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!open) return;
    setCurrent(draft); setErrors([]);
    identity.current = draft?.id ?? crypto.randomUUID(); intent.current = null;
    // Only an explicit reopen/new identity replaces local edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.id]);

  const getPayload = (signingRequest?: ContractCreateRequest) => {
    // Retain existing snapshot data without adding owner inputs to the contract editor.
    const payload = state.getDraftPayload(current?.payload.owner ?? draft?.payload.owner ?? emptyDraftOwner());
    payload.form.notes = applyDepositAdjustmentNote(payload.form.notes, payload.form.rent_price, payload.form.total_deposit) ?? '';
    if (signingRequest) {
      const contract = signingRequest.payload.contract;
      payload.form.start_billing_date = contract.start_billing_date ?? '';
      payload.form.end_billing_date = contract.end_billing_date ?? '';
      payload.form.notes = contract.notes ?? '';
    }
    return payload;
  };

  const persist = async ({ signingRequest }: {
    signingRequest?: ContractCreateRequest;
  } = {}): Promise<ContractDraft | undefined> => {
    if (inFlight.current) return;
    if (!selectedOrganizationId || !state.selectedBuildingId) {
      setErrors([{ field: 'building', label: 'Toà nhà', message: 'Chọn toà nhà để lưu bản nháp' }]); return;
    }
    let payload: ContractDraftPayload;
    try { payload = getPayload(signingRequest); }
    catch (error) {
      setErrors([{ field: 'payload', label: 'Nội dung', message: draftErrorMessage(error) }]); return;
    }
    const validation = signingRequest ? validateDraftForExport(payload) : [];
    setErrors(validation);
    if (validation.length) return;
    inFlight.current = true; setBusy(true);
    try {
      const unchanged = current && JSON.stringify(current.payload) === JSON.stringify(payload);
      // Printing owns template selection. Content edits remain saveable even if
      // the old template is unavailable; the print dialog can choose another.
      const templatesKnown = !templatesQuery.isLoading && !templatesQuery.isError && templatesQuery.data !== undefined;
      const selectedId = templatesKnown ? templates.find(t => t.id === current?.template_id)?.id ?? null : current?.template_id ?? null;
      const key = JSON.stringify({ payload, templateId: selectedId, revision: current?.revision ?? null, buildingId: state.selectedBuildingId });
      if (intent.current?.key !== key) intent.current = { key, requestId: crypto.randomUUID() };
      const saved = unchanged ? current : await save.mutateAsync({ organizationId: selectedOrganizationId,
        buildingId: state.selectedBuildingId, payload, templateId: selectedId, draftId: identity.current,
        expectedRevision: current?.revision, requestId: intent.current.requestId });
      setCurrent(saved); onSaved?.(saved);
      if (!signingRequest) toast.success(`Đã lưu bản nháp · phiên bản ${saved.revision}`);
      return saved;
    } catch (error) {
      setErrors([{ field: 'operation', label: 'Bản nháp', message: draftErrorMessage(error) }]);
      return undefined;
    } finally { inFlight.current = false; setBusy(false); }
  };
  return { current, errors,
    acceptPrintedDraft: (value: ContractDraft) => {
      setCurrent(value); state.form.setValue('contract_template_id', value.template_id); onSaved?.(value);
    },
    matchesSavedDocument: (request?: ContractCreateRequest) => {
      if (!current) return false;
      try {
        const payload = getPayload(request);
        // Receipt/invoice inputs are recorded in signing options; document terms must match.
        const terms = ({ editor_state: _editor, ...rest }: typeof payload) => rest;
        return JSON.stringify(terms(payload)) === JSON.stringify(terms(current.payload));
      } catch { return false; } // Invalid editor input must take the validating save path.
    },
    persist, pending: busy || save.isPending };
}
