import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { CommissionTier } from "@/types/building";

// =============================================
// Utils
// =============================================

/** Số tháng HĐ = round((end - start) / 30 ngày) — tính chính xác theo spec user */
export function calcContractMonths(startDate: string, endDate: string): number {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  const days = (end - start) / 86400000;
  return Math.round(days / 30);
}

/** Tier khớp số tháng [min, max]; trả null nếu không khớp */
export function findMatchingTier(
  months: number,
  tiers: CommissionTier[] | null | undefined
): CommissionTier | null {
  if (!Array.isArray(tiers)) return null;
  return (
    tiers.find(
      (t) => months >= Number(t.min_months) && months <= Number(t.max_months)
    ) ?? null
  );
}

// =============================================
// Prefill data hook
// =============================================

export interface CommissionPrefillData {
  contract_id: string;
  contract_number: string | null;
  signed_date: string;
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

      const { data: contract, error } = await (supabase as any)
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
      const tiers = (contract.room?.building?.commission_tiers ??
        []) as CommissionTier[];
      const matched = findMatchingTier(months, tiers);

      const rep =
        contract.contract_customers?.find((c: any) => c.is_representative) ??
        contract.contract_customers?.[0] ??
        null;

      // Match account by name (cùng user_id) — fallback null nếu không có
      let defaultAccountId: string | null = null;
      const buildingName = contract.room?.building?.name as string | undefined;
      if (buildingName) {
        const { data: accounts } = await (supabase as any)
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
}

export const useCreateCommissionVoucher = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateCommissionVoucherInput) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Chưa đăng nhập");

      // Tìm income_expense_type_id theo tên + user_id
      const typeName =
        input.kind === "broker" ? "Hoa hồng môi giới" : "Thưởng nóng Sale";
      const { data: typeRow, error: typeErr } = await supabase
        .from("income_expense_types" as any)
        .select("id")
        .eq("user_id", user.id)
        .eq("name", typeName)
        .eq("type", "expense")
        .maybeSingle();
      if (typeErr) throw typeErr;
      if (!typeRow) {
        throw new Error(
          `Không tìm thấy loại "${typeName}" trong danh mục thu chi. Vui lòng liên hệ admin.`
        );
      }

      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string =
        meta.full_name || meta.name || user.email || "Người dùng";

      const baseName =
        input.kind === "broker"
          ? `Hoa hồng môi giới HĐ ${input.contract_number ?? ""}`.trim()
          : `Thưởng nóng Sale HĐ ${input.contract_number ?? ""}`.trim();

      // Tạo voucher (mặc định APPROVED — workflow approval đã loại bỏ ở migration
      // 20260426000002. User có thể CANCEL nếu sai/không cần.)
      // tenant_id KHÔNG truyền từ customer.id vì income_expenses.tenant_id FK →
      // bảng `tenants` (legacy), khác với `customers` đang dùng cho HĐ. Customer
      // info được link gián tiếp qua contract_id.
      const { data: voucher, error: voucherErr } = await supabase
        .from("income_expenses" as any)
        .insert({
          user_id: user.id,
          creator_name: creatorName,
          type: "EXPENSE",
          name: baseName,
          building_id: input.building_id,
          room_id: input.room_id,
          tenant_id: null,
          contract_id: input.contract_id,
          voucher_date: input.voucher_date,
          account_id: input.account_id,
          payer_name: input.payer_name,
          receive_bank_name: input.recipient_bank,
          receive_bank_account: input.recipient_account_number,
          notes: input.recipient_name
            ? `Người nhận: ${input.recipient_name}`
            : null,
          attachments: [],
          business_result_accounting: false,
          repeat_cycle: "NONE",
          repeat_infinity: false,
          repeat_count: 0,
          repeat_remaining: 0,
        })
        .select()
        .single();
      if (voucherErr) throw voucherErr;

      // Insert item
      const { error: itemErr } = await supabase
        .from("income_expense_items" as any)
        .insert({
          income_expense_id: (voucher as any).id,
          income_expense_type_id: (typeRow as any).id,
          description: input.item_description,
          quantity: 1,
          unit_price: input.amount,
          start_date: input.voucher_date,
          end_date: input.voucher_date,
        });
      if (itemErr) throw itemErr;

      return voucher;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
    },
    onError: (err: any) => {
      console.error("Error creating commission voucher:", err);
      toast.error(err?.message || "Không thể tạo phiếu chi hoa hồng");
    },
  });
};
