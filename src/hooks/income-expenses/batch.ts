import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type { IncomeExpenseBatchFormValues } from "@/lib/incomeExpenseValidation";
import { requireBuildingOrganizationId } from "@/lib/buildingOrganization";
import type { ImportIncomeExpenseRow } from "./types";
import { loadIncomeExpenseAccountingClassResolver } from "./accountingClass";

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
          const organizationId = await requireBuildingOrganizationId(row.building_id);
          // 1. Create the voucher
          const { data: voucher, error: voucherError } = await supabase
            .from("income_expenses")
            .insert({
              user_id: user.id,
              type: row.type,
              name: row.name,
              building_id: row.building_id,
              organization_id: organizationId,
              voucher_date: row.voucher_date,
            })
            .select()
            .single();

          if (voucherError) {
            failedCount++;
            errors.push({ row: i + 1, message: voucherError.message });
            continue;
          }

          // 2. Create the item
          const { error: itemError } = await supabase
            .from("income_expense_items")
            .insert({
              income_expense_id: (voucher as any).id,
              income_expense_type_id: row.income_expense_type_id,
              accounting_class: accountingClassFor(
                row.income_expense_type_id,
              ),
              description: row.item_name,
              quantity: 1,
              unit_price: row.amount,
            });

          if (itemError) {
            failedCount++;
            errors.push({ row: i + 1, message: itemError.message });
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

      // 2. INSERT N phiếu con (denormalize metadata chung).
      //    Insert TỪNG phiếu để giữ thứ tự rõ ràng (tương ứng với items input).
      //    Nếu lỗi ở giữa: rollback bằng cách xoá batch (CASCADE xoá junction và batch_items).
      const childVouchers: any[] = [];
      try {
        for (const item of input.items) {
          const organizationId = await requireBuildingOrganizationId(item.building_id);
          const { data: voucher, error: voucherError } = await supabase
            .from("income_expenses")
            .insert({
              user_id: user.id,
              creator_name: creatorName,
              type: input.type,
              name: `${input.shared_name} - ${item.type_name ?? ""}`.trim(),
              building_id: item.building_id,
              organization_id: organizationId,
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
            })
            .select()
            .single();

          if (voucherError || !voucher) {
            throw voucherError ?? new Error("Không thể tạo phiếu con");
          }
          childVouchers.push(voucher);
        }

        // 3. INSERT items (1 item / phiếu vì mỗi hạng mục = 1 phiếu)
        const itemRows = input.items.map((item, idx) => ({
          income_expense_id: childVouchers[idx].id,
          income_expense_type_id: item.income_expense_type_id,
          accounting_class: accountingClassFor(item.income_expense_type_id),
          description: item.description ?? null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          start_date: item.start_date ?? null,
          end_date: item.end_date ?? null,
        }));
        const { error: itemsError } = await supabase
          .from("income_expense_items")
          .insert(itemRows);
        if (itemsError) throw itemsError;

        // 4. INSERT junction rows
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
        // Phiếu con đã insert sẽ thành phiếu lẻ standalone — soft-delete chúng.
        if (childVouchers.length > 0) {
          const ids = childVouchers.map((v) => v.id);
          await supabase
            .from("income_expenses")
            .update({ deleted_at: new Date().toISOString() })
            .in("id", ids);
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

      // 2. UPDATE chuyển CANCELLED (chỉ với phiếu đang APPROVED), trả về cả payment_id
      //    để cascade xoá payment hoá đơn tương ứng (nếu có).
      const { data, error } = await supabase
        .from("income_expenses")
        .update({ approval_status: "CANCELLED" })
        .in("id", ids)
        .eq("approval_status", "APPROVED")
        .select("id, type, payment_id");
      if (error) {
        toast.error(error.message || "Không thể huỷ phiếu trong đợt");
        throw error;
      }

      const paymentIdsToDelete = ((data ?? []) as any[])
        .filter((v) => v.type === "INCOME" && v.payment_id)
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

      return { count: (data ?? []).length };
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

      const { data, error } = await supabase
        .from("income_expenses")
        .update({ account_id: accountId })
        .in("id", ids)
        .select("id");
      if (error) {
        toast.error(error.message || "Không cập nhật được sổ quỹ");
        throw error;
      }

      return { count: (data ?? []).length };
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
