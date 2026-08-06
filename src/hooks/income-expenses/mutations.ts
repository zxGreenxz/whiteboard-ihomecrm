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
import { loadIncomeExpenseAccountingClassResolver } from "./accountingClass";

// --- Mutation Hooks ---

// Compat gateway V2 (Stage-7b drain): các RPC chưa có trong generated types
// cho tới lần regen sau forward-apply — gọi qua cast (mẫu financeV2Mutations.ts).
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
 * Phiếu đủ điều kiện đi đường canonical create_income_expense_v1?
 * Writer chỉ nhận: non-recurring, item có đủ start/end date, attachments là
 * URL https tuyệt đối. Ngoài phạm vi đó → đi thẳng ie_compat_insert_v2 (không
 * thử canonical để khỏi ăn lỗi validation writer thành lỗi user).
 */
/**
 * ĐÚNG hai thông báo quyền-sổ mà create_income_expense_v1 raise (42501) và
 * compat V2 xử lý được (v1 chưa biết KNOWER). Mọi 42501 khác của v1 — hạng mục
 * không thuộc tổ chức, phòng/hợp đồng lệch toà, mất quyền tạo trên toà, hết tư
 * cách thành viên — là lỗi thật, phải hiện cho người dùng thấy.
 */
const V1_CASHBOOK_FALLBACK_MESSAGE =
  /(Không có quyền sử dụng sổ quỹ này|Quyền sử dụng sổ quỹ đã bị thu hồi)/;

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
      // authorize + claim + audit hash-chain. KHÔNG còn raw-INSERT fallback
      // (Stage-7 drain): tín hiệu hợp lệ (chưa deploy / chưa bật / lớp phiếu
      // không hỗ trợ 0A000) → ie_compat_insert_v2 (server ép birth UNAPPROVED);
      // lỗi khác (kể cả 42501 quyền thật) → throw.
      if (isCanonicalCreateEligible(input)) {
        const canonical = await supabase.rpc("create_income_expense_v1", {
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
        // Fallback hợp lệ: (a) tín hiệu route/lớp phiếu chuẩn, HOẶC (b) ĐÚNG hai
        // lỗi quyền-sổ của v1 — writer v1 chỉ biết CUSTODIAN/OPERATOR (legacy
        // accounts.user_id + account_shared_users), chưa biết KNOWER (V2).
        // Compat RPC re-check §9.2 server-side (CUSTODIAN thu+chi, KNOWER chỉ thu)
        // nên đây KHÔNG phải bypass quyền.
        //
        // GOTCHA án lệ 27/07/2026: điều kiện cũ là `code === '42501' ||
        // /sổ quỹ|Quyền/i.test(msg)` — nuốt MỌI lỗi 42501 của v1, kể cả lỗi DỮ
        // LIỆU. Hạng mục tạo tay bị thiếu organization_id làm v1 raise 42501
        // "Loại hạng mục 1 không thuộc tổ chức hoặc sai chiều thu/chi"; FE nuốt
        // im rồi rơi sang compat (ép UNAPPROVED, KHÔNG chạy thang ngưỡng) nên
        // phiếu chi 250k < ngưỡng 300k vẫn nằm "Chờ duyệt" mà không báo gì.
        // canonicalFallback.ts đã ghi rõ: 42501 là từ chối THẬT, phải nổi lên.
        const msg = canonical.error.message ?? "";
        const v1CashbookPermission =
          canonical.error.code === "42501" && V1_CASHBOOK_FALLBACK_MESSAGE.test(msg);
        if (!isIeCreateFallbackSignal(canonical.error) && !v1CashbookPermission) {
          toast.error(msg || "Không thể tạo phiếu thu/chi");
          throw canonical.error;
        }
      }

      // Đường compat V2 (thay raw-INSERT cũ): server strip field server-owned,
      // ép approval_status=UNAPPROVED/review_state=PENDING, stamp maker.
      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";
      // KHÔNG đọc buildings.organization_id ở client: RLS `buildings_select_rbac`
      // chỉ mở cho ai có scope `buildings.view` trên toà đó, còn màn Thu/Chi cố ý
      // cho chọn MỌI toà khi có `income_expenses.all_buildings` (ie_form_buildings).
      // Người chỉ có all_buildings sẽ đọc buildings ra 0 dòng → trước đây văng
      // "Tòa nhà chưa được gắn tổ chức" dù server cho phép tạo. ie_compat_insert_v2
      // là SECURITY DEFINER và tự suy organization_id (accounts → buildings →
      // membership), đồng thời STRIP organization_id do client gửi.
      const accountingClassFor =
        await loadIncomeExpenseAccountingClassResolver(
          input.items.map((item) => item.income_expense_type_id),
        );

      const compat = await compatRpc("ie_compat_insert_v2", {
        p_row: {
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
        },
        p_items: input.items.map((item) => ({
          income_expense_type_id: item.income_expense_type_id,
          accounting_class: accountingClassFor(item.income_expense_type_id),
          description: item.description ?? null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          start_date: item.start_date ?? null,
          end_date: item.end_date ?? null,
        })),
      });

      if (compat.error) {
        toast.error(compat.error.message || "Không thể tạo phiếu thu/chi");
        throw compat.error;
      }

      return compat.data;
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

// Cập nhật phiếu thu/chi (trục tiền chỉ khi UNAPPROVED — server enforce).
// Stage-7 drain: MỘT call ie_compat_update_pending_v2 (patch + items) thay cho
// 3 request cũ (update header + delete items + re-insert items). Server chỉ
// nhận field whitelist (trục tiền khi pending, metadata khi chưa huỷ); field
// ngoài whitelist bị bỏ qua im lặng.
export const useUpdateIncomeExpense = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateIncomeExpenseInput) => {
      const { id, data } = input;
      const accountingClassFor =
        await loadIncomeExpenseAccountingClassResolver(
          data.items.map((item) => item.income_expense_type_id),
        );

      const compat = await compatRpc("ie_compat_update_pending_v2", {
        p_id: id,
        p_patch: {
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
          repeat_cycle: data.repeat_cycle ?? "NONE",
          repeat_infinity: !!data.repeat_infinity,
          repeat_count: data.repeat_count ?? 0,
          repeat_auto_approve: data.repeat_auto_approve !== false,
          repeat_remaining: data.repeat_infinity ? 0 : Number(data.repeat_count ?? 0),
          repeat_next_date:
            data.repeat_cycle && data.repeat_cycle !== "NONE"
              ? addCycle(data.voucher_date, data.repeat_cycle as RepeatCycle, 1)
              : null,
        },
        p_items: data.items.map((item) => ({
          income_expense_type_id: item.income_expense_type_id,
          accounting_class: accountingClassFor(item.income_expense_type_id),
          description: item.description ?? null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          start_date: item.start_date ?? null,
          end_date: item.end_date ?? null,
        })),
      });

      if (compat.error) {
        // Phiếu canonical (Phương án A) bất biến sau khi tạo — freeze trigger
        // trả 55000 'frozen'. Hướng dẫn đường đúng thay vì lỗi kỹ thuật.
        const frozen = (compat.error.message ?? "").includes("frozen");
        toast.error(
          frozen
            ? "Phiếu canonical không sửa được — hãy Huỷ phiếu rồi bấm Tạo bản sao"
            : compat.error.message || "Không thể cập nhật phiếu thu/chi",
        );
        throw compat.error;
      }

      return compat.data;
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
      const { error } = await supabase.rpc(
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
