import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import type { ContractFormData } from "@/lib/contractValidation";
import { PREVIOUS_DEBT_ROUND_THRESHOLD } from "@/lib/invoiceHelpers";
import type { ContractWithRelations } from "@/types/contract";
import { formatCurrency } from "@/lib/utils";
import { validateFirstBillingPeriod } from "@/lib/firstInvoiceBuilder";
import { supabase } from "@/integrations/supabase/client";
import type { ContractPrefill } from "./types";
import type { ContractFormState } from "./useContractFormState";

interface UseContractSubmitParams {
  state: ContractFormState;
  contract?: ContractWithRelations;
  prefill?: ContractPrefill;
  onOpenChange: (open: boolean) => void;
  /** Gọi sau khi TẠO HĐ thành công (không gọi ở edit mode). */
  onCreated?: (contractId: string) => void;
}

/**
 * Submit orchestration của form HĐ — tách CƠ HỌC từ ContractFormDialog
 * (onSubmit giữ NGUYÊN VĂN: thứ tự validation → mutation → phiếu thu cọc →
 * flip giữ chỗ → đóng dialog → modal hoa hồng KHÔNG đổi).
 */
export function useContractSubmit({
  state,
  contract,
  prefill,
  onOpenChange,
  onCreated,
}: UseContractSubmitParams) {
  const queryClient = useQueryClient();
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
    invoiceItems,
    firstInvoiceDiscount,
    buildings,
    rooms,
    selectedBuildingId,
    selectedRoomId,
    depositRows,
    depositIncomeType,
    createDepositVoucher,
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

    // Make sure exactly one customer is flagged as representative; if none,
    // promote the first.
    const hasRep = selectedCustomers.some((c) => c.is_representative);
    if (!hasRep) {
      selectedCustomers[0].is_representative = true;
    }

    const customers = selectedCustomers.map((c) => ({
      customer_id: c.id,
      is_representative: c.is_representative,
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

      // Kỳ HĐ đầu phải tính đủ đến hết tháng của ngày bắt đầu tính tiền (vd
      // 20/5–30/5 → lỗi vì tháng 5 chưa đủ tới 31/5). Chặn trước khi tạo HĐ.
      const billCheck = validateFirstBillingPeriod(
        data.start_billing_date || data.start_date,
        data.end_billing_date,
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

      // Cọc đã đặt = tổng dòng user nhập + phiếu cọc cũ ĐÃ DUYỆT (khớp recompute
      // DB). Cọc thiếu KHÔNG còn vào hoá đơn; theo dõi ở mục cọc của HĐ.
      const depositPaidValue = typedDepositTotal + approvedOrphanTotal;
      const remaining = (data.total_deposit || 0) - depositPaidValue;
      if (remaining >= PREVIOUS_DEBT_ROUND_THRESHOLD) {
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
      }

      const discounts =
        data.discount_months && data.discount_amount_per_month
          ? {
              months: data.discount_months,
              amount_per_month: data.discount_amount_per_month,
            }
          : undefined;

      createContract.mutate(
        {
          contract: {
            room_id: data.room_id,
            signed_date: data.signed_date,
            start_date: data.start_date,
            end_date: data.end_date,
            rent_price: data.rent_price,
            total_deposit: data.total_deposit,
            // = tổng dòng cọc + phiếu cọc cũ ĐÃ DUYỆT; trigger DB sẽ recompute
            // lại = Σ phiếu cọc APPROVED sau khi onSuccess tạo phiếu từng dòng.
            deposit_paid: depositPaidValue,
            payment_cycle: data.payment_cycle,
            start_billing_date: data.start_billing_date || undefined,
            end_billing_date: data.end_billing_date || undefined,
            contract_template_id: data.contract_template_id || undefined,
            invoice_template_id: data.invoice_template_id || undefined,
            notes: data.notes || undefined,
            discounts,
            // Xử lý thiếu cọc — chỉ ý nghĩa khi còn thiếu cọc; ngược lại null.
            // mode DEBT giữ lý do + hẹn ngày để nhắc; FIRST_INVOICE bỏ qua.
            deposit_debt_acknowledged: !!data.deposit_debt_mode,
            deposit_debt_mode: data.deposit_debt_mode ?? null,
            deposit_debt_reason:
              data.deposit_debt_mode === "DEBT"
                ? data.deposit_debt_reason?.trim() || null
                : null,
            deposit_topup_due_date:
              data.deposit_debt_mode === "DEBT"
                ? data.deposit_topup_due_date || null
                : null,
          },
          customers,
          services,
          // Items hoá đơn cọc + tháng đầu — đã được user xem trước/chỉnh
          // trong section preview, gửi xuống đúng những gì user thấy.
          invoiceItems: invoiceItems.map((it) => ({
            type: it.type,
            description: it.description,
            unit_price: it.unit_price,
            quantity: it.quantity,
            service_id: it.service_id ?? null,
            from_date: it.from_date ?? null,
            to_date: it.to_date ?? null,
          })),
          firstInvoiceDiscount:
            firstInvoiceDiscount.amount > 0
              ? {
                  amount: firstInvoiceDiscount.amount,
                  notes: firstInvoiceDiscount.notes,
                }
              : undefined,
        },
        {
          onSuccess: async (contract) => {
            // Tạo phiếu thu cọc theo TỪNG DÒNG "Đã đặt cọc" → ghi vào SỔ QUỸ
            // THẬT user chọn (hạng mục "Tiền cọc" is_deposit → tự loại khỏi
            // KQKD). KHÔNG tạo cho phiếu cọc cũ (orphan) — trigger đã tự gắn
            // vào HĐ và tính deposit_paid (tránh double-count).
            const building = (buildings as any[])?.find(
              (b) => b.id === selectedBuildingId,
            );
            const buildingName: string = building?.name ?? "";
            const room = (rooms as any[])?.find((r) => r.id === selectedRoomId);
            const roomName = room?.name ?? "";
            const voucherName =
              roomName && buildingName
                ? `Cọc giữ phòng ${roomName} Toà nhà ${buildingName}`
                : roomName
                  ? `Cọc giữ phòng ${roomName}`
                  : "Cọc giữ phòng";
            const today = new Date().toISOString().split("T")[0];
            const rowsToCreate = depositRows.filter(
              (r) => (Number(r.amount) || 0) > 0,
            );

            if (rowsToCreate.length > 0 && !depositIncomeType) {
              toast.error(
                'HĐ đã lưu nhưng chưa tạo phiếu thu cọc: thiếu loại thu "Tiền cọc".',
                {
                  duration: 15000,
                  description: `Tạo loại thu "Tiền cọc" trong Cài đặt rồi tạo phiếu thu cọc gắn phòng ${roomName}.`,
                },
              );
            } else if (rowsToCreate.length > 0 && selectedBuildingId) {
              for (const r of rowsToCreate) {
                // Fallback sổ CỌC ảo nếu dòng chưa chọn sổ (account_id NOT NULL).
                let accId: string | null = r.account_id || null;
                if (!accId) {
                  const { data: depAcc } = await (supabase as any).rpc(
                    "get_or_create_deposit_account",
                  );
                  accId = (depAcc as string) ?? null;
                }
                if (!accId) {
                  toast.error(
                    `HĐ đã lưu nhưng 1 dòng cọc ${formatCurrency(r.amount)} chưa có sổ quỹ`,
                    {
                      duration: 15000,
                      description: `Vào Thu chi tạo phiếu thu "Tiền cọc" cho phòng ${roomName}.`,
                    },
                  );
                  continue;
                }
                const vDate = r.received_date || data.signed_date || today;
                try {
                  await createDepositVoucher.mutateAsync({
                    type: "INCOME",
                    name: voucherName,
                    building_id: selectedBuildingId,
                    room_id: selectedRoomId || null,
                    tenant_id: null,
                    contract_id: contract?.id ?? null,
                    payer_name: null,
                    account_id: accId,
                    voucher_date: vDate,
                    // null = tự động; hạng mục "Tiền cọc" (is_deposit) tự loại
                    // khoản này khỏi báo cáo Lợi nhuận.
                    business_result_accounting: null,
                    repeat_cycle: "NONE",
                    repeat_infinity: false,
                    repeat_count: 0,
                    attachments: r.images,
                    items: [
                      {
                        income_expense_type_id: depositIncomeType.id,
                        description: null,
                        quantity: 1,
                        unit_price: r.amount,
                        start_date: vDate,
                        end_date: vDate,
                      },
                    ],
                  });
                } catch (voucherErr) {
                  console.error("Tạo phiếu thu cọc thất bại:", voucherErr);
                  toast.error("HĐ đã lưu nhưng 1 phiếu thu cọc TẠO THẤT BẠI", {
                    duration: 15000,
                    description: `Cọc ${formatCurrency(r.amount)} chưa có chứng từ. Vào Thu chi tạo phiếu thu "Tiền cọc" cho phòng ${roomName}.`,
                  });
                }
              }
            }

            // Flow Cọc giữ chỗ → HĐ: flip phiếu giữ chỗ SAU khi HĐ đã tạo
            // thành công (trước đây flip TRƯỚC khi tạo → HĐ fail là phòng mất
            // RESERVED + lộ ra trang Phòng trống công khai).
            if (prefill?.depositId && contract?.id) {
              const { error: depUpdateErr } = await supabase
                .from("deposits")
                .update({
                  status: "CONVERTED",
                  contract_id: contract.id,
                } as any)
                .eq("id", prefill.depositId);
              if (depUpdateErr) {
                console.error("Flip deposit CONVERTED thất bại:", depUpdateErr);
                toast.warning(
                  "HĐ đã tạo nhưng phiếu giữ chỗ chưa chuyển trạng thái — cập nhật tay trong trang Đặt cọc.",
                );
              }
              queryClient.invalidateQueries({ queryKey: ["deposits"] });
            }

            // Đóng dialog HĐ trước rồi mở modal tạo phiếu chi hoa hồng
            onOpenChange(false);
            if (contract?.id) {
              onCreated?.(contract.id);
              setCommissionContractId(contract.id);
            }
          },
        }
      );
    }
  };

  return onSubmit;
}
