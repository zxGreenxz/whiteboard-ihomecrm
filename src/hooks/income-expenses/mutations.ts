import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { addCycle, type RepeatCycle } from "@/lib/recurring";
import { isIeCreateFallbackSignal } from "@/lib/canonicalFallback";
import type {
  CreateIncomeExpenseInput,
  UpdateIncomeExpenseInput,
  QuickUpdateIncomeExpenseInput,
} from "./types";

// --- Mutation Hooks ---

/**
 * Phiếu đủ điều kiện đi đường canonical create_income_expense_v1?
 * Writer chỉ nhận: non-recurring, item có đủ start/end date, attachments là
 * URL https tuyệt đối. Ngoài phạm vi đó → đi thẳng legacy (không thử canonical
 * để khỏi ăn lỗi validation writer thành lỗi user).
 */
const isCanonicalCreateEligible = (input: CreateIncomeExpenseInput): boolean => {
  if ((input.repeat_cycle ?? "NONE") !== "NONE") return false;
  if (input.repeat_infinity) return false;
  if ((input.repeat_count ?? 0) !== 0) return false;
  if (!input.items.length) return false;
  if (input.items.some((it) => !it.start_date || !it.end_date)) return false;
  if ((input.attachments ?? []).some((url) => !/^https:\/\//.test(url))) return false;
  return true;
};

// Tạo phiếu thu/chi mới (phiếu + items)
export const useCreateIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateIncomeExpenseInput) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      // Canonical trước (phiếu thường, non-recurring): writer server-side tự
      // authorize + claim + audit hash-chain. Fallback legacy CHỈ theo tín hiệu
      // hợp lệ (chưa deploy / chưa bật / coexistence / lớp phiếu không hỗ trợ).
      if (isCanonicalCreateEligible(input)) {
        const canonical = await (supabase.rpc as any)("create_income_expense_v1", {
          p_type: input.type,
          p_name: input.name,
          p_building_id: input.building_id,
          p_room_id: input.room_id ?? null,
          p_tenant_id: input.tenant_id ?? null,
          p_contract_id: input.contract_id ?? null,
          p_payer_name: input.payer_name ?? null,
          p_receive_bank_account: input.receive_bank_account || null,
          p_receive_bank_name: input.receive_bank_name || null,
          p_account_id: input.account_id ?? null,
          p_attachments: input.attachments ?? [],
          p_business_result_accounting: input.business_result_accounting ?? null,
          p_notes: null,
          p_voucher_date: input.voucher_date,
          p_items: input.items.map((item) => ({
            income_expense_type_id: item.income_expense_type_id,
            description: item.description ?? null,
            quantity: item.quantity,
            unit_price: item.unit_price,
            start_date: item.start_date,
            end_date: item.end_date,
          })),
          p_idempotency_key: `ie-create-${crypto.randomUUID()}`,
        });
        if (!canonical.error) return canonical.data;
        if (!isIeCreateFallbackSignal(canonical.error)) {
          toast.error(canonical.error.message || "Không thể tạo phiếu thu/chi");
          throw canonical.error;
        }
      }

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";

      // 1. Insert the voucher
      const { data: voucher, error: voucherError } = await supabase
        .from("income_expenses")
        .insert({
          user_id: user.id,
          creator_name: creatorName,
          type: input.type,
          name: input.name,
          building_id: input.building_id,
          room_id: input.room_id ?? null,
          tenant_id: input.tenant_id ?? null,
          contract_id: input.contract_id ?? null,
          payer_name: input.payer_name ?? null,
          receive_bank_account: input.receive_bank_account || null,
          receive_bank_name: input.receive_bank_name || null,
          account_id: input.account_id ?? null,
          attachments: input.attachments ?? [],
          // null = tự động (DB suy theo hạng mục cọc); false/true = override tay.
          business_result_accounting: input.business_result_accounting ?? null,
          repeat_cycle: input.repeat_cycle ?? "NONE",
          repeat_infinity: !!input.repeat_infinity,
          repeat_count: input.repeat_count ?? 0,
          repeat_auto_approve: input.repeat_auto_approve !== false,
          repeat_remaining: input.repeat_infinity
            ? 0
            : Number(input.repeat_count ?? 0),
          // Phiếu gốc = kỳ #1; ngày sinh tiếp theo là kỳ kế (tránh trùng kỳ đầu).
          repeat_next_date:
            input.repeat_cycle && input.repeat_cycle !== "NONE"
              ? addCycle(input.voucher_date, input.repeat_cycle as RepeatCycle, 1)
              : null,
          voucher_date: input.voucher_date,
        })
        .select()
        .single();

      if (voucherError) {
        toast.error(voucherError.message || "Không thể tạo phiếu thu/chi");
        throw voucherError;
      }

      // 2. Insert items
      const itemsToInsert = input.items.map((item) => ({
        income_expense_id: (voucher as any).id,
        income_expense_type_id: item.income_expense_type_id,
        description: item.description ?? null,
        quantity: item.quantity,
        unit_price: item.unit_price,
        start_date: item.start_date ?? null,
        end_date: item.end_date ?? null,
      }));

      const { error: itemsError } = await supabase
        .from("income_expense_items")
        .insert(itemsToInsert);

      if (itemsError) {
        toast.error(itemsError.message || "Không thể tạo hạng mục");
        throw itemsError;
      }

      return voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating income expense:", error);
    },
  });
};

// Cập nhật phiếu thu/chi (chỉ khi UNAPPROVED)
export const useUpdateIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateIncomeExpenseInput) => {
      const { id, data } = input;

      // 1. Update the voucher (only if UNAPPROVED)
      const { data: voucher, error: voucherError } = await supabase
        .from("income_expenses")
        .update({
          type: data.type,
          name: data.name,
          building_id: data.building_id,
          room_id: data.room_id ?? null,
          tenant_id: data.tenant_id ?? null,
          contract_id: data.contract_id ?? null,
          payer_name: data.payer_name ?? null,
          receive_bank_account: data.receive_bank_account || null,
          receive_bank_name: data.receive_bank_name || null,
          account_id: data.account_id ?? null,
          attachments: data.attachments ?? [],
          business_result_accounting: data.business_result_accounting ?? null,
          voucher_date: data.voucher_date,
          // FIX: trước đây bỏ qua các trường repeat_* nên sửa "Cài đặt lặp lại"
          // không lưu (và không tắt được lặp). repeat_remaining/next_date sẽ được
          // RPC tự suy lại theo số phiếu con thực tế ở lần sinh kế tiếp.
          repeat_cycle: data.repeat_cycle ?? "NONE",
          repeat_infinity: !!data.repeat_infinity,
          repeat_count: data.repeat_count ?? 0,
          repeat_auto_approve: data.repeat_auto_approve !== false,
          repeat_remaining: data.repeat_infinity ? 0 : Number(data.repeat_count ?? 0),
          repeat_next_date:
            data.repeat_cycle && data.repeat_cycle !== "NONE"
              ? addCycle(data.voucher_date, data.repeat_cycle as RepeatCycle, 1)
              : null,
        })
        .eq("id", id)
        .select()
        .single();

      if (voucherError) {
        // Phiếu canonical (Phương án A) bất biến sau khi tạo — freeze trigger
        // trả 55000 'frozen'. Hướng dẫn đường đúng thay vì lỗi kỹ thuật.
        const frozen = (voucherError.message ?? "").includes("frozen");
        toast.error(
          frozen
            ? "Phiếu canonical không sửa được — hãy Huỷ phiếu rồi bấm Tạo bản sao"
            : voucherError.message || "Không thể cập nhật phiếu thu/chi",
        );
        throw voucherError;
      }

      // 2. Delete existing items
      const { error: deleteError } = await supabase
        .from("income_expense_items")
        .delete()
        .eq("income_expense_id", id);

      if (deleteError) {
        toast.error(deleteError.message || "Không thể xoá hạng mục cũ");
        throw deleteError;
      }

      // 3. Re-insert new items
      const itemsToInsert = data.items.map((item) => ({
        income_expense_id: id,
        income_expense_type_id: item.income_expense_type_id,
        description: item.description ?? null,
        quantity: item.quantity,
        unit_price: item.unit_price,
        start_date: item.start_date ?? null,
        end_date: item.end_date ?? null,
      }));

      const { error: itemsError } = await supabase
        .from("income_expense_items")
        .insert(itemsToInsert);

      if (itemsError) {
        toast.error(itemsError.message || "Không thể tạo hạng mục mới");
        throw itemsError;
      }

      return voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error updating income expense:", error);
    },
  });
};

export const useQuickUpdateIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: QuickUpdateIncomeExpenseInput) => {
      const { error } = await (supabase as any).rpc(
        "update_income_expense_quick",
        {
          p_id: input.id,
          p_account_id: input.account_id,
          p_attachments: input.attachments,
          p_notes: input.notes,
        }
      );
      if (error) {
        toast.error(error.message || "Không thể cập nhật phiếu");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["income-expense-batches"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error quick-updating income expense:", error);
    },
  });
};
