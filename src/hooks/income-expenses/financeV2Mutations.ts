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

/** Phiếu do FLOW HỆ THỐNG sở hữu (vd Hoàn tiền hoá đơn): RPC thủ công từ chối
 * "owned by system flow" — phải quyết định qua dispatcher §8. */
export function isOwnedBySystemFlow(message: string | null | undefined): boolean {
  return /owned by system flow/i.test(message ?? "");
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
      if (error && isOwnedBySystemFlow(error.message)) {
        // 7ac: phiếu flow-owned (INVOICE_REFUND/TERMINATION_REFUND) duyệt qua
        // entrypoint dispatch — cùng quyền income_expenses.approve, không đổi cash.
        const owned = await rpc("decide_owned_income_expense_v2", {
          p_voucher: args.voucherId,
          p_decision: "approve",
          p_reason: null,
          p_idempotency_key: genIdempotencyKey(),
        });
        if (owned.error) throw new Error(owned.error.message || "Duyệt phiếu thất bại");
        return owned.data;
      }
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

/** Hoàn tác phiếu ĐÃ GHI SỔ (mô hình 2 nút): tiền trả về sổ bằng bút toán đối
 *  dấu, phiếu về "Đã hoàn tác" — nằm chờ Chi lại hoặc Huỷ. CUSTODIAN đúng sổ. */
export function useReversePostingV2() {
  const invalidate = useInvalidateMoney();
  return useMutation({
    mutationFn: async (args: {
      voucherId: string;
      cashbookId: string;
      reason?: string | null;
    }) => {
      const { data, error } = await rpc("reverse_posted_income_expense_v2", {
        p_voucher: args.voucherId,
        p_cashbook: args.cashbookId,
        p_posted_on: new Date().toISOString().split("T")[0],
        p_reason: args.reason || "Hoàn tác thủ công",
        p_idempotency_key: `rev-${args.voucherId}-${Date.now()}`,
      });
      if (error) throw new Error(error.message || "Hoàn tác thất bại");
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Đã hoàn tác — tiền trả về sổ, phiếu chờ Chi lại hoặc Huỷ");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Upload chứng từ theo flow §6.3: intent (server cấp path) → upload storage →
 * finalize (server verify + FINALIZED). Trả evidence_id hoặc null nếu lỗi.
 * Dùng làm onUploadEvidence của IncomeExpensePostingDialog.
 */
export async function uploadFinanceEvidence(
  file: File,
  organizationId?: string | null,
): Promise<string | null> {
  // PHẢI truyền org của phiếu: server-default là membership đầu tiên của user —
  // user đa-org sẽ bị stamp sai tenant ⇒ posting từ chối "not FINALIZED in tenant".
  const intent = await rpc("create_finance_evidence_upload_intent_v2", {
    p_organization_id: organizationId ?? null,
  });
  if (intent.error) {
    toast.error(intent.error.message || "Không tạo được intent chứng từ");
    return null;
  }
  const { evidence_id, bucket_id, object_name } = intent.data as {
    evidence_id: string; bucket_id: string; object_name: string;
  };
  const up = await supabase.storage.from(bucket_id).upload(object_name, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (up.error) {
    toast.error(up.error.message || "Upload chứng từ thất bại");
    return null;
  }
  const fin = await rpc("finalize_finance_evidence_v2", { p_evidence_id: evidence_id });
  if (fin.error) {
    toast.error(fin.error.message || "Finalize chứng từ thất bại");
    return null;
  }
  return evidence_id;
}

/**
 * 7ai: dùng LUÔN ảnh đã đính kèm trên phiếu làm chứng từ chi — không bắt tải lại.
 *
 * Ảnh đính kèm (`income_expenses.attachments`) và chứng từ (`finance_evidence_objects`)
 * là hai bản ghi khác nhau; RPC lập bản ghi chứng từ FINALIZED trỏ vào đúng file
 * đã có trong storage. Chỉ nhận file nằm trong attachments của chính phiếu đó.
 *
 * Không ném lỗi: chứng từ tự-nhận là tiện ích, hỏng thì người dùng vẫn tải tay.
 */
export async function adoptVoucherAttachmentsAsEvidence(
  voucherId: string,
): Promise<{ evidenceIds: string[]; skipped: { url: string; reason: string }[] }> {
  const { data, error } = await rpc("adopt_voucher_attachments_as_evidence_v2", {
    p_voucher: voucherId,
  });
  if (error) {
    console.warn("[financeV2] adopt_voucher_attachments_as_evidence_v2:", error.message);
    return { evidenceIds: [], skipped: [] };
  }
  const payload = (data ?? {}) as {
    evidence_ids?: string[];
    skipped?: { url: string; reason: string }[];
  };
  return {
    evidenceIds: payload.evidence_ids ?? [],
    skipped: payload.skipped ?? [],
  };
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

/** Cờ hiển thị per-sổ cho trang Sổ quỹ: balance_visible bám ĐÚNG predicate RLS
 * posting lines (sổ không-binding → "—" thay vì 0 đ giả); can_manage/can_delete
 * mirror policy UPDATE/DELETE accounts (ẩn icon thay vì để bấm rồi 42501). */
export interface CashbookVisibility {
  cashbook_id: string;
  balance_visible: boolean;
  can_manage: boolean;
  can_delete: boolean;
}
export function useCashbookVisibilityV2() {
  return useQuery({
    queryKey: ["cashbook-visibility-v2"],
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await rpc("list_cashbook_visibility_v2");
      if (error) {
        console.warn("[financeV2] list_cashbook_visibility_v2:", error.message);
        return null; // null = KHÔNG rõ (RPC lỗi/chưa deploy) → caller giữ hành vi cũ
      }
      return (data ?? []) as CashbookVisibility[];
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
