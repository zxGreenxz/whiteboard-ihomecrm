import {financialReadNumber,financialReadRows} from '@/lib/financialReadValidation';
import {voucherFailureMessage} from '@/lib/voucherFeedback';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { differenceInMonths } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { prepareCommissionCreations, executeCommissionCreation, type PreparedCommissionRequest } from "@/lib/contractCommissionFollowup";
import { CONTRACT_COMMISSION_FOLLOWUP_KEY } from "@/hooks/useContractCommissionFollowup";
import type { CommissionTier } from "@/types/building";
import { isJsonObject, jsonArray } from "@/lib/jsonValue";
import { batBuoc } from "@/lib/queryGuard";
import {
  parseCommissionVoucherFacts,
  type CommissionVoucherFacts,
} from "@/lib/commissionVoucherNote";

// =============================================
// Facts HĐ của một phiếu hoa hồng — dựng ghi chú LÚC XEM
// =============================================

/**
 * Gọi RPC get_commission_voucher_facts_v1 cho MỘT phiếu. RPC gate quyền theo
 * toà và bỏ qua im lặng phiếu không quyền / khác org ⇒ mảng rỗng là "không có
 * gì để hiện", không phải lỗi. `supabase.rpc` không bao giờ ném — lỗi nằm ở
 * `error`.
 */
export const useCommissionVoucherFacts = (
  voucherId: string | null | undefined,
  enabled = true
) => {
  return useQuery({
    queryKey: ["commission-voucher-facts", voucherId ?? null],
    enabled: enabled && !!voucherId,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<CommissionVoucherFacts | null> => {
      const { data, error } = await supabase.rpc(
        "get_commission_voucher_facts_v1",
        { p_voucher_ids: [batBuoc(voucherId, "voucherId")] }
      );
      if (error) throw error;
      const row = financialReadRows(data)[0];
      return row ? parseCommissionVoucherFacts(row.facts) : null;
    },
  });
};

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
}

/**
 * Ảnh chụp hợp đồng để mồi modal phiếu hoa hồng — gọi ngay sau khi tạo HĐ.
 *
 * BA LUẬT, đều rút ra từ bug 15/09/2026 (form tự xoá giữa chừng rồi kẹt ở dòng
 * "Đang tải thông tin hợp đồng..."):
 *
 *   1. `staleTime: Infinity` — dữ liệu này là ảnh chụp của một hợp đồng VỪA tạo
 *      xong; không có lý do gì để nó tự cũ rồi tự tải lại dưới tay người đang
 *      gõ. (Nó KHÔNG chặn được `invalidateQueries` — cửa đó đã khoá bằng cách gỡ
 *      key khỏi descriptor realtime của income_expenses, xem realtime/finance.ts.)
 *   2. NÉM khi PostgREST trả `{error}`. Bản cũ `return null` nên một lỗi thoáng
 *      qua thành "thành công với data rỗng": không retry, không thông báo, modal
 *      treo vĩnh viễn ở dòng chờ và nút Tạo phiếu disable. Vi phạm Contract §14.
 *   3. MỘT request. Sổ quỹ mặc định trước đây là một round-trip `accounts` chạy
 *      TUẦN TỰ sau contracts — vừa chậm gấp đôi, vừa có thể trả về một sổ KHÔNG
 *      nằm trong dropdown của modal (dropdown dùng useAccounts, có lọc sổ DEMO),
 *      làm ô sổ quỹ hiện trống. Modal tự khớp theo tên toà trên chính danh sách
 *      nó đang hiển thị.
 */
export const useCommissionPrefill = (contractId: string | null) => {
  return useQuery({
    queryKey: ["commission-prefill", contractId],
    enabled: !!contractId,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<CommissionPrefillData> => {
      const id = batBuoc(contractId, "contractId");

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
        .eq("id", id)
        .single();

      if (error) throw error;
      if (!contract) {
        throw new Error(
          "Không đọc được hợp đồng vừa tạo (không có dòng nào khớp hoặc không đủ quyền xem)."
        );
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
        contract.contract_customers?.find((c) => c.is_representative) ??
        contract.contract_customers?.[0] ??
        null;

      return {
        contract_id: contract.id,
        contract_number: contract.contract_number ?? null,
        signed_date: contract.signed_date,
        start_date: contract.start_date ?? null,
        end_date: contract.end_date ?? null,
        rent_price: financialReadNumber(contract.rent_price),
        months,
        matched_tier: matched,
        building_id: contract.room?.building?.id ?? "",
        building_name: contract.room?.building?.name ?? "",
        room_id: contract.room?.id ?? null,
        room_name: contract.room?.name ?? null,
        tenant_id: rep?.customer?.id ?? null,
        tenant_name: rep?.customer?.full_name ?? null,
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
  /** Explicit salary manager selection, saved with the creation intent. */
  manager_id?: string | null;
}

export function commissionCreationPayload(input: CreateCommissionVoucherInput) {
  return {
    contract_id: input.contract_id, kind: input.kind, amount: input.amount, voucher_date: input.voucher_date,
    account_id: input.account_id, payer_name: input.payer_name, recipient_name: input.recipient_name,
    recipient_bank: input.recipient_bank, recipient_account: input.recipient_account_number,
    item_description: input.item_description, attachments: input.attachments ?? [], manager_id: input.manager_id ?? null,
  };
}

export const usePrepareCommissionVouchers = () => {
  const { selectedOrganizationId } = useOrganization();
  return useMutation({ meta: {handlesFeedback:true}, retry: false, mutationFn: (inputs: CreateCommissionVoucherInput[]) =>
    prepareCommissionCreations(batBuoc(selectedOrganizationId, 'organizationId'), inputs.map(commissionCreationPayload)) });
};

export const useRetryCommissionVoucher = () => {
  const { selectedOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  return useMutation({ meta: {handlesFeedback:true}, retry: false,
    mutationFn: (request: PreparedCommissionRequest) => executeCommissionCreation(batBuoc(selectedOrganizationId, 'organizationId'), request),
    onSettled: () => {
      for (const key of [CONTRACT_COMMISSION_FOLLOWUP_KEY, 'sale-bonus-status', 'income-expenses', 'accounts-with-balance', 'existing-commission-vouchers', 'commission-voucher-facts', 'manager-salary'])
        queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
};

export const useCreateCommissionVoucher = (options: {silent?:boolean} = {}) => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    retry: false,
    mutationFn: async (input: CreateCommissionVoucherInput) => {
      if (!selectedOrganizationId) throw new Error("Chưa xác định được tổ chức đang xử lý.");
      if ('preparedRequest' in input) throw new Error('Yêu cầu đã lưu phải dùng Tạo lại, không nhận dữ liệu form mới.');
      const request = (await prepareCommissionCreations(selectedOrganizationId, [commissionCreationPayload(input)]))[0];
      if (!request || request.contract_id !== input.contract_id || request.kind !== input.kind) throw new Error('Yêu cầu tạo phiếu không khớp hợp đồng hoặc loại.');
      return executeCommissionCreation(selectedOrganizationId, request);
    },
    // Lỗi mạng không chứng minh server chưa tạo phiếu: luôn đọc lại nguồn thật.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [CONTRACT_COMMISSION_FOLLOWUP_KEY] });
      queryClient.invalidateQueries({ queryKey: ["sale-bonus-status"] });
      queryClient.invalidateQueries({ queryKey: ["income-expenses"] });
      queryClient.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      queryClient.invalidateQueries({
        queryKey: ["existing-commission-vouchers"],
      });
      queryClient.invalidateQueries({ queryKey: ["commission-voucher-facts"] });
      queryClient.invalidateQueries({ queryKey: ["manager-salary"] });
    },
    onError: (err) => {
      console.error("Error creating commission voucher:", err);
      if (!options.silent) toast.error(voucherFailureMessage(err, "tạo phiếu hoa hồng"));
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
 * Phiếu hoa hồng SỐNG (chưa xóa, chưa hủy) của HĐ — để modal hiện "Đã có phiếu"
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
        .eq("contract_id", batBuoc(contractId, "contractId"))
        .in("commission_kind", ["broker", "sale"])
        .is("deleted_at", null)
        .neq("approval_status", "CANCELLED");
      if (error) throw error;
      return financialReadRows(data).map(row=>{
        if(row.commission_kind!=='broker'&&row.commission_kind!=='sale')throw new TypeError('Chưa đọc được loại phiếu hoa hồng đã có.');
        if(typeof row.id!=='string'||!row.id||!['UNAPPROVED','APPROVED'].includes(row.approval_status))throw new TypeError('Chưa đọc được trạng thái phiếu hoa hồng đã có.');
        return {...row,commission_kind:row.commission_kind,total_amount:financialReadNumber(row.total_amount)};
      });
    },
  });
};
