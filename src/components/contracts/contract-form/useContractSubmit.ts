import {validateInputDrafts} from '@/lib/inputDraftValidation';
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
  type ContractCreateRequest,
} from "@/lib/contractCreateRpc";
import { applyDepositAdjustmentNote } from "@/lib/contractPriceAdjustment";
import { contractCreateFeedback,isContractTemplateSettingError } from '@/lib/contractFeedback';
import {validateContractDepositRows,validateContractServiceRows} from '@/lib/contractRowFeedback';
import { validateFirstInvoiceRows } from '@/lib/contractInvoiceFeedback';
import { applyFeedbackToForm, focusFirstError } from '@/lib/formErrors';
import {runContractEdit,readContractEditSnapshot} from '@/lib/contractEditWorkflow';
import {workflowErrorMessage} from '@/lib/financialWorkflow';
import { supportPlanInputSchema } from '@/lib/rentSupport';
import type { ContractFormState } from "./useContractFormState";

interface UseContractSubmitParams {
  state: ContractFormState;
  formRoot?:()=>HTMLElement|null;
  contract?: ContractWithRelations;
  onOpenChange: (open: boolean) => void;
  /** Gọi sau khi TẠO HĐ thành công (không gọi ở edit mode). */
  onCreated?: (contractId: string) => void;
  /** Saved drafts use the same validation and request preparation before signing. */
  onCreateRequest?: (request: ContractCreateRequest) => void | Promise<void>;
}

export function isStaleOrphanDepositError(error: unknown) {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? "");
  const normalized = message.toLocaleLowerCase("vi");
  return normalized.includes("phiếu cọc") && (
    normalized.includes("đã xử lý bỏ cọc") || normalized.includes("đã được dùng") ||
    normalized.includes("đã gắn hợp đồng") || normalized.includes("không còn")
  );
}

export async function refreshStaleOrphanDeposits(error: unknown, refetch: () => Promise<{ error?: unknown }>) {
  if (!isStaleOrphanDepositError(error)) return "not-stale" as const;
  const result = await refetch();
  return result.error ? "failed" as const : "refreshed" as const;
}

/**
 * Submit orchestration for contract edit and atomic V2 creation.
 */
export function useContractSubmit({
  state,
  formRoot,
  contract,
  onOpenChange,
  onCreated,
  onCreateRequest,
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
    partialSyncRef,
    setPartialSyncIssue,
    typedDepositTotal,
    approvedOrphanTotal,
    orphanDepositVouchers,
    refetchOrphanDepositVouchers,
    invoiceItems,
    firstInvoiceDiscount,
    depositRows,
    setCommissionContractId,
  } = state;

  // ---- Submit handler ----
  const onSubmit = (data: ContractFormData) => {
    const root=formRoot?.()??(typeof document==='undefined'?null:document.querySelector<HTMLElement>('[data-slot="dialog-content"]'));
    if(!validateInputDrafts(root))return;
    if (state.sourceIssues?.length) {
      const labels = state.sourceIssues.map(issue => issue.label).join(', ');
      form.setError('root.server', { type: 'server', message: `Chưa tải được ${labels}. Tải lại nguồn trước khi lưu hợp đồng.` });
      toast.error('Chưa thể lưu hợp đồng', { description: `Cần tải lại ${labels} để đối chiếu dữ liệu.` });
      return;
    }
    const recoveringEdit=isEditMode&&!!partialSyncRef?.current;
    const rowErrors=recoveringEdit?{}:{...validateContractDepositRows(isEditMode?[]:depositRows??[]),
      ...validateContractServiceRows(useCustomServices?selectedServices:[])};
    if(Object.keys(rowErrors).length){
      void applyFeedbackToForm(form,{description:'Kiểm tra các lần cọc và dòng dịch vụ được đánh dấu đỏ.',fieldErrors:rowErrors},{root});
      toast.error('Chưa thể lưu hợp đồng',{description:'Kiểm tra các lần cọc và dòng dịch vụ được đánh dấu đỏ.'});
      return;
    }
    const focusField = (name: string) => {
      void focusFirstError({ [name]: 'error' }, {
        root: root,
      });
    };
    // Resident requires at least one customer (representative tenant) on a
    // contract — fail fast in the UI rather than letting Postgres throw a
    // confusing NOT NULL violation on tenant_id.
    if (selectedCustomers.length === 0 && !recoveringEdit) {
      void applyFeedbackToForm(form, { description: 'Vui lòng chọn ít nhất một khách hàng cho hợp đồng.',
        fieldErrors: { customers: 'Vui lòng chọn ít nhất một khách hàng.' } }, {
        root: root,
      });
      toast.error("Không thể lưu hợp đồng", {
        description: "Vui lòng chọn ít nhất một khách hàng cho hợp đồng.",
      });
      return;
    }

    const representativeId =
      selectedCustomers.find((customer) => customer.is_representative)?.id ??
      selectedCustomers[0]?.id;

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

    // Cọc lệch tiền thuê → chèn 1 dòng "[Điều chỉnh cọc]" vào ghi chú HĐ để
    // sau này LỌC / ĐỐI CHIẾU được. Hàm tự gỡ dòng thẻ cũ nên sửa HĐ nhiều lần
    // vẫn chỉ còn đúng 1 dòng, và cọc quay về = tiền thuê thì dòng đó biến mất.
    // (Vế còn lại của dấu vết — giá thuê vs giá phòng — do trigger DB
    //  log_contract_price_history ghi thẳng vào room_price_history.)
    const notesWithAdjustment = applyDepositAdjustmentNote(
      data.notes,
      data.rent_price,
      data.total_deposit,
    );

    if (isEditMode && contract) {
      if (data.rent_support) {
        toast.error('Lịch hỗ trợ đã ký cần điều chỉnh có phiên bản và lý do. Dùng luồng điều chỉnh lịch hỗ trợ để tiếp tục.');
        return;
      }
      // Edit mode: update contract fields
      const updates = {
        room_id: data.room_id,
        signed_date: data.signed_date,
        start_date: data.start_date,
        end_date: data.end_date,
        rent_price: data.rent_price,
        total_deposit: data.total_deposit,
        // [A3] KHÔNG gửi `deposit_paid` ở chế độ SỬA. Đây là số DẪN XUẤT từ phiếu
        // thu/chi cọc (recompute_contract_deposit_paid). Form sửa không có ô nhập
        // cho nó — giá trị ở đây chỉ là ảnh chụp lúc mở dialog, gửi lên sẽ GHI ĐÈ
        // kết quả recompute đã chạy trong lúc dialog đang mở, làm hỏng sổ cọc.
        payment_cycle: data.payment_cycle,
        start_billing_date: data.start_billing_date || null,
        end_billing_date: data.end_billing_date || null,
        contract_template_id: data.contract_template_id || null,
        invoice_template_id: data.invoice_template_id || null,
        notes: notesWithAdjustment,
        ...(state.hasPersistedRentSupport ? {} : { discounts:
          data.discount_months && data.discount_amount_per_month
            ? {
                months: data.discount_months,
                amount_per_month: data.discount_amount_per_month,
              }
            : null }),
      };

      state.setEditSubmitting?.(true);
      void runContractEdit({contractId:contract.id,updates,fieldsFingerprint:JSON.stringify(data),customers,services},{
        read:readContractEditSnapshot,
        update:input=>updateContract.mutateAsync(input),
        customers:input=>syncCustomers.mutateAsync(input),
        services:input=>syncServices.mutateAsync(input),
        onJob:job=>{partialSyncRef.current=job;setPartialSyncIssue?.(job?`Hợp đồng ${job.contractId} có yêu cầu cập nhật cần đối chiếu. Bấm “Kiểm tra và hoàn tất đồng bộ” để đọc dữ liệu hiện có trước khi tiếp tục.`:null);},
      }).then(saved=>{
        setPartialSyncIssue?.(null);form.clearErrors?.('root.server');
        if(saved.fieldsFingerprint===JSON.stringify(data)&&saved.customersFingerprint===JSON.stringify(customers)&&saved.servicesFingerprint===JSON.stringify(services)){
          toast.success('Đã cập nhật hợp đồng và đồng bộ khách hàng, dịch vụ');onOpenChange(false);
        }else toast.error('Đã đồng bộ xong; thay đổi mới trong form chưa lưu',{description:`ID hợp đồng: ${contract.id}. Bấm Cập nhật để lưu các thay đổi bạn nhập sau lần trước.`});
      }).catch(error=>{
        const message=workflowErrorMessage(error,'cập nhật hợp đồng');setPartialSyncIssue?.(partialSyncRef.current?message:null);form.setError('root.server',{type:'server',message});
        toast.error('Chưa hoàn tất cập nhật hợp đồng',{description:message});
      }).finally(()=>state.setEditSubmitting?.(false));
    } else {
      // Create mode
      if (data.rent_support && 'state' in firstInvoiceDiscount && firstInvoiceDiscount.state === 'NEEDS_REVIEW') {
        toast.error('Chưa thể tạo hóa đơn đầu', { description: firstInvoiceDiscount.notes || 'Kiểm tra kỳ hóa đơn và doanh thu đủ điều kiện của lịch hỗ trợ.' });
        return;
      }

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
        focusField('end_billing_date');
        return;
      }

      const depositPaidValue = typedDepositTotal + approvedOrphanTotal;
      const depositBalance = calculateContractDepositBalance(
        data.total_deposit || 0,
        depositPaidValue,
      );
      if (depositBalance.isOverpaid) {
        const depositField = depositRows.length ? `deposit_rows.${depositRows[depositRows.length - 1].uid}.amount` : 'total_deposit';
        form.setError(depositField as never, { type: 'manual', message: `Tiền cọc đã nhận ${formatCurrency(depositPaidValue)} vượt tiền cọc hợp đồng ${formatCurrency(data.total_deposit)}. Kiểm tra số tiền cọc được đánh dấu.` });
        focusField(depositField);
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
          focusField('deposit_debt_mode');
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
          focusField('deposit_debt_reason');
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
          focusField('deposit_topup_due_date');
          toast.error("Không thể lưu hợp đồng", {
            description: "Vui lòng chọn hạn bổ sung cọc.",
          });
          return;
        }
      }

      const discounts =
        !data.rent_support && data.discount_months && data.discount_amount_per_month
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
      const invoiceRowErrors = validateFirstInvoiceRows(firstInvoiceItems, billingPeriod);
      if (Object.keys(invoiceRowErrors).length > 0) {
        void applyFeedbackToForm(form, {
          description: 'Kiểm tra các dòng hóa đơn đầu.', fieldErrors: invoiceRowErrors,
        }, { root: root });
        toast.error('Không thể lưu hợp đồng', { description: 'Kiểm tra dòng hóa đơn đầu được đánh dấu đỏ.' });
        return;
      }
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
        const message = `Dòng tiền cọc trong hóa đơn đầu phải bằng ${formatCurrency(remaining)}. Cập nhật dòng tiền cọc theo phần còn thiếu.`;
        const fieldErrors = depositInvoiceItems.length
          ? Object.fromEntries(depositInvoiceItems.map(item=>[`invoice_items.${item.id}.unit_price`,message]))
          : {first_invoice:message};
        void applyFeedbackToForm(form, {description:message,fieldErrors},{root});
        toast.error("Chưa thể lưu hợp đồng", {description:message});
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
          notes: notesWithAdjustment,
          discounts: discounts ?? null,
          ...(data.rent_support ? { rent_support: supportPlanInputSchema.parse(data.rent_support) } : {}),
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
        deposit_receipts: depositRows.map((row) => ({
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
                ...(data.rent_support ? { manual_discount_amount: '0' } : {}),
                discount_notes:
                  discountAmount > 0 ? firstInvoiceDiscount.notes : null,
                issue_date: data.signed_date,
                due_date: billingPeriod.end_date,
                notes: invoiceNotes,
              }
            : null,
      });

      if (onCreateRequest) return onCreateRequest(request);

      createContract.mutate(
        {...request,suppressErrorToast:true},
        {
          onSuccess: (contract) => {
            onOpenChange(false);
            if (contract?.id) {
              onCreated?.(contract.id);
              setCommissionContractId(contract.id);
            }
          },
          onError: async (error) => {
            const feedback = contractCreateFeedback(error, data);
            const refreshState = await refreshStaleOrphanDeposits(error, refetchOrphanDepositVouchers);
            if (Object.keys(feedback.fieldErrors ?? {}).length > 0) {
              // Keep field messages now; focus when the submitted fieldset becomes editable.
              void applyFeedbackToForm(form, feedback, { root, waitForEnabled: true });
            }
            if (refreshState === "not-stale") {
              form.setError('root.server',{type:'server',message:feedback.description});
              toast.error(feedback.title,{description:feedback.description,...(isContractTemplateSettingError(error)?{action:{label:'Mở mẫu tài liệu',onClick:()=>window.open('/settings/templates','_blank','noopener,noreferrer')}}:{})});
              return;
            }
            toast.error("Danh sách cọc giữ chỗ đã thay đổi", {
              description: refreshState === "refreshed"
                ? "Đã tải lại cọc của phòng. Thông tin hợp đồng bạn nhập vẫn được giữ; hãy kiểm tra phần cọc rồi lưu lại."
                : "Chưa tải lại được danh sách cọc. Thông tin hợp đồng bạn nhập vẫn được giữ; hãy kiểm tra kết nối rồi thử tải lại.",
            });
          },
        },
      );
    }
  };

  return onSubmit;
}
