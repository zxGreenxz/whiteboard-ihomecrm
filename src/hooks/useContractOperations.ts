import {z} from 'zod';
import {useRef} from 'react';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {workflowErrorMessage} from '@/lib/financialWorkflow';
import {financialReadNumber} from '@/lib/financialReadValidation';
import {readContractNoticeOperationReceipt} from '@/lib/contractNoticeOperationReceipt';
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { ExtraChargeItem, RefundItem } from "@/lib/contractValidation";
import { rpcNullable } from "@/lib/rpcNullable";
import { useOrganization } from '@/contexts/OrganizationContext';
import { friendlyError } from '@/lib/friendlyError';
import { buildRenewNoticeArgs,buildTransferRoomNoticeArgs,type RenewNoticeInput,type TransferRoomNoticeInput } from '@/lib/contract-lifecycle/noticeTransitions';
import {
  buildForfeitWithCreditRpcArgs,
  buildMoveOutWithCreditRpcArgs,
  invokeCustomerCreditRpc,
  prepareCustomerCreditRequest,
} from "@/lib/customerCreditRpc";

function showContractOperationError(error: unknown, title: string, operation: string) {
  const feedback = friendlyError(error, title, { operation, financial: true });
  toast.error(feedback.title, { description: feedback.description });
}

// =============================================
// useRenewContract — Gia hạn hợp đồng
// Requirements: 4.2, 4.3
// =============================================

export const useRenewContract = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('contract-notice-transition',{scope:'actor'}));

  return useMutation({
    retry:false,
    meta:{handlesFeedback:true},
    mutationFn: async (params: RenewNoticeInput) => {
      if(!selectedOrganizationId) throw new Error('Chưa chọn tổ chức');
      const args=buildRenewNoticeArgs(params,selectedOrganizationId);
      if(params.newRentPrice!==undefined)financialReadNumber(params.newRentPrice);
      if(params.newDeposit!==undefined)financialReadNumber(params.newDeposit);
      return workflow.current.run(params.contractId,"gia hạn hợp đồng",async progress=>{
        const {data,error}=await supabase.rpc("renew_contract_with_notice_v1",{...args,p_request_id:progress.requestKey});
        if(error)throw error;
        const parsedId=z.string().uuid().safeParse(data);
        if(parsedId.success)progress.completed.push({id:parsedId.data,label:`Hợp đồng cần đối chiếu: ${parsedId.data}`});
        if(!parsedId.success||parsedId.data!==params.contractId)throw new TypeError("Unconfirmed contract operation ID");
        const receipt=await readContractNoticeOperationReceipt(selectedOrganizationId,progress.requestKey,params,'RENEW');
        progress.completed.push({id:receipt.eventId,label:'Đã xác nhận sự kiện gia hạn/chuyển phòng'});
        return receipt;
      });
    },
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["contract-history"] });
      toast.success(`Đã gia hạn hợp đồng ${receipt.contractNumber} đến ${receipt.endDate.split('-').reverse().join('/')}.`);
    },
    onError: (error: any) => {
      console.error("Error renewing contract:", error);
      if(error?.code==='PT409') queryClient.invalidateQueries({queryKey:['contracts']});
      toast.error(workflowErrorMessage(error,'gia hạn hợp đồng'));
    },
  });
};

// =============================================
// useTransferRoom — Chuyển phòng
// Requirements: 5.2, 5.3
// =============================================

export const useTransferRoom = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const workflow=useRef(persistentFinancialWorkflow('contract-notice-transition',{scope:'actor'}));

  return useMutation({
    retry:false,
    meta:{handlesFeedback:true},
    mutationFn: async (params: TransferRoomNoticeInput) => {
      if(!selectedOrganizationId) throw new Error('Chưa chọn tổ chức');
      const args=buildTransferRoomNoticeArgs(params,selectedOrganizationId);
      if(params.newRentPrice!==undefined)financialReadNumber(params.newRentPrice);
      return workflow.current.run(params.contractId,"chuyển phòng",async progress=>{
        const {data,error}=await supabase.rpc("transfer_room_with_notice_v1",{...args,p_request_id:progress.requestKey});
        if(error)throw error;
        const parsedId=z.string().uuid().safeParse(data);
        if(parsedId.success)progress.completed.push({id:parsedId.data,label:`Hợp đồng cần đối chiếu: ${parsedId.data}`});
        if(!parsedId.success||parsedId.data!==params.contractId)throw new TypeError("Unconfirmed contract operation ID");
        const receipt=await readContractNoticeOperationReceipt(selectedOrganizationId,progress.requestKey,params,'TRANSFER_ROOM');
        progress.completed.push({id:receipt.eventId,label:'Đã xác nhận sự kiện gia hạn/chuyển phòng'});
        return receipt;
      });
    },
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["contract-history"] });
      toast.success(`Đã chuyển hợp đồng ${receipt.contractNumber} sang phòng ${receipt.roomName}.`);
    },
    onError: (error: any) => {
      console.error("Error transferring room:", error);
      if(error?.code==='PT409') queryClient.invalidateQueries({queryKey:['contracts']});
      toast.error(workflowErrorMessage(error,'chuyển phòng'));
    },
  });
};

// =============================================
// useRegisterMoveOut — Đăng ký ngày chuyển đi
// Requirements: 6.2, 6.5
// =============================================

export { useSaveContractMoveOutNotice as useRegisterMoveOut } from '@/hooks/useContractMoveOutNotice';

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
      showContractOperationError(error, 'Không nhượng được hợp đồng', 'nhượng hợp đồng');
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
      showContractOperationError(error, 'Không thanh lý được hợp đồng', 'thanh lý bỏ cọc');
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
      /** Khoản MÌNH trả lại khách (tiền phòng ngày không ở…) — 22/08/2026. */
      refundItems?: RefundItem[];
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
      showContractOperationError(error, 'Không thanh lý được hợp đồng', 'quyết toán rời phòng');
    },
  });
};
