// Sửa phiếu thu chi Chờ duyệt có lưu vết + duyệt có kiểm phiên bản (đợt 1, 25/09/2026).
//
//   revise_pending_income_expense_v1   — mọi lần sửa phiếu Chờ duyệt (form Sửa, hộp
//                                        Duyệt đổi sổ/ảnh, đổi sổ cả đợt, sửa người nhận)
//   approve_pending_income_expense_checked_v1 — nút Duyệt gửi kèm phiên bản đang xem;
//                                        phiếu vừa bị sửa ⇒ PT409 "tải lại"
//   income_expense_revisions           — lịch sử sửa (RLS cùng tầm nhìn phiếu)

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import {
  incomeExpenseRevisionSchema,
  isStaleVersionError,
  newRevisionIdempotencyKey,
  reviseResultSchema,
  revisionErrorMessage,
  type IncomeExpenseRevision,
  type ReviseResult,
} from "@/lib/incomeExpenseRevision";

const REVISION_COLUMNS =
  "id,income_expense_id,revision_no,kind,actor_id,actor_name,reason,changed_fields,before_snapshot,after_snapshot,created_at";

/** Key của mọi màn đọc phiếu — sửa/duyệt xong thì làm mới hết. */
export const VOUCHER_QUERY_KEYS = [
  ["income-expenses"],
  ["income-expense-batches"],
  ["income-expense-stats"],
  ["voucher-with-batch"],
  ["income-expense"],
  ["ie-history"],
  ["voucher-change-log"],
  ["income-expense-revisions"],
  ["accounts-with-balance"],
] as const;

export function useIncomeExpenseRevisions(voucherId?: string | null, enabled = true) {
  return useQuery({
    queryKey: ["income-expense-revisions", voucherId],
    enabled: enabled && !!voucherId,
    queryFn: async (): Promise<IncomeExpenseRevision[]> => {
      if (!voucherId) return [];
      const { data, error } = await supabase
        .from("income_expense_revisions")
        .select(REVISION_COLUMNS)
        .eq("income_expense_id", voucherId)
        .order("revision_no", { ascending: true });
      if (error) throw error;
      return z.array(incomeExpenseRevisionSchema).parse(data ?? []);
    },
  });
}

export interface RevisionCounts {
  /** Số lần sửa phiếu Chờ duyệt (kind EDIT_PENDING). */
  edit: number;
  /** Số lần đổi hình thức thu (kind COLLECTION_METHOD). */
  method: number;
}

/** Đếm lịch sử theo phiếu; phiếu chưa có dòng nào thì không có khoá. */
export function countRevisionsByVoucher(
  rows: { income_expense_id: string; kind: string }[],
): Record<string, RevisionCounts> {
  const out: Record<string, RevisionCounts> = {};
  for (const r of rows) {
    const c = (out[r.income_expense_id] ??= { edit: 0, method: 0 });
    if (r.kind === "EDIT_PENDING") c.edit += 1;
    else if (r.kind === "COLLECTION_METHOD") c.method += 1;
  }
  return out;
}

/**
 * Dấu "Đã sửa N lần" cho các phiếu đang hiện trên một trang danh sách.
 *
 * CỐ Ý là câu RIÊNG, không nhúng vào câu đọc danh sách: nhúng làm câu danh sách
 * chậm thêm ~0,7–1 giây (đo trên TEST 25/09 — RLS của bảng lịch sử tính theo từng
 * phiếu cha). Câu riêng chỉ đọc lịch sử của đúng các phiếu trên trang và không
 * chặn bảng hiện ra; dấu hiện sau một nhịp.
 */
export function useRevisionCounts(voucherIds: readonly string[]) {
  const ids = [...new Set(voucherIds)].sort();
  return useQuery({
    queryKey: ["income-expense-revisions", "counts", ids],
    enabled: ids.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, RevisionCounts>> => {
      const { data, error } = await supabase
        .from("income_expense_revisions")
        .select("income_expense_id,kind")
        .in("income_expense_id", ids);
      if (error) throw error;
      return countRevisionsByVoucher(data ?? []);
    },
  });
}

export interface ReviseItemInput {
  income_expense_type_id: string;
  description?: string | null;
  quantity: number;
  unit_price: number;
  start_date?: string | null;
  end_date?: string | null;
}

export interface ReviseIncomeExpenseInput {
  voucherId: string;
  /** approval_version của phiếu lúc người dùng MỞ form — lệch ⇒ PT409. */
  expectedApprovalVersion: number;
  /** Chỉ các khoá máy chủ nhận (xem REVISION_FIELD_LABELS); không gửi khoá lạ. */
  patch: Record<string, unknown>;
  /** null/undefined = không đổi hạng mục. */
  items?: ReviseItemInput[] | null;
  reason?: string | null;
  idempotencyKey?: string;
  /**
   * Tắt toast THÀNH CÔNG khi màn gọi tự báo (vd hộp Duyệt sửa rồi duyệt liền).
   * Lỗi vẫn luôn báo — không được để người dùng bấm mà không biết vì sao hỏng.
   */
  silent?: boolean;
}

export async function reviseIncomeExpense(input: ReviseIncomeExpenseInput): Promise<ReviseResult> {
  const { data, error } = await supabase.rpc("revise_pending_income_expense_v1", {
    p_voucher: input.voucherId,
    p_expected_approval_version: input.expectedApprovalVersion,
    p_patch: input.patch as Json,
    p_items: input.items
      ? (input.items.map((i) => ({
          income_expense_type_id: i.income_expense_type_id,
          description: i.description ?? null,
          quantity: i.quantity,
          unit_price: i.unit_price,
          start_date: i.start_date || null,
          end_date: i.end_date || null,
        })) as Json)
      : undefined,
    p_reason: input.reason?.trim() ? input.reason.trim() : undefined,
    p_idempotency_key: input.idempotencyKey ?? newRevisionIdempotencyKey(),
  });
  if (error) throw error;
  return reviseResultSchema.parse(data);
}

export function useReviseIncomeExpense() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: reviseIncomeExpense,
    onSuccess: async (result, input) => {
      await Promise.all(VOUCHER_QUERY_KEYS.map((key) => client.invalidateQueries({ queryKey: key })));
      if (input.silent) return;
      toast.success(
        result.changed
          ? `Đã lưu thay đổi phiếu (lần sửa ${result.revision_no ?? ""}). Phiếu vẫn Chờ duyệt.`
          : "Không có gì thay đổi.",
      );
    },
    onError: (error) => {
      // Phiếu vừa bị người khác sửa/duyệt: kéo bản mới về cho mọi màn đang mở.
      if (isStaleVersionError(error)) {
        void Promise.all(VOUCHER_QUERY_KEYS.map((key) => client.invalidateQueries({ queryKey: key })));
      }
      toast.error(revisionErrorMessage(error));
    },
  });
}

export interface ApproveCheckedInput {
  voucherId: string;
  expectedApprovalVersion: number;
}

export async function approveCheckedVoucher(input: ApproveCheckedInput) {
  const { data, error } = await supabase.rpc("approve_pending_income_expense_checked_v1", {
    p_voucher: input.voucherId,
    p_expected_approval_version: input.expectedApprovalVersion,
  });
  if (error) throw error;
  return z
    .object({ id: z.string(), approved: z.boolean(), already: z.boolean().optional(), mode: z.string().optional() })
    .parse(data);
}

