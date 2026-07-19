import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { isCanonicalFallbackSignal } from "@/lib/canonicalFallback";
import { toast } from "sonner";
import type {
  CreateProfitDistributionInput,
  CreateManagerSalaryPayoutInput,
} from "./types";

export const useCreateProfitDistribution = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateProfitDistributionInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      // Canonical distribute_shareholder_profit_v1: server-side idempotency (vá
      // double-submit) + qua engine duyệt (PENDING_APPROVAL). Flag OFF hiện tại →
      // "chưa bật" → fallback legacy (tạo phiếu APPROVED-ngay như cũ, 0 đổi UX).
      const canonical = await (supabase.rpc as any)("distribute_shareholder_profit_v1", {
        p_shareholder_id: input.shareholder_id,
        p_amount: input.amount,
        p_account_id: input.account_id,
        p_voucher_date: input.voucher_date,
        p_note: input.note ?? null,
        p_idempotency_key: `profit-dist-${crypto.randomUUID()}`,
      });
      if (!canonical.error) return canonical.data;
      if (!isCanonicalFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể tạo phiếu chia lợi nhuận");
        throw canonical.error;
      }

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";

      // 1) Toà chung hệ thống (toà ảo — hiện là "Kho Văn Phòng Chung").
      //    RLS tự cắt theo tenant; chỉ còn 1 toà ảo non-deleted nên không mơ hồ.
      const { data: chung, error: bErr } = await (supabase
        .from("buildings")
        .select("id") as any)
        .eq("is_virtual", true)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (bErr) throw bErr;
      if (!chung)
        throw new Error("Chưa có toà chung để hạch toán phiếu chia lợi nhuận");

      // 2) Hạng mục "Chia lợi nhuận cổ đông" (tạo nếu thiếu)
      let typeId: string;
      const { data: t } = await (supabase
        .from("income_expense_types")
        .select("id") as any)
        .eq("user_id", user.id)
        .eq("type", "expense")
        .eq("name", "Chia lợi nhuận cổ đông")
        .limit(1)
        .maybeSingle();
      if (t?.id) {
        typeId = t.id;
      } else {
        const { data: created, error: ctErr } = await supabase
          .from("income_expense_types")
          .insert({
            user_id: user.id,
            name: "Chia lợi nhuận cổ đông",
            type: "expense",
            category: "Chia lợi nhuận",
            is_default: false,
            is_deposit: false,
          })
          .select("id")
          .single();
        if (ctErr) throw ctErr;
        typeId = (created as any).id;
      }

      // 3) Phiếu chi (không hạch toán KQKD)
      const name =
        input.note?.trim() ||
        `Chia lợi nhuận: ${input.shareholder_name ?? ""}`.trim() ||
        "Chia lợi nhuận cổ đông";
      const { data: voucher, error: vErr } = await supabase
        .from("income_expenses")
        .insert({
          user_id: user.id,
          creator_name: creatorName,
          type: "EXPENSE",
          name,
          // t5_24: chia lợi nhuận = hạng mục đặc biệt → fallback legacy cũng
          // phải sinh NHÁP chờ duyệt (DB default là APPROVED nên set tường minh).
          approval_status: "UNAPPROVED",
          building_id: (chung as any).id,
          account_id: input.account_id,
          shareholder_id: input.shareholder_id,
          business_result_accounting: false,
          attachments: [],
          repeat_cycle: "NONE",
          repeat_infinity: false,
          repeat_count: 0,
          repeat_remaining: 0,
          voucher_date: input.voucher_date,
        })
        .select()
        .single();
      if (vErr) {
        toast.error(vErr.message || "Không thể tạo phiếu chia lợi nhuận");
        throw vErr;
      }

      // 4) 1 item → trigger tính total_amount = amount
      const { error: itErr } = await supabase
        .from("income_expense_items")
        .insert({
          income_expense_id: (voucher as any).id,
          income_expense_type_id: typeId,
          description: input.note ?? null,
          quantity: 1,
          unit_price: input.amount,
          start_date: input.voucher_date,
          end_date: input.voucher_date,
        });
      if (itErr) {
        toast.error(itErr.message || "Không thể tạo hạng mục");
        throw itErr;
      }

      return voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["shareholder-distributions"] });
      toast.success("Đã ghi phiếu chia lợi nhuận");
    },
    onError: (error) => {
      console.error("Error creating profit distribution:", error);
    },
  });
};

export const useCreateManagerSalaryPayout = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateManagerSalaryPayoutInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");

      // Canonical manager_salary_payout_v1 (quyền shareholder_profit.pay_manager,
      // qua engine duyệt); flag OFF → "chưa bật" → fallback legacy.
      const canonical = await (supabase.rpc as any)("manager_salary_payout_v1", {
        p_manager_id: input.manager_id,
        p_amount: input.amount,
        p_account_id: input.account_id,
        p_voucher_date: input.voucher_date,
        p_note: input.note ?? null,
        p_idempotency_key: `mgr-payout-${crypto.randomUUID()}`,
      });
      if (!canonical.error) return canonical.data;
      if (!isCanonicalFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể tạo phiếu lương điều hành");
        throw canonical.error;
      }

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";

      // 1) Toà chung hệ thống (toà ảo — hiện là "Kho Văn Phòng Chung").
      //    RLS tự cắt theo tenant; chỉ còn 1 toà ảo non-deleted nên không mơ hồ.
      const { data: chung, error: bErr } = await (supabase
        .from("buildings")
        .select("id") as any)
        .eq("is_virtual", true)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (bErr) throw bErr;
      if (!chung)
        throw new Error("Chưa có toà chung để hạch toán phiếu lương điều hành");

      // 2) Hạng mục "Lương điều hành" (tạo nếu thiếu)
      let typeId: string;
      const { data: t } = await (supabase
        .from("income_expense_types")
        .select("id") as any)
        .eq("user_id", user.id)
        .eq("type", "expense")
        .eq("name", "Lương điều hành")
        .limit(1)
        .maybeSingle();
      if (t?.id) {
        typeId = t.id;
      } else {
        const { data: created, error: ctErr } = await supabase
          .from("income_expense_types")
          .insert({
            user_id: user.id,
            name: "Lương điều hành",
            type: "expense",
            category: "Chia lợi nhuận",
            is_default: false,
            is_deposit: false,
          })
          .select("id")
          .single();
        if (ctErr) throw ctErr;
        typeId = (created as any).id;
      }

      // 3) Phiếu chi (không hạch toán KQKD)
      const name =
        input.note?.trim() ||
        `Lương điều hành: ${input.manager_name ?? ""}`.trim() ||
        "Lương điều hành";
      const { data: voucher, error: vErr } = await supabase
        .from("income_expenses")
        .insert({
          user_id: user.id,
          creator_name: creatorName,
          type: "EXPENSE",
          name,
          // t5_24: lương điều hành = hạng mục đặc biệt → fallback legacy cũng
          // phải sinh NHÁP chờ duyệt (DB default là APPROVED nên set tường minh).
          approval_status: "UNAPPROVED",
          building_id: (chung as any).id,
          account_id: input.account_id,
          profit_manager_id: input.manager_id,
          business_result_accounting: false,
          attachments: [],
          repeat_cycle: "NONE",
          repeat_infinity: false,
          repeat_count: 0,
          repeat_remaining: 0,
          voucher_date: input.voucher_date,
        })
        .select()
        .single();
      if (vErr) {
        toast.error(vErr.message || "Không thể tạo phiếu lương điều hành");
        throw vErr;
      }

      // 4) 1 item → trigger tính total_amount = amount
      const { error: itErr } = await supabase
        .from("income_expense_items")
        .insert({
          income_expense_id: (voucher as any).id,
          income_expense_type_id: typeId,
          description: input.note ?? null,
          quantity: 1,
          unit_price: input.amount,
          start_date: input.voucher_date,
          end_date: input.voucher_date,
        });
      if (itErr) {
        toast.error(itErr.message || "Không thể tạo hạng mục");
        throw itErr;
      }

      return voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["manager-salary-payouts"] });
      toast.success("Đã ghi phiếu lương điều hành");
    },
    onError: (error) => {
      console.error("Error creating manager salary payout:", error);
    },
  });
};
