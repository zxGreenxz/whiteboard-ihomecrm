import { toast } from "sonner";

import type { ContractFormData } from "@/lib/contractValidation";
import type { ContractWithRelations } from "@/types/contract";
import { formatCurrency } from "@/lib/utils";
import {
  computeFirstBillingMonth,
  normalizeFirstBillingPeriod,
  validateFirstBillingPeriod,
} from "@/lib/firstInvoiceBuilder";
import {
  calculateContractDepositBalance,
  prepareContractCreateRequest,
} from "@/lib/contractCreateRpc";
import type { ContractFormState } from "./useContractFormState";

interface UseContractSubmitParams {
  state: ContractFormState;
  contract?: ContractWithRelations;
  onOpenChange: (open: boolean) => void;
  /** Gọi sau khi TẠO HĐ thành công (không gọi ở edit mode). */
  onCreated?: (contractId: string) => void;
}

/**
 * Submit orchestration for contract edit and atomic V2 creation.
 */
export function useContractSubmit({
  state,
  contract,
  onOpenChange,
  onCreated,
}: UseContractSubmitParams) {
  const {
    isEditMode,
    form,
    selectedCustomers,
    selectedServices,
    useCustomServices,
    createContract,
    updateContract,
    syncCustomers,
    syncServices,
    typedDepositTotal,
    approvedOrphanTotal,
    orphanDepositVouchers,
    invoiceItems,
    firstInvoiceDiscount,
    depositRows,
    setCommissionContractId,
  } = state;

  // ---- Submit handler ----
  const onSubmit = (data: ContractFormData) => {
    // Resident requires at least one customer (representative tenant) on a
    // contract — fail fast in the UI rather than letting Postgres throw a
    // confusing NOT NULL violation on tenant_id.
    if (selectedCustomers.length === 0) {
      toast.error("Không thể lưu hợp đồng", {
        description: "Vui lòng chọn ít nhất một khách hàng cho hợp đồng.",
      });
      try {
        const el = document.querySelector('[data-slot="dialog-content"]');
        if (el) el.scrollTop = 0;
      } catch {}
      return;
    }

    const representativeId =
      selectedCustomers.find((customer) => customer.is_representative)?.id ??
      selectedCustomers[0].id;

    const customers = selectedCustomers.map((c) => ({
      customer_id: c.id,
      is_representative: c.id === representativeId,
      notes: c.notes,
    }));

    // Chỉ lưu contract_services khi user bật "Dùng dịch vụ riêng". OFF → lưu
    // rỗng để hoá đơn fallback đơn giá toà (đúng ý: chưa cấu hình → theo toà).
    const services = (useCustomServices ? selectedServices : []).map((s) => ({
      service_id: s.id,
      unit_price: s.unit_price,
      initial_reading: s.initial_reading || undefined,
    }));

    if (isEditMode && contract) {
      // Edit mode: update contract fields
      const updates: Record<string, any> = {
        room_id: data.room_id,
        signed_date: data.signed_date,
        start_date: data.start_date,
        end_date: data.end_date,
        rent_price: data.rent_price,
        total_deposit: data.total_deposit,
        deposit_paid: data.deposit_paid ?? 0,
        payment_cycle: data.payment_cycle,
        start_billing_date: data.start_billing_date || null,
        end_billing_date: data.end_billing_date || null,
        contract_template_id: data.contract_template_id || null,
        invoice_template_id: data.invoice_template_id || null,
        notes: data.notes || null,
        discounts:
          data.discount_months && data.discount_amount_per_month
            ? {
                months: data.discount_months,
                amount_per_month: data.discount_amount_per_month,
              }
            : null,
      };

      updateContract.mutate(
        { id: contract.id, updates },
        {
          onSuccess: async () => {
            // Luồng update không tự đụng contract_customers / contract_services
            // → phải sync tay sau khi update HĐ. Đồng bộ cả khách (đại diện +
            // ghi chú) lẫn dịch vụ (đổi loại điện, đơn giá, chỉ số đầu). Chỉ
            // đóng dialog khi cả hai thành công; lỗi sẽ giữ dialog mở + toast.
            try {
              await Promise.all([
                syncCustomers.mutateAsync({ contractId: contract.id, customers }),
                syncServices.mutateAsync({ contractId: contract.id, services }),
              ]);
              onOpenChange(false);
            } catch (e) {
              console.error("Sync khách hàng/dịch vụ HĐ thất bại:", e);
              toast.error("Đã cập nhật HĐ nhưng đồng bộ khách hàng/dịch vụ thất bại", {
                description: "Vui lòng thử lại.",
              });
            }
          },
        }
      );
    } else {
      // Create mode

      const billingPeriod = normalizeFirstBillingPeriod(
        data.start_billing_date,
        data.end_billing_date,
        data.start_date,
      );
      const billCheck = validateFirstBillingPeriod(
        billingPeriod.start_date,
        billingPeriod.end_date,
      );
      if (!billCheck.ok) {
        form.setError("end_billing_date", {
          type: "manual",
          message: billCheck.message,
        });
        toast.error("Không thể lưu hợp đồng", { description: billCheck.message });
        try {
          const el = document.querySelector('[data-slot="dialog-content"]');
          if (el) el.scrollTop = 0;
        } catch {}
        return;
      }

      const depositPaidValue = typedDepositTotal + approvedOrphanTotal;
      const depositBalance = calculateContractDepositBalance(
        data.total_deposit || 0,
        depositPaidValue,
      );
      if (depositBalance.isOverpaid) {
        toast.error("Không thể lưu hợp đồng", {
          description: `Tổng tiền cọc đã nhận đang vượt ${formatCurrency(depositBalance.overpayment)} so với tiền cọc của hợp đồng.`,
        });
        return;
      }
      const remaining = depositBalance.shortfall;
      const hasDepositShortfall = depositBalance.requiresResolution;
      const effectiveDebtMode = hasDepositShortfall
        ? data.deposit_debt_mode ?? null
        : null;

      if (hasDepositShortfall) {
        if (!data.deposit_debt_mode) {
          form.setError("deposit_debt_mode", {
            type: "manual",
            message:
              "Khách chưa đóng đủ cọc — chọn cách xử lý (Nợ cọc / Đóng đủ ngay).",
          });
          toast.error("Không thể lưu hợp đồng", {
            description: `Khách còn thiếu ${formatCurrency(remaining)} tiền cọc. Chọn "Nợ cọc" hoặc "Đóng đủ ngay" (thêm dòng cọc) để tiếp tục.`,
          });
          return;
        }
        if (data.deposit_debt_mode === "DEBT" && !data.deposit_debt_reason?.trim()) {
          form.setError("deposit_debt_reason", {
            type: "manual",
            message: "Nhập lý do cho nợ cọc.",
          });
          toast.error("Không thể lưu hợp đồng", {
            description: "Vui lòng nhập lý do cho nợ cọc.",
          });
          return;
        }
        if (data.deposit_debt_mode === "DEBT" && !data.deposit_topup_due_date) {
          form.setError("deposit_topup_due_date", {
            type: "manual",
            message: "Chọn hạn bổ sung cọc.",
          });
          toast.error("Không thể lưu hợp đồng", {
            description: "Vui lòng chọn hạn bổ sung cọc.",
          });
          return;
        }
      }

      const discounts =
        data.discount_months && data.discount_amount_per_month
          ? {
              months: data.discount_months,
              amount_per_month: data.discount_amount_per_month,
            }
          : undefined;

      const firstInvoiceItems = invoiceItems.filter(
        (item) =>
          item.accounting_class !== "DEPOSIT" ||
          effectiveDebtMode === "FIRST_INVOICE",
      );
      const depositInvoiceItems = firstInvoiceItems.filter(
        (item) => item.accounting_class === "DEPOSIT",
      );
      if (
        effectiveDebtMode === "FIRST_INVOICE" &&
        (depositInvoiceItems.length !== 1 ||
          depositInvoiceItems[0].type !== "OTHER" ||
          Math.abs(
            depositInvoiceItems[0].unit_price * depositInvoiceItems[0].quantity -
              remaining,
          ) >= 0.01)
      ) {
        toast.error("Không thể lưu hợp đồng", {
          description: "Dòng tiền cọc trong hoá đơn đầu không còn khớp phần cọc thiếu.",
        });
        return;
      }

      const revenueSubtotal = firstInvoiceItems
        .filter((item) => item.accounting_class === "REVENUE")
        .reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
      const discountAmount = Math.min(
        firstInvoiceDiscount.amount,
        Math.max(0, revenueSubtotal),
      );
      const billingMonth = computeFirstBillingMonth(
        billingPeriod.start_date,
        billingPeriod.end_date,
      );
      const [billingYear, billingMonthNumber] = billingMonth.split("-");
      const billingLabel = billingMonthNumber
        ? `T${Number(billingMonthNumber)}/${billingYear}`
        : billingMonth;
      const depositBundled = depositInvoiceItems.reduce(
        (sum, item) => sum + item.unit_price * item.quantity,
        0,
      );
      const invoiceNotes =
        depositBundled > 0
          ? `Hoá đơn tiền phòng đầu tiên ${billingLabel} + kèm cọc ${depositBundled.toLocaleString("vi-VN")}đ (tự động)`
          : `Hoá đơn tiền phòng đầu tiên ${billingLabel} (tự động)`;

      const request = prepareContractCreateRequest({
        contract: {
          room_id: data.room_id,
          signed_date: data.signed_date,
          start_date: data.start_date,
          end_date: data.end_date,
          rent_price: data.rent_price,
          total_deposit: data.total_deposit,
          payment_cycle: data.payment_cycle,
          start_billing_date: billingPeriod.start_date,
          end_billing_date: billingPeriod.end_date,
          contract_template_id: data.contract_template_id || null,
          invoice_template_id: data.invoice_template_id || null,
          notes: data.notes || null,
          discounts: discounts ?? null,
          deposit_debt_mode: effectiveDebtMode,
          deposit_debt_reason:
            effectiveDebtMode === "DEBT"
              ? data.deposit_debt_reason?.trim() || null
              : null,
          deposit_topup_due_date:
            effectiveDebtMode === "DEBT"
              ? data.deposit_topup_due_date || null
              : null,
        },
        customers,
        services,
        deposit_receipts: depositRows
          .filter((row) => (Number(row.amount) || 0) > 0)
          .map((row) => ({
            amount: Number(row.amount),
            account_id: row.account_id || null,
            received_date: row.received_date || data.signed_date,
            attachments: [...row.images],
          })),
        existing_deposit_voucher_ids: orphanDepositVouchers
          .filter((voucher) => voucher.approval_status === "APPROVED")
          .map((voucher) => voucher.id),
        first_invoice:
          firstInvoiceItems.length > 0
            ? {
                items: firstInvoiceItems.map((item) => ({
                  type: item.type,
                  accounting_class: item.accounting_class,
                  description: item.description,
                  unit_price: item.unit_price,
                  quantity: item.quantity,
                  service_id: item.service_id ?? null,
                  from_date: item.from_date ?? null,
                  to_date: item.to_date ?? null,
                })),
                discount_amount: discountAmount,
                discount_notes:
                  discountAmount > 0 ? firstInvoiceDiscount.notes : null,
                issue_date: data.signed_date,
                due_date: billingPeriod.end_date,
                notes: invoiceNotes,
              }
            : null,
      });

      createContract.mutate(
        request,
        {
          onSuccess: (contract) => {
            onOpenChange(false);
            if (contract?.id) {
              onCreated?.(contract.id);
              setCommissionContractId(contract.id);
            }
          },
        },
      );
    }
  };

  return onSubmit;
}
