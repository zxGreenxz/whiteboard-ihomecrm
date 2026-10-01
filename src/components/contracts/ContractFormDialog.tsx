import {validateInputDrafts} from '@/lib/inputDraftValidation';
import { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { compatibleDraftDocument, type ContractDraft } from '@/lib/contractDrafts';
import { buildPreparedSigningCreation, type PreparedSigningCreation } from '@/lib/contractSigning';
import { Form } from "@/components/ui/form";
import { ScrollArea } from "@/components/ui/scroll-area";

import type { ContractWithRelations } from "@/types/contract";
import { CustomerSelectionDialog } from "./CustomerSelectionDialog";
import { ServiceSelectionDialog } from "./ServiceSelectionDialog";
import { CommissionVoucherModal } from "./CommissionVoucherModal";
import type { ContractPrefill } from "./contract-form/types";
import { useContractFormState } from "./contract-form/useContractFormState";
import { useContractSubmit } from "./contract-form/useContractSubmit";
import { GeneralSection } from "./contract-form/GeneralSection";
import { CustomersSection } from "./contract-form/CustomersSection";
import { RentDepositSection } from "./contract-form/RentDepositSection";
import { ServicesSection } from "./contract-form/ServicesSection";
import { FirstInvoicePreview } from "./contract-form/FirstInvoicePreview";
import { ContractFormFooter } from "./contract-form/ContractFormFooter";
import { useContractDraftEditor } from './contract-form/useContractDraftEditor';

const SigningDialog = lazy(() => import('./ConfirmContractSigningDialog').then(module => ({ default: module.ConfirmContractSigningDialog })));
const PrintDraftDialog = lazy(() => import('./PrintContractDraftDialog').then(module => ({ default: module.PrintContractDraftDialog })));

// Public API giữ nguyên: ContractPrefill vẫn import được từ file này.
export type { ContractPrefill } from "./contract-form/types";

interface ContractFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract?: ContractWithRelations;
  prefill?: ContractPrefill;
  /** Gọi sau khi TẠO HĐ thành công (không gọi ở edit mode). */
  onCreated?: (contractId: string) => void;
  draft?: ContractDraft;
  canExport?: boolean;
  onSaved?: (draft: ContractDraft) => void;
}

/**
 * Root component mỏng sau refactor Phase 10C: lifecycle open/close + state
 * (useContractFormState) + submit orchestration (useContractSubmit) +
 * Shared editor for new contracts, saved drafts and official contract updates.
 */
export function ContractFormDialog({
  open,
  onOpenChange,
  contract,
  prefill,
  onCreated,
  draft,
  canExport: canExportProp,
  onSaved,
}: ContractFormDialogProps) {
  const formRoot=useRef<HTMLFormElement>(null);
  const [savedDraft, setSavedDraft] = useState(draft);
  const draftSession = useRef({ open, draftId: draft?.id });
  const changedSession = draftSession.current.open !== open || draftSession.current.draftId !== draft?.id;
  // Hydration locks a draft ID on its first open render, so supply the new
  // session's input synchronously. Within that session retain local saves/prints.
  const activeDraft = changedSession ? draft : savedDraft;
  useEffect(() => {
    draftSession.current = { open, draftId: draft?.id };
    setSavedDraft(draft);
    // Reopening replaces the editor; a background refresh of the same draft does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.id]);
  const state = useContractFormState({ open, contract, prefill, draft: activeDraft });
  const editor = useContractDraftEditor({ open, draft, state, onSaved: value => {
    setSavedDraft(value); onSaved?.(value);
  } });
  const { data: permissions } = useMyPermissions();
  const canExport = (canExportProp ?? true) && canUse(permissions, 'contracts', 'print', state.selectedBuildingId || undefined);
  const canSign = canUse(permissions, 'contracts', 'create', state.selectedBuildingId || undefined);
  const canSaveDraft = !state.readonlySupportSchedule && canUse(permissions, 'contracts', editor.current ? 'edit' : 'create', state.selectedBuildingId || undefined);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [signing, setSigning] = useState<{ draft: ContractDraft; prepared?: PreparedSigningCreation }>();
  const [printBeforeSigning, setPrintBeforeSigning] = useState<{ draft: ContractDraft; prepared?: PreparedSigningCreation }>();
  useEffect(() => { if (!open) { setChoiceOpen(false); setSigning(undefined); setPrintBeforeSigning(undefined); } }, [open]);
  const pending = state.isPending || editor.pending;
  const saveDraft = async () => {
    if (!canSaveDraft || !validateInputDrafts(formRoot.current)) return;
    if (state.sourceIssues.length) return;
    setChoiceOpen(false);
    await editor.persist();
  };
  const onSubmit = useContractSubmit({
    state,
    formRoot:()=>formRoot.current,
    contract,
    onOpenChange,
    onCreated,
    onCreateRequest: editor.current ? async request => {
      if (!canSign) return;
      const current = editor.current;
      if (current && editor.matchesSavedDocument(request) && compatibleDraftDocument(current)) {
        setSigning({ draft: current, prepared: buildPreparedSigningCreation(request, state.typedDepositTotal + state.approvedOrphanTotal) });
        return;
      }
      if (!canSaveDraft || !canExport) {
        toast.error('Nội dung đã đổi hoặc chưa có tài liệu. Cần lưu và in bản nháp trước khi ký.'); return;
      }
      const saved = await editor.persist({ signingRequest: request });
      if (saved) setPrintBeforeSigning({ draft: saved, prepared: buildPreparedSigningCreation(request, state.typedDepositTotal + state.approvedOrphanTotal) });
    } : undefined,
  });
  const { form, isEditMode, onInvalid } = state;

  return (
    <>
    <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] p-0">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle>
            {isEditMode ? "Cập nhật hợp đồng" : "Tạo hợp đồng mới"}
            {editor.current && <span className="ml-2 text-sm font-normal text-muted-foreground">Nháp · phiên bản {editor.current.revision}</span>}
            {isEditMode && contract?.contract_number && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({contract.contract_number})
              </span>
            )}
          </DialogTitle>
          {!isEditMode && <DialogDescription>Nhập thông tin hợp đồng, sau đó lưu nháp hoặc xác nhận ký.</DialogDescription>}
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] px-6 pb-6">
          <Form {...form}>
            <form ref={formRoot}
              onSubmit={event => {
                if (isEditMode) { void form.handleSubmit(onSubmit, onInvalid)(event); return; }
                event.preventDefault(); setChoiceOpen(true);
              }}
              onKeyDown={(e) => {
                // Chặn Enter submit ngoài ý muốn — chỉ cho Enter trong
                // <textarea> (để xuống dòng) và button submit (click thật sự).
                if (e.key !== 'Enter') return;
                const target = e.target as HTMLElement;
                const tag = target.tagName;
                if (tag === 'TEXTAREA') return;
                if (tag === 'BUTTON' && (target as HTMLButtonElement).type === 'submit') return;
                e.preventDefault();
              }}
              className="space-y-6"
            >
              {editor.errors.length > 0 && <Alert variant="destructive"><AlertDescription><ul className="list-disc pl-4">{editor.errors.map(error => <li key={`${error.field}-${error.label}`}>{error.label}: {error.message}</li>)}</ul></AlertDescription></Alert>}
              {state.sourceIssues.length > 0 && <Alert variant="destructive" role="alert"><AlertDescription>
                <p>Chưa tải đủ nguồn hợp đồng: {state.sourceIssues.map(issue => issue.label).join(', ')}. Hãy tải lại trước khi lưu hoặc xác nhận ký.</p>
                <div className="mt-2 flex flex-wrap gap-2">{state.sourceIssues.map(issue => <Button key={issue.key} type="button" variant="outline" size="sm" onClick={issue.retry}>Tải lại {issue.label}</Button>)}</div>
              </AlertDescription></Alert>}
              {state.partialSyncIssue && <Alert variant="destructive" role="alert"><AlertDescription>{state.partialSyncIssue}</AlertDescription></Alert>}
              <fieldset disabled={pending || !!signing || !!printBeforeSigning || !!state.readonlySupportSchedule} className="space-y-6">
              {/* ===== Section 1: Thông tin chung ===== */}
              <GeneralSection {...state} buildingDisabled={!!editor.current} />

              {/* ===== Section 2: Khách hàng ===== */}
              <CustomersSection {...state} />

              {/* ===== Section 3: Tiền thuê & Tiền cọc ===== */}
              <RentDepositSection {...state} />

              {/* ===== Section 4: Tiền phí dịch vụ ===== */}
              <ServicesSection {...state} />

              {/* ===== Section 5: Xem trước hoá đơn cọc + tháng đầu ===== */}
              {!isEditMode && <FirstInvoicePreview {...state} />}
              </fieldset>

              {/* ===== Footer buttons ===== */}
              <ContractFormFooter {...state} isPending={pending} sourceBlocked={state.sourceIssues.length > 0} onOpenChange={onOpenChange} onSaveDraft={canSaveDraft ? () => void saveDraft() : undefined} />
            </form>
          </Form>
        </ScrollArea>

        {/* Sub-dialogs */}
        <CustomerSelectionDialog
          open={state.customerDialogOpen}
          onOpenChange={state.setCustomerDialogOpen}
          selectedCustomerIds={state.selectedCustomers.map((c) => c.id)}
          onSelect={state.handleCustomersSelected}
        />
        <ServiceSelectionDialog
          open={state.serviceDialogOpen}
          onOpenChange={state.setServiceDialogOpen}
          selectedServiceIds={state.selectedServices.map((s) => s.id)}
          onSelect={state.handleServicesSelected}
          buildingId={state.selectedBuildingId || undefined}
        />
      </DialogContent>
    </Dialog>

    <Dialog open={choiceOpen} onOpenChange={setChoiceOpen}>
      <DialogContent className="max-w-md"><DialogHeader><DialogTitle>Bạn muốn lưu hợp đồng thế nào?</DialogTitle>
        <DialogDescription>Lưu nháp để tiếp tục soạn hoặc gửi khách xem trước. Xác nhận ký khi đã kiểm tra và thống nhất thông tin.</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Lưu nháp chưa giữ phòng và chưa ghi nhận thu tiền.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending || !canSaveDraft || state.sourceIssues.length > 0} onClick={() => void saveDraft()}>Lưu nháp</Button>
            <Button type="button" disabled={pending || !canSign || state.sourceIssues.length > 0} onClick={() => {
              setChoiceOpen(false);
              if (state.readonlySupportSchedule && editor.current) {
                if (compatibleDraftDocument(editor.current)) setSigning({ draft: editor.current });
                else if (canExport) setPrintBeforeSigning({ draft: editor.current, prepared: undefined });
                else toast.error('Cần xuất bản nháp đúng nội dung khách trước khi ký.');
                return;
              }
              void form.handleSubmit(onSubmit, onInvalid)();
            }}>Xác nhận ký</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    {printBeforeSigning && <Suspense fallback={<p role="status">Đang mở in hợp đồng…</p>}>
      <PrintDraftDialog open draft={printBeforeSigning.draft} canEdit={canSaveDraft}
        onDraftSaved={editor.acceptPrintedDraft}
        onOpenChange={value => { if (!value) setPrintBeforeSigning(undefined); }} onPrinted={printed => {
          editor.acceptPrintedDraft(printed);
          setSigning({ draft: printed, prepared: printBeforeSigning.prepared });
          setPrintBeforeSigning(undefined);
        }} />
    </Suspense>}
    {signing && <Suspense fallback={<p role="status">Đang mở xác nhận ký…</p>}>
      <SigningDialog open draft={signing.draft} preparedCreation={signing.prepared} canSign={canSign} canPrint={canExport}
        onOpenChange={value => { if (!value) setSigning(undefined); }} onSigned={result => {
          setSigning(undefined); onOpenChange(false); onCreated?.(result.contract_id); state.setCommissionContractId(result.contract_id);
        }} />
    </Suspense>}

    {/* Modal tạo phiếu chi hoa hồng — chỉ mở sau khi tạo HĐ thành công */}
    <CommissionVoucherModal
      open={!!state.commissionContractId}
      contractId={state.commissionContractId}
      onOpenChange={(o) => {
        if (!o) state.setCommissionContractId(null);
      }}
    />

    </>
  );
}
