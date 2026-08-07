import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { differenceInMonths } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { CommissionTier } from "@/types/building";
import { isJsonObject, jsonArray } from "@/lib/jsonValue";

// =============================================
// Utils
// =============================================

/**
 * Số tháng HĐ = số tháng dương lịch trọn vẹn (date-fns differenceInMonths).
 * VD: 14/5/2026 → 31/5/2027 = 12 tháng (12 tháng tròn + 17 ngày lẻ).
 * Phần ngày lẻ không cộng thêm tháng — phù hợp cách hiểu HĐ thuê thực tế.
 */
export function calcContractMonths(startDate: string, endDate: string): number {
  if (!startDate || !endDate) return 0;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  if (end < start) return 0;
  return differenceInMonths(end, start);
}

/**
 * Tier khớp số tháng:
 *   - Trong [min, max] → trả tier đó (exact match).
 *   - Vượt max của tier cao nhất → fallback dùng tier cao nhất
 *     (HĐ dài hơn vẫn áp dụng % của mốc lớn nhất user đã cấu hình).
 *   - Dưới min của tier thấp nhất → null (HĐ quá ngắn, không trả HH).
 */
export function findMatchingTier(
  months: number,
  tiers: CommissionTier[] | null | undefined
): CommissionTier | null {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;

  const exact = tiers.find(
    (t) => months >= Number(t.min_months) && months <= Number(t.max_months)
  );
  if (exact) return exact;

  const topTier = tiers.reduce((best, t) =>
    Number(t.max_months) > Number(best.max_months) ? t : best
  );
  if (months > Number(topTier.max_months)) return topTier;

  return null;
}

// =============================================
// Prefill data hook
// =============================================

export interface CommissionPrefillData {
  contract_id: string;
  contract_number: string | null;
  signed_date: string;
  /** Ngày bắt đầu / kết thúc HĐ — hiển thị metadata trong modal HH (23/07). */
  start_date: string | null;
  end_date: string | null;
  rent_price: number;
  months: number;
  matched_tier: CommissionTier | null;
  building_id: string;
  building_name: string;
  room_id: string | null;
  room_name: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  default_account_id: string | null;
}

/** Fetch full prefill data dựa trên contract id (gọi sau khi tạo HĐ thành công). */
export const useCommissionPrefill = (contractId: string | null) => {
  return useQuery({
    queryKey: ["commission-prefill", contractId],
    enabled: !!contractId,
    queryFn: async (): Promise<CommissionPrefillData | null> => {
      if (!contractId) return null;

      const { data: contract, error } = await supabase
        .from("contracts")
        .select(
          `id, contract_number, signed_date, start_date, end_date, rent_price,
           room:rooms!contracts_room_id_fkey (
             id, name, building_id,
             building:buildings!rooms_building_id_fkey ( id, name, commission_tiers )
           ),
           contract_customers (
             customer_id, is_representative,
             customer:customers ( id, full_name )
           )`
        )
        .eq("id", contractId)
        .single();

      if (error || !contract) {
        console.error("useCommissionPrefill error:", error);
        return null;
      }

      const months = calcContractMonths(contract.start_date, contract.end_date);
      // `commission_tiers` là cột jsonb ⇒ kiểu sinh ra là Json, không phải
      // CommissionTier[]. Ép thẳng là nói dối trình biên dịch ở chỗ TÍNH TIỀN
      // HOA HỒNG: một bậc thiếu `rate_percent` sẽ thành undefined trong phép
      // nhân và cho ra NaN, hoặc tệ hơn — findMatchingTier chọn nhầm bậc và ra
      // một con số trông hợp lý nhưng sai.
      //
      // Kiểm từng phần tử thay vì khẳng định. Bậc không đủ ba trường số bị LOẠI,
      // không phải sửa chữa: một bậc hoa hồng méo là dữ liệu cần người xem, và
      // đoán hộ nó là cách biến lỗi nhập liệu thành lỗi chi tiền.
      const tiers = jsonArray({ t: contract.room?.building?.commission_tiers }, "t").filter(
        (x) =>
          isJsonObject(x) &&
          typeof x.min_months === "number" &&
          typeof x.max_months === "number" &&
          typeof x.rate_percent === "number",
        // `as unknown as` ở đây KHÁC hẳn cái ép cũ: mọi phần tử còn lại đã được
        // kiểm đủ ba trường số ngay phía trên, nên khẳng định này có bằng chứng
        // lúc chạy đứng sau. Cái ép cũ không kiểm gì cả.
      ) as unknown as CommissionTier[];
      const matched = findMatchingTier(months, tiers);

      const rep =
        contract.contract_customers?.find((c: any) => c.is_representative) ??
        contract.contract_customers?.[0] ??
        null;

      // Match account by name (cùng user_id) — fallback null nếu không có
      let defaultAccountId: string | null = null;
      const buildingName = contract.room?.building?.name as string | undefined;
      if (buildingName) {
        const { data: accounts } = await supabase
          .from("accounts")
          .select("id, name, is_default")
          .ilike("name", buildingName)
          .is("deleted_at", null)
          .order("is_default", { ascending: false });
        if (accounts && accounts.length > 0) {
          defaultAccountId = accounts[0].id;
        }
      }

      return {
        contract_id: contract.id,
        contract_number: contract.contract_number ?? null,
        signed_date: contract.signed_date,
        start_date: contract.start_date ?? null,
        end_date: contract.end_date ?? null,
        rent_price: Number(contract.rent_price ?? 0),
        months,
        matched_tier: matched,
        building_id: contract.room?.building?.id ?? "",
        building_name: contract.room?.building?.name ?? "",
        room_id: contract.room?.id ?? null,
        room_name: contract.room?.name ?? null,
        tenant_id: rep?.customer?.id ?? null,
        tenant_name: rep?.customer?.full_name ?? null,
        default_account_id: defaultAccountId,
      };
    },
  });
};

// =============================================
// Mutation: tạo phiếu chi hoa hồng
// =============================================

export interface CreateCommissionVoucherInput {
  contract_id: string;
  contract_number: string | null;
  building_id: string;
  room_id: string | null;
  tenant_id: string | null;
  account_id: string | null;
  voucher_date: string;
  /** "broker" → Hoa hồng môi giới, "sale" → Thưởng nóng Sale */
  kind: "broker" | "sale";
  amount: number;
  payer_name: string | null; // tên Đơn vị MG / tên Sale (= "ai")
  recipient_name: string | null; // tên người nhận tiền
  recipient_bank: string | null;
  recipient_account_number: string | null;
  /** Mô tả item — vd "Hoa hồng MG (50% × 6 tháng tiền phòng)" */
  item_description: string;
  /** Ảnh chứng từ riêng của phiếu (URL đã upload bucket income-expense-attachments) */
  attachments?: string[];
}

export const useCreateCommissionVoucher = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateCommissionVoucherInput) => {
      // Toàn bộ nghiệp vụ nằm trong RPC create_commission_voucher (definer):
      // kiểm quyền theo tòa, advisory lock + CHẶN TRÙNG theo (HĐ, loại),
      // resolve loại phí theo OWNER tòa (staff không cần có type seed riêng),
      // tạo voucher + item atomic, luôn UNAPPROVED (nháp — duyệt thủ công).
      // DB còn unique index uq_ie_commission_per_contract làm hàng rào cuối.
      const { data, error } = await supabase.rpc(
        "create_commission_voucher",
        {
          p_contract_id: input.contract_id,
          p_kind: input.kind,
          p_amount: input.amount,
          p_voucher_date: input.voucher_date,
          p_account_id: input.account_id,
          p_payer_name: input.payer_name,
          p_recipient_name: input.recipient_name,
          p_recipient_bank: input.recipient_bank,
          p_recipient_account: input.recipient_account_number,
          p_item_description: input.item_description,
          // p_attachments mới có ở migration 20260806090000 — types.ts chưa
          // regen nên cast; bỏ cast khi regen types
          p_attachments: input.attachments ?? [],
        } as any
      );
      if (error) {
        if ((error as any).code === "23505") {
          const label =
            input.kind === "broker" ? "hoa hồng môi giới" : "thưởng nóng Sale";
          throw new Error(
            `HĐ ${input.contract_number ?? ""} đã có phiếu ${label} — không thể chi lần 2.`
          );
        }
        throw new Error(error.message);
      }
      return data as { id: string; code: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({ queryKey: ["period-commissions"] });
      queryClient.invalidateQueries({
        queryKey: ["existing-commission-vouchers"],
      });
    },
    onError: (err: any) => {
      console.error("Error creating commission voucher:", err);
      toast.error(err?.message || "Không thể tạo phiếu chi hoa hồng");
    },
  });
};

// =============================================
// Phiếu HH đã tồn tại của 1 HĐ (chống chi lần 2 ở UI)
// =============================================

export interface ExistingCommissionVoucher {
  id: string;
  code: string | null;
  commission_kind: "broker" | "sale";
  total_amount: number;
  approval_status: string;
}

/**
 * Phiếu hoa hồng SỐNG (chưa xóa, chưa hủy) của HĐ — để modal hiện "Đã chi"
 * và disable input. Lưu ý RLS: staff có thể không thấy phiếu của người khác
 * → banner không hiện nhưng RPC/unique index vẫn chặn tạo trùng.
 */
export const useExistingCommissionVouchers = (contractId: string | null) => {
  return useQuery({
    queryKey: ["existing-commission-vouchers", contractId],
    enabled: !!contractId,
    queryFn: async (): Promise<ExistingCommissionVoucher[]> => {
      const { data, error } = await supabase
        .from("income_expenses")
        .select("id, code, commission_kind, total_amount, approval_status")
        .eq("contract_id", contractId)
        .in("commission_kind", ["broker", "sale"])
        .is("deleted_at", null)
        .neq("approval_status", "CANCELLED");
      if (error) throw error;
      return (data ?? []) as ExistingCommissionVoucher[];
    },
  });
};
