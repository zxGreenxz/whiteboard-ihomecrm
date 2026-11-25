import {z} from 'zod';
import {useRef} from 'react';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialAlreadyRecordedError,workflowErrorMessage} from '@/lib/financialWorkflow';
import {financialReadNumber} from '@/lib/financialReadValidation';
import {readContractNoticeOperationReceipt,type ContractNoticeOperationReceipt} from '@/lib/contractNoticeOperationReceipt';
import { submitRoomTransfer } from '@/lib/contract-lifecycle/roomTransferQuote';
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { ExtraChargeItem, RefundItem } from "@/lib/contractValidation";
import { rpcNullable } from "@/lib/rpcNullable";
import { useOrganization } from '@/contexts/OrganizationContext';
import { friendlyError } from '@/lib/friendlyError';
import { isTransferRoomUnavailable, transferRoomFeedback } from '@/lib/contract-lifecycle/transferRoomFeedback';
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
  // Đợt 6: gia hạn tách khỏi dấu chung `contract-notice-transition` (chuyển phòng vẫn dùng, đợt 7). Dấu ở đó (chuyển phòng,
  // hoặc gia hạn của bản trước) cùng hợp đồng vẫn chặn gia hạn hợp đồng đó qua hộp cảnh báo.
  const workflow=useRef(persistentFinancialWorkflow('contract-renew',{scope:'actor',legacy:'contract-notice-transition'}));

  return useMutation({
    retry:false,
    meta:{handlesFeedback:true},
    mutationFn: async (params: RenewNoticeInput) => {
      if(!selectedOrganizationId) throw new Error('Chưa chọn tổ chức');
      const organizationId=selectedOrganizationId;
      const args=buildRenewNoticeArgs(params,organizationId);
      if(params.newRentPrice!==undefined)financialReadNumber(params.newRentPrice);
      if(params.newDeposit!==undefined)financialReadNumber(params.newDeposit);
      // Cách B: renew_contract_with_notice_v1 → apply_contract_notice_transition_v1 (production 25/11/2026) khoá công ty và
      // hợp đồng FOR UPDATE TRƯỚC khi tra mã yêu cầu; cùng mã cùng nội dung ⇒ trả hợp đồng cũ, khác nội dung ⇒ 23505.
      let resend=false;
      return workflow.current.run<ContractNoticeOperationReceipt>(params.contractId,"gia hạn hợp đồng",async progress=>{
        const {data,error}=await supabase.rpc("renew_contract_with_notice_v1",{...args,p_request_id:progress.requestKey});
        if(error){
          if(resend&&String((error as {code?:unknown}).code??'')==='23505')throw new FinancialAlreadyRecordedError('Hợp đồng đã được gia hạn ở lần gửi trước (nội dung lúc đó khác nội dung đang gửi). Tải lại hợp đồng để kiểm tra trước khi gia hạn tiếp.',[params.contractId]);
          throw error;
        }
        const parsedId=z.string().guid().safeParse(data);
        if(parsedId.success)progress.completed.push({id:parsedId.data,label:`Hợp đồng cần đối chiếu: ${parsedId.data}`});
        if(!parsedId.success||parsedId.data!==params.contractId)throw new TypeError("Unconfirmed contract operation ID");
        const receipt=await readContractNoticeOperationReceipt(organizationId,progress.requestKey,params,'RENEW');
        progress.completed.push({id:receipt.eventId,label:'Đã xác nhận sự kiện gia hạn/chuyển phòng'});
        return receipt;
      },async pending=>{
        const requestKey=pending.requestKey??pending.attemptId;
        // Sự kiện của đúng mã yêu cầu đó đã có: lần trước đã gia hạn.
        const {data:event,error:eventError}=await supabase.from('contract_notice_transition_events').select('id').eq('request_id',requestKey).eq('organization_id',organizationId).maybeSingle();
        if(eventError)throw eventError;
        if(event){
          try{return {result:await readContractNoticeOperationReceipt(organizationId,requestKey,params,'RENEW')};}
          // Sự kiện có thật nên hợp đồng đã được gia hạn; chỉ chưa dựng lại được biên nhận theo nội dung đang gửi.
          catch{return {outcome:'already-written',message:'Hợp đồng đã được gia hạn ở lần gửi trước. Tải lại hợp đồng để xem kết quả trước khi gia hạn tiếp.',recordIds:[params.contractId]};}
        }
        resend=true;
        return {outcome:'not-written',serverDedupesRequestKey:true};
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

/** Sự kiện gia hạn/chuyển phòng của đúng mã yêu cầu (cột `request_id` duy nhất). Đọc hỏng thì ném: chưa kết luận được. */
async function readNoticeEvent(organizationId:string,requestId:string){
  const {data,error}=await supabase.from('contract_notice_transition_events').select('id,operation,result_contract_id').eq('request_id',requestId).eq('organization_id',organizationId).maybeSingle();
  if(error)throw error;
  return data as {id:string;operation:string;result_contract_id:string|null}|null;
}

export const useTransferRoom = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  // Đợt 7: chuyển phòng giữ namespace `contract-notice-transition` (gia hạn đã tách sang `contract-renew` ở đợt 6) để dấu đang
  // kẹt trong máy nhân viên, kể cả dấu gia hạn của bản trước, được đối chiếu theo mã yêu cầu thay vì chặn.
  const workflow=useRef(persistentFinancialWorkflow('contract-notice-transition',{scope:'actor'}));

  return useMutation({
    retry:false,
    meta:{handlesFeedback:true},
    mutationFn: async (params: TransferRoomNoticeInput) => {
      if(!selectedOrganizationId) throw new Error('Chưa chọn tổ chức');
      const organizationId=selectedOrganizationId;
      const args=buildTransferRoomNoticeArgs(params,organizationId);
      if(params.newRentPrice!==undefined)financialReadNumber(params.newRentPrice);
      // Cách B: transfer_room_with_notice_v2 → apply_contract_notice_transition_v1 (production 26/11/2026) khoá công ty, hai
      // phòng (khoá tư vấn) và hợp đồng FOR UPDATE TRƯỚC khi tra mã yêu cầu; cùng mã cùng nội dung ⇒ trả hợp đồng cũ, khác nội
      // dung ⇒ 23505. Phiên bản hợp đồng (`expected_updated_at`) chỉ được so SAU khi tra mã, nên lần gửi lại của một lần đã
      // chuyển nhận lại kết quả cũ, không chuyển hai lần.
      let resend=false;
      return workflow.current.run<ContractNoticeOperationReceipt>(params.contractId,"chuyển phòng",async progress=>{
        const {data,error}=await submitRoomTransfer({...args,p_request_id:progress.requestKey});
        if(error){
          // Gửi lại cùng mã mà máy chủ báo trùng: sự kiện của mã đó đã có (lần trước đã ghi, với nội dung khác lần này).
          if(resend&&String((error as {code?:unknown}).code??'')==='23505'){
            let event:Awaited<ReturnType<typeof readNoticeEvent>>=null;
            try{event=await readNoticeEvent(organizationId,progress.requestKey);}
            catch{/* Đọc lại hỏng: giữ nguyên lời từ chối 23505 của máy chủ, không đoán đã ghi. */}
            if(event)throw new FinancialAlreadyRecordedError(event.operation==='TRANSFER_ROOM'
              ?'Hợp đồng đã được chuyển phòng ở lần gửi trước (nội dung lúc đó khác nội dung đang gửi). Tải lại hợp đồng để kiểm tra phòng mới trước khi thao tác tiếp.'
              :'Lần gia hạn hợp đồng gửi trước đó đã được ghi. Tải lại hợp đồng để kiểm tra rồi mới chuyển phòng.',[event.result_contract_id??params.contractId]);
          }
          throw error;
        }
        const parsedId=z.string().guid().safeParse(data);
        if(parsedId.success)progress.completed.push({id:parsedId.data,label:`Hợp đồng cần đối chiếu: ${parsedId.data}`});
        if(!parsedId.success||parsedId.data!==params.contractId)throw new TypeError("Unconfirmed contract operation ID");
        const receipt=await readContractNoticeOperationReceipt(organizationId,progress.requestKey,params,'TRANSFER_ROOM');
        progress.completed.push({id:receipt.eventId,label:'Đã xác nhận sự kiện gia hạn/chuyển phòng'});
        return receipt;
      },async pending=>{
        const requestKey=pending.requestKey??pending.attemptId;
        const event=await readNoticeEvent(organizationId,requestKey);
        if(event){
          if(event.operation==='TRANSFER_ROOM'){
            try{return {result:await readContractNoticeOperationReceipt(organizationId,requestKey,params,'TRANSFER_ROOM')};}
            // Sự kiện có thật nên hợp đồng đã được chuyển; chỉ chưa dựng lại được biên nhận theo nội dung đang gửi.
            catch{return {outcome:'already-written',message:'Hợp đồng đã được chuyển phòng ở lần gửi trước. Tải lại hợp đồng để xem phòng mới trước khi thao tác tiếp.',recordIds:[event.result_contract_id??params.contractId]};}
          }
          // Dấu chung bản trước (đợt 6 đã tách gia hạn) là của một lần gia hạn đã ghi.
          return {outcome:'already-written',message:'Lần gia hạn hợp đồng gửi trước đó đã được ghi. Tải lại hợp đồng để kiểm tra rồi mới chuyển phòng.',recordIds:[event.result_contract_id??params.contractId]};
        }
        // Hàng rào biên nhận: lần trước máy chủ đã trả mã hợp đồng (đã chuyển) mà nay không đọc thấy sự kiện của mã đó (quyền
        // xem đổi?). Không gửi lại; giữ dấu và mã để đối chiếu qua hộp cảnh báo.
        if(pending.completedIds.length)return null;
        resend=true;
        return {outcome:'not-written',serverDedupesRequestKey:true};
      });
    },
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["contract-history"] });
      queryClient.invalidateQueries({ queryKey: ["customer-residence"] });
      queryClient.invalidateQueries({ queryKey: ["room-cash-lifecycle"] });
      queryClient.invalidateQueries({ queryKey: ["commission-prefill", receipt.contractId] });
      queryClient.invalidateQueries({ queryKey: ["commission-interventions"] });
      for (const key of [
        'room-transfer-preview', 'room-transfer-invoice-rents', 'invoices', 'invoices-legacy', 'invoice', 'invoice-history',
        'invoice-statistics', 'unpaid-invoices', 'income-expenses', 'pending-approvals', 'deposit-dashboard',
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      toast.success(`Đã chuyển hợp đồng ${receipt.contractNumber} sang phòng ${receipt.roomName}.`);
    },
    onError: (error: unknown) => {
      console.error("Error transferring room:", error);
      const feedback = transferRoomFeedback(error);
      if (feedback.code === 'PT409') {
        void queryClient.invalidateQueries({ queryKey: ['contracts'] });
        void queryClient.invalidateQueries({ queryKey: ['room-transfer-preview'] });
      }
      if (isTransferRoomUnavailable(error)) queryClient.invalidateQueries({ queryKey: ['rooms'] });
      toast.error(feedback.outcome === 'partial' || feedback.outcome === 'unknown'
        ? feedback.description
        : `${feedback.title} ${feedback.description}`);
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
