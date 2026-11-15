import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {workflowErrorMessage} from '@/lib/financialWorkflow';
import {financialReadRows,financialReadNumber} from '@/lib/financialReadValidation';
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { approvalDecisionFeedback, voucherFailureMessage } from "@/lib/voucherFeedback";
import { loadIncomeExpenseDetails } from "@/lib/incomeExpenseDetailRpc";
import { withDetailReadDeadline } from "@/hooks/income-expenses/detailRead";
import { ledgerAwareWorkflowError } from "@/lib/profitLedger/voucherFailure";

// Một yêu cầu duyệt đang chờ CHÍNH TÔI xử lý — khớp cột của
// public.list_my_pending_approvals_v1() (server đã lọc theo auth.uid(), client
// không truyền tham số nào).
export interface PendingApproval {
  request_id: string;
  submission_no: number;
  submitted_at: string;
  amount: number;
  voucher_id: string;
  voucher_code: string | null;
  voucher_name: string | null;
  voucher_type: string | null;
  maker_name: string | null;
  step_no: number;
  request_version: number;
  // Finance V2 (route-aware §9.6): các cột dưới do server bổ sung dần vào RPC —
  // khi RPC chưa trả thì null/1 ⇒ org resolve LEGACY, inbox giữ nguyên flow
  // decide_financial_request_v2 hiện tại (fail-safe, không đoán CANONICAL).
  organization_id: string | null;
  approval_version: number;
  posting_version: number;
  // Badge "Do AI nộp" (G4, 2026-09-03): RPC hiện KHÔNG chiếu cột này ra
  // (xem AiSubmittedBadge.tsx) — luôn null trên production hôm nay, giữ field
  // để UI tự sáng lên ngay khi RPC được nới thêm cột, không cần đổi FE nữa.
  system_source: string | null;
}

// Cache cần invalidate sau khi quyết định: hộp thư duyệt + danh sách phiếu +
// số dư tài khoản (duyệt xong phiếu POSTED → tiền đã chạy vào sổ).
const invalidateAfterDecision = (queryClient: ReturnType<typeof useQueryClient>) => {
  queryClient.invalidateQueries({ queryKey: ["pending-approvals"] });
  queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
  queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
};

// Danh sách yêu cầu chờ tôi duyệt. numeric/bigint của Postgres về JS dưới dạng
// string qua PostgREST → ép Number ngay để UI khỏi cộng chuỗi.
export const usePendingApprovals = () => {
  return useQuery({
    queryKey: ["pending-approvals"],
    meta: {errorDisplay:"inline",label:"yêu cầu chờ duyệt"},
    queryFn: async (): Promise<PendingApproval[]> => {
      // hermes-parity:begin pending-approvals — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      const { data, error } = await supabase.rpc("list_my_pending_approvals_v1");
      // hermes-parity:end pending-approvals
      if (error) throw error;

      return financialReadRows(data as any[]).map((r) => ({
        request_id: r.request_id,
        submission_no: Number(r.submission_no ?? 0),
        submitted_at: r.submitted_at,
        amount: financialReadNumber(r.amount),
        voucher_id: r.voucher_id,
        voucher_code: r.voucher_code ?? null,
        voucher_name: r.voucher_name ?? null,
        voucher_type: r.voucher_type ?? null,
        maker_name: r.maker_name ?? null,
        step_no: Number(r.step_no ?? 0),
        request_version: Number(r.request_version ?? 0),
        organization_id: r.organization_id ?? null,
        approval_version: Number(r.approval_version ?? 1),
        posting_version: Number(r.posting_version ?? 1),
        system_source: r.system_source ?? null,
      }));
    },
  });
};

/** Nguồn + sổ quỹ của phiếu đứng sau một yêu cầu chờ duyệt. */
export interface PendingVoucherSource {
  system_source: string | null;
  account_id: string | null;
}

/**
 * Nguồn phiếu của các yêu cầu đang chờ (list_my_pending_approvals_v1 KHÔNG chiếu system_source — cột cùng
 * tên ở trên luôn null). Đọc qua read_income_expense_details_v1 — cùng đường hộp "Duyệt và Thu/Chi…" đang
 * dùng, không bị RLS che như đọc thẳng bảng — gom theo công ty. Phiếu không đọc được thì vắng trong kết
 * quả: màn hình coi là "chưa biết" (không chào "Duyệt và Thu/Chi…" cho dòng đó).
 * Khoá dưới gốc "pending-approvals" nên mọi lần làm mới hộp thư cũng làm mới phần này.
 */
export const usePendingApprovalSources = (rows: readonly PendingApproval[]) => {
  const groups = useMemo(() => {
    const byOrg = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.organization_id || !row.voucher_id) continue;
      const ids = byOrg.get(row.organization_id) ?? new Set<string>();
      ids.add(row.voucher_id);
      byOrg.set(row.organization_id, ids);
    }
    return [...byOrg.entries()]
      .map(([org, ids]) => [org, [...ids].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);
  return useQuery({
    queryKey: ["pending-approvals", "voucher-sources", groups],
    enabled: groups.length > 0,
    meta: { errorDisplay: "inline", label: "loại phiếu chờ duyệt" },
    queryFn: async (): Promise<Record<string, PendingVoucherSource>> => {
      const result: Record<string, PendingVoucherSource> = {};
      for (const [org, ids] of groups) {
        const details = await withDetailReadDeadline(loadIncomeExpenseDetails(org, [...ids]));
        for (const detail of details) {
          if (detail.organization_id !== org || !ids.includes(detail.id)) continue;
          result[detail.id] = { system_source: detail.system_source ?? null, account_id: detail.account_id ?? null };
        }
      }
      return result;
    },
  });
};

// Duyệt / từ chối một yêu cầu. Engine tự kiểm quyền duyệt, chặn maker tự duyệt,
// và chuyển phiếu sang POSTED khi qua hết bước — lỗi trả về là câu tiếng Việt
// từ server nên hiển thị nguyên văn.
export const useDecideApproval = () => {
  const queryClient = useQueryClient();
  const workflow=persistentFinancialWorkflow('approval-request',{scope:'actor'});

  return useMutation({
    mutationFn: async (input: {
      requestId: string;
      organizationId?: string | null;
      decision: "APPROVE" | "REJECT";
      reason?: string | null;
    }) => {
      return workflow.run(input.requestId,'xử lý yêu cầu duyệt',async progress=>{
      const { data, error } = await supabase.rpc("decide_financial_request_v2", {
        p_request_id: input.requestId,
        p_decision: input.decision,
        p_reason: input.reason ?? undefined,
      });
      if (error) {
        throw error;
      }
      if ((data as {request_id?:unknown}|null)?.request_id!==input.requestId || approvalDecisionFeedback(data, input.decision).kind === "warning") throw new TypeError("Missing approval decision confirmation");
      progress.completed.push({id:input.requestId,label:'Đã nhận kết quả xử lý yêu cầu duyệt'});
      return data as { request_id: string; state: string };
      },undefined,input.organizationId);
    },
    onSuccess: (_data, input) => {
      invalidateAfterDecision(queryClient);
      const feedback = approvalDecisionFeedback(_data, input.decision);
      toast[feedback.kind](feedback.message);
    },
    onError: (error) => {
      console.error("Error deciding financial request:", error);
      // Phiếu chi theo sổ tổng: chốt F1/F5 trả mã PROFIT_LEDGER_… ⇒ câu riêng; phiếu khác như cũ.
      toast.error(ledgerAwareWorkflowError(error,'xử lý yêu cầu duyệt'));
    },
  });
};

// Người lập (hoặc super admin) tự thu hồi yêu cầu đã gửi — phiếu về lại nháp.
export const useWithdrawApproval = () => {
  const queryClient = useQueryClient();
  const workflow=persistentFinancialWorkflow('approval-request',{scope:'actor'});

  return useMutation({
    mutationFn: async (input: { requestId: string; organizationId?:string|null; reason?: string | null }) => {
      return workflow.run(input.requestId,'thu hồi yêu cầu duyệt',async progress=>{
      const { data, error } = await supabase.rpc("withdraw_financial_request_v1", {
        p_request_id: input.requestId,
        p_reason: input.reason ?? undefined,
      });
      if (error) {
        throw error;
      }
      if ((data as {request_id?:unknown}|null)?.request_id!==input.requestId || approvalDecisionFeedback(data, "WITHDRAW").kind === "warning") throw new TypeError("Missing withdrawal confirmation");
      progress.completed.push({id:input.requestId,label:'Đã nhận kết quả thu hồi yêu cầu duyệt'});
      return data as { request_id: string; state: string };
      },undefined,input.organizationId);
    },
    onSuccess: (data) => {
      invalidateAfterDecision(queryClient);
      const feedback = approvalDecisionFeedback(data, "WITHDRAW");
      toast[feedback.kind](feedback.message);
    },
    onError: (error) => {
      console.error("Error withdrawing financial request:", error);
      toast.error(workflowErrorMessage(error,'thu hồi yêu cầu duyệt'));
    },
  });
};
