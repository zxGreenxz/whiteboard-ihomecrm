import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type { ExtraChargeItem } from "@/lib/contractValidation";
import { rpcNullable } from "@/lib/rpcNullable";
import {
  buildForfeitWithCreditRpcArgs,
  buildMoveOutWithCreditRpcArgs,
  invokeCustomerCreditRpc,
  prepareCustomerCreditRequest,
} from "@/lib/customerCreditRpc";

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
      const { data, error } = await supabase.rpc("renew_contract", {
        p_contract_id: params.contractId,
        p_new_end_date: params.newEndDate,
        p_new_rent_price: params.newRentPrice ?? undefined,
        p_new_deposit: params.newDeposit ?? undefined,
        p_notes: params.notes ?? undefined,
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
      const { data, error } = await supabase.rpc("transfer_room", {
        p_contract_id: params.contractId,
        p_new_room_id: params.newRoomId,        p_new_rent_price: params.newRentPrice ?? undefined,
        p_transfer_date: params.transferDate,
        p_notes: params.notes ?? undefined,
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
      const { data, error } = await supabase.rpc(
        "transfer_contract",
        {
          p_contract_id: params.contractId,
          p_new_customer_id: params.newCustomerId,
          p_new_rent_price: params.newRentPrice ?? undefined,
          p_new_deposit: params.newDeposit ?? undefined,
          p_transfer_date: params.transferDate,
          p_notes: params.notes ?? undefined,
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
      const request = prepareCustomerCreditRequest("contract-forfeit");
      return invokeCustomerCreditRpc(
        (fn, args) => supabase.rpc(fn, args),
        "terminate_contract_forfeit_with_credit_v1",
        buildForfeitWithCreditRpcArgs(params, request),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["excess-amount"] });
      // Banner "cọc chờ duyệt" trên trang HĐ cập nhật ngay, khỏi F5.
      queryClient.invalidateQueries({ queryKey: ["contract-pending-forfeit"] });
      // 7af (25/07, hướng A): bỏ cọc KHÔNG còn bước duyệt tay — writer tự duyệt
      // cặp bút toán nội bộ và tất toán hoá đơn thanh lý ngay trong cùng lệnh.
      // Toast chỉ báo kết quả, không dẫn sang Thu chi nữa.
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      toast.success("Đã thanh lý (bỏ cọc) — xong, không cần duyệt thêm", {
        description:
          "Cọc khách bỏ đã vào doanh thu và hoá đơn thanh lý đã tất toán. Sổ quỹ không đổi vì đây là bút toán nội bộ.",
        duration: 8000,
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
      const request = prepareCustomerCreditRequest("contract-move-out");
      const moveOutArgs = buildMoveOutWithCreditRpcArgs(params, request);
      return invokeCustomerCreditRpc(
        (fn, args) => supabase.rpc(fn, args),
        "terminate_contract_move_out_with_credit_v1",
        {
          ...moveOutArgs,
          // p_notes (text) và p_receipt_account_id (uuid) là tham số BẮT BUỘC —
          // không có DEFAULT trong chữ ký SQL (20260728140000_move_out_credit_route_guard)
          // nên bộ sinh khai chúng non-null, dù PostgreSQL nhận NULL và NULL chính
          // là giá trị đúng ở đây (không ghi chú / để server tự chọn sổ thu).
          p_notes: rpcNullable<string>(moveOutArgs.p_notes),
          p_receipt_account_id: rpcNullable<string>(moveOutArgs.p_receipt_account_id),
        },
      );
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
