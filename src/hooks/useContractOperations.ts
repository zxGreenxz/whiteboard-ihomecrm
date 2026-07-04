import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type { ExtraChargeItem } from "@/lib/contractValidation";

// =============================================
// useRenewContract — Gia hạn hợp đồng
// Requirements: 4.2, 4.3
// =============================================

export const useRenewContract = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      contractId: string;
      newEndDate: string;
      newRentPrice?: number;
      newDeposit?: number;
      notes?: string;
    }) => {
      const { data, error } = await (supabase as any).rpc("renew_contract", {
        p_contract_id: params.contractId,
        p_new_end_date: params.newEndDate,
        p_new_rent_price: params.newRentPrice ?? null,
        p_new_deposit: params.newDeposit ?? null,
        p_notes: params.notes ?? null,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast.success("Gia hạn hợp đồng thành công");
    },
    onError: (error: any) => {
      console.error("Error renewing contract:", error);
      toast.error(error?.message || "Có lỗi xảy ra khi gia hạn hợp đồng");
    },
  });
};

// =============================================
// useTransferRoom — Chuyển phòng
// Requirements: 5.2, 5.3
// =============================================

export const useTransferRoom = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      contractId: string;
      newRoomId: string;
      newRentPrice?: number;
      transferDate: string;
      notes?: string;
    }) => {
      const { data, error } = await (supabase as any).rpc("transfer_room", {
        p_contract_id: params.contractId,
        p_new_room_id: params.newRoomId,        p_new_rent_price: params.newRentPrice ?? null,
        p_transfer_date: params.transferDate,
        p_notes: params.notes ?? null,
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast.success("Chuyển phòng thành công");
    },
    onError: (error: any) => {
      console.error("Error transferring room:", error);
      toast.error(error?.message || "Có lỗi xảy ra khi chuyển phòng");
    },
  });
};

// =============================================
// useRegisterMoveOut — Đăng ký ngày chuyển đi
// Requirements: 6.2, 6.5
// =============================================

export const useRegisterMoveOut = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      contractId: string;
      expectedMoveOutDate: string;
      notes?: string;
    }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const updateData: Record<string, any> = {
        expected_move_out_date: params.expectedMoveOutDate,
      };
      if (params.notes !== undefined) {
        updateData.notes = params.notes;
      }

      const { error } = await supabase
        .from("contracts")
        .update(updateData as any)
        .eq("id", params.contractId)
        ;

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast.success("Đăng ký ngày chuyển đi thành công");
    },
    onError: (error: any) => {
      console.error("Error registering move out:", error);
      toast.error(
        error?.message || "Có lỗi xảy ra khi đăng ký ngày chuyển đi"
      );
    },
  });
};

// =============================================
// useTransferContract — Nhượng hợp đồng
// Requirements: 7.2, 7.3
// =============================================

export const useTransferContract = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      contractId: string;
      newCustomerId: string;
      newRentPrice?: number;
      newDeposit?: number;
      transferDate: string;
      notes?: string;
    }) => {
      const { data, error } = await (supabase as any).rpc(
        "transfer_contract",
        {
          p_contract_id: params.contractId,
          p_new_customer_id: params.newCustomerId,
          p_new_rent_price: params.newRentPrice ?? null,
          p_new_deposit: params.newDeposit ?? null,
          p_transfer_date: params.transferDate,
          p_notes: params.notes ?? null,
        }
      );

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast.success("Nhượng hợp đồng thành công");
    },
    onError: (error: any) => {
      console.error("Error transferring contract:", error);
      toast.error(error?.message || "Có lỗi xảy ra khi nhượng hợp đồng");
    },
  });
};

// =============================================
// useTerminateForfeit — Thanh lý: Khách bỏ cọc
// Requirements: 8.3, 8.4
// =============================================

export const useTerminateForfeit = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      contractId: string;
      forfeitDate: string;
      extraCharges?: ExtraChargeItem[];
    }) => {
      const { data, error } = await (supabase as any).rpc(
        "terminate_contract_forfeit",
        {
          p_contract_id: params.contractId,
          p_forfeit_date: params.forfeitDate,
          p_extra_charges: params.extraCharges ?? [],
        }
      );

      if (error) throw error;

      // Xoá toàn bộ credit còn dư của contract (forfeit)
      await consumeRemainingCredit(
        params.contractId,
        `Forfeit credit khi bỏ cọc ngày ${params.forfeitDate}`,
      );

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["excess-amount"] });
      // Banner "cọc chờ duyệt" trên trang HĐ cập nhật ngay, khỏi F5.
      queryClient.invalidateQueries({ queryKey: ["contract-pending-forfeit"] });
      // B1 (audit 03/07): bỏ cọc là luồng TRÌ HOÃN — cọc chỉ vào doanh thu và
      // hoá đơn thanh lý chỉ tất toán khi phiếu "Doanh thu bỏ cọc" được DUYỆT
      // ở trang Thu chi. Toast phải nhắc + dẫn thẳng tới đó, không im lặng.
      toast.success("Đã thanh lý (bỏ cọc) — CÒN 1 BƯỚC: duyệt phiếu cọc", {
        description:
          'Phiếu thu "Doanh thu bỏ cọc" đang CHỜ DUYỆT. Vào Thu chi bấm Duyệt thì cọc mới vào doanh thu và hoá đơn thanh lý mới tất toán.',
        duration: 12000,
        action: {
          label: "Mở Thu chi",
          onClick: () => {
            window.location.href = "/income-expense";
          },
        },
      });
    },
    onError: (error: any) => {
      console.error("Error terminating contract (forfeit):", error);
      toast.error(
        error?.message || "Có lỗi xảy ra khi thanh lý hợp đồng"
      );
    },
  });
};

// Consume credit còn dư của contract bằng cách INSERT excess_amounts row âm.
// - forfeit: tiêu TOÀN BỘ (khách bỏ đi, credit bị forfeit) — maxAmount undefined.
// - move-out: chỉ tiêu ĐÚNG phần đã áp vào quyết toán (excess_rent) — B2 audit
//   03/07: trước đây luôn tiêu hết nên hạ ô "Tiền phòng thừa" xuống vẫn mất
//   sạch credit của khách một cách im lặng.
// Idempotent qua source_invoice rollback.
async function consumeRemainingCredit(
  contractId: string,
  description: string,
  maxAmount?: number,
): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;

  const { data: rows, error: queryErr } = await (supabase
    .from("excess_amounts" as any) as any)
    .select(
      "amount, source_invoice:invoices!source_invoice_id(deleted_at)",
    )
    .eq("contract_id", contractId);
  if (queryErr) {
    console.error("consumeRemainingCredit query error:", queryErr);
    return;
  }
  const total = (rows ?? []).reduce((sum: number, row: any) => {
    if (row.source_invoice?.deleted_at) return sum;
    return sum + (Number(row.amount) || 0);
  }, 0);
  const toConsume =
    maxAmount === undefined ? total : Math.min(total, Math.max(maxAmount, 0));
  if (toConsume <= 0) return;

  const { error: insertErr } = await supabase
    .from("excess_amounts" as any)
    .insert({
      user_id: user.id,
      contract_id: contractId,
      amount: -toConsume,
      description,
      source_invoice_id: null,
      source_payment_id: null,
    } as any);
  if (insertErr) {
    console.error("consumeRemainingCredit insert error:", insertErr);
  }
}

// =============================================
// useTerminateMoveOut — Thanh lý: Khách rời phòng
// Requirements: 9.6
// =============================================

export const useTerminateMoveOut = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      contractId: string;
      moveOutDate: string;
      depositRefund: number;
      penaltyFee?: number;
      excessRent?: number;
      outstandingDebt?: number;
      notes?: string;
      extraCharges?: ExtraChargeItem[];
      // A5 (audit 03/07): 'PAID' = khách đã trả phần thiếu tại chỗ (ghi thu ngay,
      // như cũ); 'DEBT' = ghi nợ — hoá đơn giữ công nợ thật chờ thu, KHÔNG tạo
      // phiếu "Khách trả thêm" (tránh doanh thu ảo khi khách chưa trả).
      shortfallMode?: "PAID" | "DEBT";
      // B3 (04/07): sổ THỰC nhận tiền "khách trả thêm" — null = server tự chọn
      // sổ "%Thu" của người bấm (ưu tiên is_default), fallback sổ vận hành toà.
      receiptAccountId?: string | null;
    }) => {
      const { data, error } = await (supabase as any).rpc(
        "terminate_contract_move_out",
        {
          p_contract_id: params.contractId,
          p_move_out_date: params.moveOutDate,
          p_deposit_refund: params.depositRefund,
          p_penalty_fee: params.penaltyFee ?? 0,
          p_excess_rent: params.excessRent ?? 0,
          p_outstanding_debt: params.outstandingDebt ?? 0,
          p_notes: params.notes ?? null,
          p_extra_charges: params.extraCharges ?? [],
          p_shortfall_mode: params.shortfallMode ?? "PAID",
          p_receipt_account_id: params.receiptAccountId ?? null,
        }
      );

      if (error) throw error;

      // B2: chỉ tiêu credit ĐÚNG phần đã áp vào quyết toán (excess_rent) —
      // phần còn lại giữ nguyên trên sổ credit của khách.
      await consumeRemainingCredit(
        params.contractId,
        `Tiêu credit khi thanh lý move-out ngày ${params.moveOutDate}`,
        params.excessRent ?? 0,
      );

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["excess-amount"] });
      toast.success("Thanh lý hợp đồng thành công");
    },
    onError: (error: any) => {
      console.error("Error terminating contract (move out):", error);
      toast.error(
        error?.message || "Có lỗi xảy ra khi thanh lý hợp đồng"
      );
    },
  });
};
