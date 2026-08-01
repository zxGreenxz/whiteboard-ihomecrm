import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type { IncomeExpenseBatchFormValues } from "@/lib/incomeExpenseValidation";
import type { ImportIncomeExpenseRow } from "./types";
import { loadIncomeExpenseAccountingClassResolver } from "./accountingClass";

// Compat gateway V2 (Stage-7b drain): RPC chưa có trong generated types cho tới
// lần regen sau forward-apply — gọi qua cast (mẫu financeV2Mutations.ts).
// Server ép birth UNAPPROVED/PENDING (import/batch hết default-APPROVED — §8).
type CompatRpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};
const compatRpc = (
  fn: string,
  args?: Record<string, unknown>,
): PromiseLike<CompatRpcResult> =>
  (supabase.rpc as unknown as (
    f: string,
    a?: Record<string, unknown>,
  ) => PromiseLike<CompatRpcResult>)(fn, args);

/**
 * Huỷ một danh sách phiếu lẫn lộn THU/CHI, mỗi loại đi ĐÚNG cửa của nó.
 *
 * ie_compat_cancel_v2 từ chối phiếu ĐÃ GHI SỔ ("dùng reversal, không hủy trực
 * tiếp"). Từ Đợt B, phiếu THU tự ghi sổ ngay khi tạo ⇒ mọi đợt có phiếu thu sẽ
 * hỏng nếu vẫn đẩy tất cả vào compat. Phiếu THU đi cửa riêng
 * cancel_income_voucher_v1 (tự đảo bút toán, tự mở lại nợ hoá đơn); phiếu CHI
 * giữ nguyên đường cũ.
 *
 * Trả về số phiếu đã huỷ + danh sách lỗi theo từng phiếu để caller báo cho
 * đúng, thay vì hỏng cả mẻ chỉ vì một phiếu.
 */
async function cancelVouchersSplitByType(
  vouchers: { id: string; type?: string | null }[],
  reason: string,
): Promise<{ cancelled: number; failures: { id: string; message: string }[] }> {
  const incomes = vouchers.filter((v) => v.type === "INCOME");
  const others = vouchers.filter((v) => v.type !== "INCOME");
  const failures: { id: string; message: string }[] = [];
  let cancelled = 0;

  if (others.length > 0) {
    const { data, error } = await compatRpc("ie_compat_cancel_v2", {
      p_ids: others.map((v) => v.id),
      p_reason: reason,
    });
    if (error) {
      for (const v of others) failures.push({ id: v.id, message: error.message ?? "Không huỷ được" });
    } else {
      cancelled += (data as { cancelled?: number } | null)?.cancelled ?? others.length;
    }
  }

  // Cửa phiếu thu nhận TỪNG phiếu (mỗi phiếu là một transaction atomic ở
  // server) — lỗi một phiếu không kéo đổ những phiếu đã huỷ xong.
  for (const v of incomes) {
    const { error } = await compatRpc("cancel_income_voucher_v1", {
      p_voucher: v.id,
      p_reason: reason,
    });
    if (error) failures.push({ id: v.id, message: error.message ?? "Không huỷ được" });
    else cancelled += 1;
  }

  return { cancelled, failures };
}

// Import phiếu thu/chi hàng loạt từ Excel
export const useImportIncomeExpenses = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      rows: ImportIncomeExpenseRow[]
    ): Promise<{
      successCount: number;
      failedCount: number;
      errors: Array<{ row: number; message: string }>;
    }> => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      let successCount = 0;
      let failedCount = 0;
      const errors: Array<{ row: number; message: string }> = [];
      const accountingClassFor =
        await loadIncomeExpenseAccountingClassResolver(
          rows.map((row) => row.income_expense_type_id),
        );

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          // organization_id do server suy (ie_compat_insert_v2 SECURITY DEFINER,
          // strip field client gửi) — không đọc buildings ở client vì RLS chỉ mở
          // cho ai có scope buildings.view, còn Thu/Chi cho phép all_buildings.
          // Phiếu + item trong MỘT call server-side (birth UNAPPROVED — §8).
          const { error: compatError } = await compatRpc("ie_compat_insert_v2", {
            p_row: {
              user_id: user.id,
              type: row.type,
              name: row.name,
              building_id: row.building_id,
              voucher_date: row.voucher_date,
            },
            p_items: [
              {
                income_expense_type_id: row.income_expense_type_id,
                accounting_class: accountingClassFor(
                  row.income_expense_type_id,
                ),
                description: row.item_name,
                quantity: 1,
                unit_price: row.amount,
              },
            ],
          });

          if (compatError) {
            failedCount++;
            errors.push({ row: i + 1, message: compatError.message ?? "Lỗi không xác định" });
            continue;
          }

          successCount++;
        } catch (err: any) {
          failedCount++;
          errors.push({ row: i + 1, message: err.message || "Lỗi không xác định" });
        }
      }

      return { successCount, failedCount, errors };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      if (result.successCount > 0) {
        toast.success("Dữ liệu đã được TẠO thành công");
      }
      if (result.failedCount > 0 && result.successCount === 0) {
        toast.error(`Tất cả ${result.failedCount} phiếu đều lỗi`);
      }
    },
    onError: (error) => {
      console.error("Error importing income expenses:", error);
      toast.error("Không thể nhập dữ liệu từ Excel");
    },
  });
};

// Tạo phiếu tổng = INSERT 1 batch + N phiếu con + N junction + N items.
export const useCreateIncomeExpenseBatch = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: IncomeExpenseBatchFormValues) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";
      const accountingClassFor =
        await loadIncomeExpenseAccountingClassResolver(
          input.items.map((item) => item.income_expense_type_id),
        );

      // 1. INSERT batch metadata
      const { data: batch, error: batchError } = await supabase
        .from("income_expense_batches")
        .insert({
          user_id: user.id,
          name: input.shared_name,
          type: input.type,
          payer_name: input.payer_name ?? null,
          attachments: input.attachments ?? [],
          notes: input.notes ?? null,
        })
        .select()
        .single();

      if (batchError || !batch) {
        toast.error(batchError?.message || "Không thể tạo phiếu tổng");
        throw batchError;
      }

      // 2. Tạo N phiếu con qua ie_compat_insert_v2 (phiếu + item atomic mỗi
      //    call, birth UNAPPROVED — §8). Tạo TỪNG phiếu để giữ thứ tự rõ ràng
      //    (tương ứng với items input). Nếu lỗi ở giữa: rollback bằng cách xoá
      //    batch (CASCADE xoá junction) + huỷ phiếu con đã tạo.
      // Mang theo `type`: rollback phải biết phiếu nào đi cửa THU, phiếu nào đi
      // đường compat cũ (cả đợt cùng một type nên gán thẳng từ input).
      const childVouchers: { id: string; type?: string | null }[] = [];
      try {
        for (const item of input.items) {
          const { data: created, error: voucherError } = await compatRpc(
            "ie_compat_insert_v2",
            {
              p_row: {
                user_id: user.id,
                creator_name: creatorName,
                type: input.type,
                name: `${input.shared_name} - ${item.type_name ?? ""}`.trim(),
                building_id: item.building_id,
                room_id: item.room_id ?? null,
                account_id: input.account_id,
                payer_name: input.payer_name ?? null,
                attachments: input.attachments ?? [],
                business_result_accounting: input.business_result_accounting ?? null,
                voucher_date: input.voucher_date,
                repeat_cycle: "NONE",
                repeat_infinity: false,
                repeat_count: 0,
                repeat_remaining: 0,
              },
              p_items: [
                {
                  income_expense_type_id: item.income_expense_type_id,
                  accounting_class: accountingClassFor(item.income_expense_type_id),
                  description: item.description ?? null,
                  quantity: item.quantity,
                  unit_price: item.unit_price,
                  start_date: item.start_date ?? null,
                  end_date: item.end_date ?? null,
                },
              ],
            },
          );

          const voucherId = (created as { id?: string } | null)?.id;
          if (voucherError || !voucherId) {
            throw voucherError ?? new Error("Không thể tạo phiếu con");
          }
          childVouchers.push({ id: voucherId, type: input.type });
        }

        // 3. INSERT junction rows (bảng batch_items — ngoài phạm vi drain).
        const linkRows = childVouchers.map((v) => ({
          batch_id: (batch as any).id,
          income_expense_id: v.id,
        }));
        const { error: linkError } = await supabase
          .from("income_expense_batch_items")
          .insert(linkRows);
        if (linkError) throw linkError;
      } catch (err: any) {
        // Best-effort rollback: xoá batch (CASCADE xoá junction);
        // Phiếu con đã tạo sẽ thành phiếu lẻ standalone — huỷ chúng qua RPC
        // (Stage-7: client không còn UPDATE/DELETE trực tiếp income_expenses).
        if (childVouchers.length > 0) {
          // Tách THU/CHI: phiếu thu vừa tạo nay đã GHI SỔ ngay (Đợt B) nên
          // đường compat sẽ từ chối, để lại phiếu mồ côi sống nhăn.
          await cancelVouchersSplitByType(childVouchers, "Rollback tạo phiếu tổng lỗi");
        }
        await supabase
          .from("income_expense_batches")
          .delete()
          .eq("id", (batch as any).id);
        toast.error(err?.message || "Không thể tạo phiếu tổng");
        throw err;
      }

      return { batch, voucherCount: childVouchers.length };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success(`Đã tạo ${result.voucherCount} phiếu trong 1 đợt`);
    },
    onError: (error) => {
      console.error("Error creating income expense batch:", error);
    },
  });
};

// Huỷ tất cả phiếu con của 1 batch (1 click)
export const useCancelIncomeExpenseBatch = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (batchId: string) => {
      // 1. Lấy danh sách voucher_id thuộc batch
      const { data: links, error: linkError } = await supabase
        .from("income_expense_batch_items")
        .select("income_expense_id")
        .eq("batch_id", batchId);
      if (linkError) {
        toast.error(linkError.message || "Không thể đọc danh sách phiếu trong đợt");
        throw linkError;
      }
      const ids = ((links ?? []) as any[]).map((l) => l.income_expense_id);
      if (ids.length === 0) return { count: 0 };

      // 2. Đọc (read-only) các phiếu còn hiệu lực để biết payment_id cần
      //    cascade xoá; sau đó huỷ qua ie_compat_cancel_v2 (Stage-7: client
      //    không còn UPDATE trực tiếp income_expenses). Phiếu đã POSTED (ghi
      //    sổ V2) sẽ bị server từ chối — dùng reversal thay vì huỷ.
      const { data: vouchers, error: readError } = await supabase
        .from("income_expenses")
        .select("id, type, payment_id")
        .in("id", ids)
        .neq("approval_status", "CANCELLED");
      if (readError) {
        toast.error(readError.message || "Không thể đọc phiếu trong đợt");
        throw readError;
      }
      const activeVouchers = (vouchers ?? []) as any[];
      if (activeVouchers.length === 0) return { count: 0 };

      const { cancelled, failures } = await cancelVouchersSplitByType(
        activeVouchers,
        "Huỷ cả đợt phiếu",
      );
      if (failures.length > 0 && cancelled === 0) {
        toast.error(failures[0].message || "Không thể huỷ phiếu trong đợt");
        throw new Error(failures[0].message);
      }
      if (failures.length > 0) {
        toast.warning(
          `Đã huỷ ${cancelled} phiếu; ${failures.length} phiếu không huỷ được: ${failures[0].message}`,
        );
      }

      // Phiếu THU đã được server gỡ khoản thanh toán bên trong
      // cancel_income_voucher_v1 (đánh dấu reversed_at, hoá đơn tự mở lại nợ).
      // Chỉ còn phiếu CHI đường cũ mới cần client dọn payments hộ.
      const paymentIdsToDelete = activeVouchers
        .filter((v) => v.type !== "INCOME" && v.payment_id)
        .map((v) => v.payment_id);
      if (paymentIdsToDelete.length > 0) {
        const { error: payErr } = await supabase
          .from("payments")
          .delete()
          .in("id", paymentIdsToDelete);
        if (payErr) {
          toast.error(payErr.message || "Không thể rollback thanh toán hoá đơn");
          throw payErr;
        }
      }

      return { count: cancelled };
    },
    onSuccess: ({ count }) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice-statistics"] });
      queryClient.invalidateQueries({ queryKey: ["utility-payments"] });
      toast.success(
        count === 0
          ? "Không còn phiếu nào trong đợt cần huỷ"
          : `Đã huỷ ${count} phiếu trong đợt`
      );
    },
    onError: (error) => {
      console.error("Error cancelling income expense batch:", error);
    },
  });
};

// Đổi sổ quỹ (account_id) đồng loạt cho tất cả phiếu con của 1 batch.
// Dùng cho UI "Sửa sổ quỹ ở phiếu tổng" — chỉ apply khi mọi phiếu con
// đang cùng 1 sổ quỹ (frontend kiểm tra trước khi gọi).
export const useUpdateBatchAccount = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { batchId: string; accountId: string }) => {
      const { batchId, accountId } = input;

      const { data: links, error: linkError } = await supabase
        .from("income_expense_batch_items")
        .select("income_expense_id")
        .eq("batch_id", batchId);
      if (linkError) {
        toast.error(linkError.message || "Không đọc được danh sách phiếu");
        throw linkError;
      }
      const ids = ((links ?? []) as any[]).map((l) => l.income_expense_id);
      if (ids.length === 0) return { count: 0 };

      // Stage-7 drain: đổi sổ quỹ từng phiếu qua ie_compat_update_pending_v2
      // (account_id là trục tiền — server chỉ cho sửa khi phiếu còn Chờ duyệt
      // và chưa ghi sổ; phiếu đã duyệt/POSTED sẽ bị từ chối 55000).
      let count = 0;
      for (const id of ids) {
        const { error } = await compatRpc("ie_compat_update_pending_v2", {
          p_id: id,
          p_patch: { account_id: accountId },
          p_items: null,
        });
        if (error) {
          toast.error(error.message || "Không cập nhật được sổ quỹ");
          throw error;
        }
        count++;
      }

      return { count };
    },
    onSuccess: ({ count }) => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success(`Đã đổi sổ quỹ cho ${count} phiếu trong đợt`);
    },
    onError: (error) => {
      console.error("Error updating batch account:", error);
    },
  });
};
