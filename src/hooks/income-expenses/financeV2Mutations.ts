// Finance V2 — mutation hooks gọi RPC canonical (Stage-5 writers, plan §7.2).
//
// CHỈ dùng khi route workflow/posting của org là CANONICAL (caller gate bằng
// useFinanceV2Routes + canWriteWorkflow/canWritePosting). Không có fallback raw
// DML: RPC lỗi = fail, hiển thị lỗi — đúng nguyên tắc §8 (42501 thật phải fail).
//
// RPC contracts (Stage-5 20260723050000):
//   approve_income_expense_v2(p_voucher uuid, p_expected_approval_version bigint,
//                             p_idempotency_key text) -> jsonb
//   post_approved_income_expense_v2(input jsonb)      -> jsonb
//   approve_and_post_income_expense_v2(input jsonb)   -> jsonb
// input = PostFinanceExecutionInput (src/lib/incomeExpensePostingValidation.ts).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { PostFinanceExecutionInput } from "@/lib/incomeExpensePostingValidation";

// RPC v2 chưa có trong generated types cho tới lần regen sau forward-apply.
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
const rpc = (fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult> =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => PromiseLike<RpcResult>)(fn, args);

function genIdempotencyKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `v2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const INVALIDATE_KEYS = [
  ["income-expenses"],
  ["income-expense-stats"],
  ["accounts-with-balance"],
  ["finance-v2-routes"],
] as const;

function useInvalidateMoney() {
  const qc = useQueryClient();
  return () => {
    for (const key of INVALIDATE_KEYS) qc.invalidateQueries({ queryKey: [...key] });
  };
}

/** Duyệt-only V2: balance KHÔNG đổi (khác legacy). */
export function useApproveIncomeExpenseV2() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: async (args: { voucherId: string; expectedApprovalVersion?: number }) => {
      const { data, error } = await rpc("approve_income_expense_v2", {
        p_voucher: args.voucherId,
        p_expected_approval_version: args.expectedApprovalVersion ?? 1,
        p_idempotency_key: genIdempotencyKey(),
      });
      if (error) throw new Error(error.message || "Duyệt phiếu thất bại");
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Đã duyệt phiếu — chưa ghi sổ (Đã Duyệt - Chưa Thu/Chi)");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Thu/Chi phiếu ĐÃ duyệt (CUSTODIAN, không cần quyền duyệt). */
export function usePostApprovedIncomeExpenseV2() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: async (input: PostFinanceExecutionInput) => {
      const { data, error } = await rpc("post_approved_income_expense_v2", { input });
      if (error) throw new Error(error.message || "Ghi sổ thất bại");
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Đã ghi sổ (posting) thành công");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Duyệt và Thu/Chi atomic (actor vừa approver vừa CUSTODIAN). */
export function useApproveAndPostIncomeExpenseV2() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: async (input: PostFinanceExecutionInput) => {
      const { data, error } = await rpc("approve_and_post_income_expense_v2", { input });
      if (error) throw new Error(error.message || "Duyệt và ghi sổ thất bại");
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Đã duyệt và ghi sổ atomic");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Binding sổ của CHÍNH actor (CUSTODIAN/KNOWER) — nguồn lọc selector §12.6. */
export function useMyCashbookAccessV2() {
  return useQuery({
    queryKey: ["my-cashbook-access-v2"],
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await rpc("list_my_cashbook_access_v2");
      if (error) {
        console.warn("[financeV2] list_my_cashbook_access_v2:", error.message);
        return null; // null = KHÔNG rõ (RPC lỗi) → caller fail-open giữ list cũ
      }
      return (data ?? []) as { cashbook_id: string; possession_kind: string }[];
    },
  });
}

/** Sổ actor đang là CUSTODIAN — nguồn cho ô Sổ quỹ của Posting dialog (§12.6). */
export function useCustodianCashbooksV2(enabled: boolean) {
  return useQuery({
    queryKey: ["cashbooks-for-expense-v2"],
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await rpc("list_cashbooks_for_expense_v2");
      if (error) {
        console.warn("[financeV2] list_cashbooks_for_expense_v2:", error.message);
        return [] as { id: string; name: string }[];
      }
      return (data ?? []) as { id: string; name: string }[];
    },
  });
}
