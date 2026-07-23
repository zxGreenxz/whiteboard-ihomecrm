import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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
    queryFn: async (): Promise<PendingApproval[]> => {
      const { data, error } = await (supabase as any).rpc("list_my_pending_approvals_v1");
      if (error) throw error;

      return ((data ?? []) as any[]).map((r) => ({
        request_id: r.request_id,
        submission_no: Number(r.submission_no ?? 0),
        submitted_at: r.submitted_at,
        amount: Number(r.amount ?? 0),
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
      }));
    },
  });
};

// Duyệt / từ chối một yêu cầu. Engine tự kiểm quyền duyệt, chặn maker tự duyệt,
// và chuyển phiếu sang POSTED khi qua hết bước — lỗi trả về là câu tiếng Việt
// từ server nên hiển thị nguyên văn.
export const useDecideApproval = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      requestId: string;
      decision: "APPROVE" | "REJECT";
      reason?: string | null;
    }) => {
      const { data, error } = await (supabase as any).rpc("decide_financial_request_v2", {
        p_request_id: input.requestId,
        p_decision: input.decision,
        p_reason: input.reason ?? null,
      });
      if (error) {
        toast.error(error.message || "Không thể xử lý yêu cầu duyệt");
        throw error;
      }
      return data as { request_id: string; state: string };
    },
    onSuccess: (_data, input) => {
      invalidateAfterDecision(queryClient);
      toast.success(input.decision === "APPROVE" ? "Đã duyệt yêu cầu" : "Đã từ chối yêu cầu");
    },
    onError: (error) => {
      console.error("Error deciding financial request:", error);
    },
  });
};

// Người lập (hoặc super admin) tự thu hồi yêu cầu đã gửi — phiếu về lại nháp.
export const useWithdrawApproval = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { requestId: string; reason?: string | null }) => {
      const { data, error } = await (supabase as any).rpc("withdraw_financial_request_v1", {
        p_request_id: input.requestId,
        p_reason: input.reason ?? null,
      });
      if (error) {
        toast.error(error.message || "Không thể thu hồi yêu cầu");
        throw error;
      }
      return data as { request_id: string; state: string };
    },
    onSuccess: () => {
      invalidateAfterDecision(queryClient);
      toast.success("Đã thu hồi yêu cầu");
    },
    onError: (error) => {
      console.error("Error withdrawing financial request:", error);
    },
  });
};
