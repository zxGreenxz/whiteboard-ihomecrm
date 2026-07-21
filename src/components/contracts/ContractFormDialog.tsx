import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

// Public API giữ nguyên: ContractPrefill vẫn import được từ file này.
export type { ContractPrefill } from "./contract-form/types";

interface ContractFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract?: ContractWithRelations;
  prefill?: ContractPrefill;
  /** Gọi sau khi TẠO HĐ thành công (không gọi ở edit mode). */
  onCreated?: (contractId: string) => void;
}

/**
 * Root component mỏng sau refactor Phase 10C: lifecycle open/close + state
 * (useContractFormState) + submit orchestration (useContractSubmit) +
 * composition các section trong ./contract-form/. Hành vi giữ NGUYÊN 100%.
 */
export function ContractFormDialog({
  open,
  onOpenChange,
  contract,
  prefill,
  onCreated,
}: ContractFormDialogProps) {
  const state = useContractFormState({ open, contract, prefill });
  const onSubmit = useContractSubmit({
    state,
    contract,
    onOpenChange,
    onCreated,
  });
  const { form, isEditMode, onInvalid } = state;

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] p-0">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle>
            {isEditMode ? "Cập nhật hợp đồng" : "Tạo hợp đồng mới"}
            {isEditMode && contract?.contract_number && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({contract.contract_number})
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] px-6 pb-6">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit, onInvalid)}
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
              {/* ===== Section 1: Thông tin chung ===== */}
              <GeneralSection {...state} />

              {/* ===== Section 2: Khách hàng ===== */}
              <CustomersSection {...state} />

              {/* ===== Section 3: Tiền thuê & Tiền cọc ===== */}
              <RentDepositSection {...state} />

              {/* ===== Section 4: Tiền phí dịch vụ ===== */}
              <ServicesSection {...state} />

              {/* ===== Section 5: Xem trước hoá đơn cọc + tháng đầu ===== */}
              {!isEditMode && <FirstInvoicePreview {...state} />}

              {/* ===== Footer buttons ===== */}
              <ContractFormFooter {...state} onOpenChange={onOpenChange} />
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
