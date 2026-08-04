// Data layer cho ContractDetailView (Phase 9B) — gom 6 nhóm query phụ của trang
// chi tiết HĐ về 1 chỗ. GIỮ NGUYÊN query key các query có sẵn; 2 query mới
// (services/history — trước là useEffect + state thủ công) đặt key mới.
// KHÁC HÀNH VI CŨ CÓ CHỦ Ý: lỗi fetch được THROW để UI hiện error state,
// không console.error rồi giả thành []/null nữa (4 chỗ nuốt lỗi cũ).
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { TERMINATION_REFUND_SOURCE } from "@/hooks/useDepositDashboard";
import type {
  ContractServiceItem,
  ContractHistoryItem,
  ContractVehicle,
  ContractDepositVoucher,
} from "@/components/contracts/detail/types";

/** Marker của phiếu "cấn cọc / chuyển cọc thành doanh thu" khi thanh lý. */
export const TERMINATION_OFFSET_SOURCE = "termination.offset";

// Phiếu thu cọc (IE INCOME có item is_deposit) — minh bạch nguồn deposit_paid.
export function useContractDepositVouchers(contractId: string) {
  return useQuery({
    queryKey: ["contract-deposit-vouchers", contractId],
    enabled: !!contractId,
    queryFn: async (): Promise<ContractDepositVoucher[]> => {
      const { data, error } = await supabase
        .from("income_expenses")
        .select(`
          id, code, name, total_amount, voucher_date, approval_status,
          posting_status, system_source,
          account:accounts!income_expenses_account_id_fkey ( id, name ),
          income_expense_items (
            id, income_expense_type_id,
            type:income_expense_types!income_expense_items_income_expense_type_id_fkey (
              id, name, is_deposit
            )
          )
        `)
        .eq("contract_id", contractId)
        .eq("type", "INCOME")
        .is("deleted_at", null)
        .order("voucher_date", { ascending: false });
      if (error) throw error;
      // Chỉ giữ phiếu có ít nhất 1 item is_deposit.
      // `posting_status`/`system_source` được select thêm để UI giải thích được
      // phiếu cọc ĐẦU KỲ (`system_source='contract.deposit'`,
      // `posting_status='NOT_APPLICABLE'`): tiền khách đóng TRƯỚC khi dùng phần
      // mềm, lên sổ ảo, nên không hề chạy qua sổ quỹ.
      return ((data ?? []) as unknown as Array<
        ContractDepositVoucher & {
          posting_status?: string | null;
          system_source?: string | null;
          income_expense_items?: Array<{ type?: { is_deposit?: boolean } | null }>;
        }
      >).filter((v) => (v.income_expense_items ?? []).some((it) => it.type?.is_deposit));
    },
  });
}

/** Hình dạng tối thiểu để phân loại phiếu thanh lý còn treo. */
export interface PendingTerminationVoucher {
  system_source?: string | null;
  notes?: string | null;
}

/**
 * Phân loại phiếu thanh lý CHỜ DUYỆT theo `system_source` (marker do writer đặt),
 * và VẪN nhận tiền tố `notes` cũ để không mất phiếu legacy.
 *
 * Vì sao đổi (Slice −1 · §−1.7(d)): bản cũ dò DUY NHẤT `notes LIKE '[CẤN CỌC BỎ
 * CỌC%'` / `'[HOÀN KHÁCH THANH LÝ]%'`. Ghi chú là văn bản tự do, writer canonical
 * KHÔNG đặt hai tiền tố đó (`terminate_contract_move_out_impl` đặt
 * `system_source='termination.refund'`, phiếu cấn cọc đặt `'termination.offset'`),
 * nên cảnh báo "Phiếu thanh lý chờ xử lý" bỏ sót phần lớn phiếu. Hợp hai luật
 * (OR) nên tuyệt đối không nhận diện ít hơn bản cũ.
 */
export function classifyPendingTerminationVouchers(
  rows: PendingTerminationVoucher[],
): { forfeit: number; refund: number } {
  let forfeit = 0;
  let refund = 0;
  for (const v of rows) {
    const src = v.system_source ?? "";
    const notes = v.notes ?? "";
    if (src === TERMINATION_REFUND_SOURCE || notes.startsWith("[HOÀN KHÁCH THANH LÝ]")) {
      refund += 1;
    } else if (src === TERMINATION_OFFSET_SOURCE || notes.startsWith("[CẤN CỌC BỎ CỌC")) {
      forfeit += 1;
    }
  }
  return { forfeit, refund };
}

// B1 (audit 03/07): phiếu thanh lý đang CHỜ XỬ LÝ của HĐ này:
//  - forfeit: cặp "cấn cọc bỏ cọc" chờ Duyệt (quên → cọc không vào doanh thu)
//  - refund: phiếu chi "Trả khách thanh lý" nháp, CHƯA CÓ SỔ QUỸ — phải chọn
//    sổ (Sửa phiếu) rồi duyệt thì tiền hoàn mới được ghi nhận chi.
export function useContractPendingTermination(contractId: string) {
  return useQuery({
    queryKey: ["contract-pending-forfeit", contractId],
    enabled: !!contractId,
    queryFn: async (): Promise<{ forfeit: number; refund: number }> => {
      // Một query lấy đúng tập phiếu CHỜ DUYỆT của HĐ rồi phân loại phía client
      // (một HĐ chỉ có vài phiếu — không cần phân trang). Trước đây là 2 query
      // `head:true count` với 2 pattern LIKE trên `notes`.
      const { data, error } = await supabase
        .from("income_expenses")
        .select("id, system_source, notes")
        .eq("contract_id", contractId)
        .eq("approval_status", "UNAPPROVED")
        .is("deleted_at", null);
      if (error) throw error;
      return classifyPendingTerminationVouchers((data ?? []) as PendingTerminationVoucher[]);
    },
  });
}

export interface ContractTerminationInfo {
  termination_type: string | null;
  actual_move_out_date: string | null;
  outstanding_debt: number | null;
  early_termination_fee: number | null;
  total_deposit: number | null;
  total_deductions: number | null;
  /**
   * Cột GENERATED = net quyết toán theo HỒ SƠ (lịch sử), KHÔNG phải số phải trả
   * khách. Ca HĐ `69cdb5dc`: 2.428.500 = 3.500.000 cọc *chưa bao giờ thu* −
   * 1.071.500 cấn cọc *chưa bao giờ vào sổ*.
   */
  refund_amount: number | null;
  /** Σ phiếu chi hoàn cọc ĐÃ DUYỆT + ĐÃ VÀO SỔ của HĐ này (đồng). */
  posted_refund: number;
  posted_refund_count: number;
  /** Mã phiếu để người dùng tra thẳng ở trang Thu chi. */
  posted_refund_codes: string[];
}

// Quyết toán thanh lý (audit contract_terminations) — trả lời "khách này
// thanh lý gồm những gì": cọc, khấu trừ, hoàn khách.
//
// Slice −1 · §−1.7/§−1.3: hồ sơ (`contract_terminations`) và TIỀN THẬT (phiếu
// chi đã vào sổ) là HAI nguồn khác nhau và trên prod chúng LỆCH NHAU theo cả hai
// chiều. Hook trả về cả hai để thẻ "Quyết toán thanh lý" không trình bày số hồ sơ
// như thể là số đã trả khách.
export function useContractTerminationInfo(contractId: string, status?: string) {
  return useQuery({
    queryKey: ["contract-termination-info", contractId, status],
    enabled: !!contractId && status === "TERMINATED",
    queryFn: async (): Promise<ContractTerminationInfo | null> => {
      const [term, vouchers] = await Promise.all([
        supabase
          .from("contract_terminations")
          .select(
            "termination_type, actual_move_out_date, outstanding_debt, early_termination_fee, total_deposit, total_deductions, refund_amount",
          )
          .eq("contract_id", contractId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        // Phiếu hoàn ĐÃ RA KHỎI KÉT: APPROVED + POSTED + còn bút toán hiệu lực.
        // Một HĐ chỉ có vài phiếu nên không cần phân trang.
        supabase
          .from("income_expenses")
          .select("id, code, total_amount")
          .eq("contract_id", contractId)
          .eq("type", "EXPENSE")
          .eq("system_source", TERMINATION_REFUND_SOURCE)
          .eq("approval_status", "APPROVED")
          .eq("posting_status", "POSTED")
          .not("active_posting_id_v2", "is", null)
          .is("deleted_at", null)
          .order("voucher_date", { ascending: true }),
      ]);
      if (term.error) throw term.error;
      // FAIL-CLOSED: không đọc được phiếu thì báo lỗi, KHÔNG hiện "chưa có phiếu
      // hoàn" (một tuyên bố sai về tiền).
      if (vouchers.error) throw vouchers.error;
      if (!term.data) return null;

      const rows = (vouchers.data ?? []) as Array<{ code: string | null; total_amount: number | string | null }>;
      return {
        ...(term.data as Omit<
          ContractTerminationInfo,
          "posted_refund" | "posted_refund_count" | "posted_refund_codes"
        >),
        posted_refund: rows.reduce((s, v) => s + (Number(v.total_amount) || 0), 0),
        posted_refund_count: rows.length,
        posted_refund_codes: rows.map((v) => v.code).filter((c): c is string => !!c),
      };
    },
  });
}

// Phương tiện gắn với các khách trong hợp đồng (gom theo customer_id ở UI)
export function useContractVehicles(contractId: string, customerIds: string[]) {
  return useQuery({
    queryKey: ["contract-vehicles", contractId, customerIds.join(",")],
    enabled: customerIds.length > 0,
    queryFn: async (): Promise<ContractVehicle[]> => {
      const { data, error } = await supabase
        .from("vehicles")
        .select("id, customer_id, vehicle_type, vehicle_name, brand, model, license_plate, color, parking_fee")
        .in("customer_id", customerIds)
        .is("deleted_at", null);
      if (error) throw error;
      return (data ?? []) as ContractVehicle[];
    },
  });
}

export function useContractServices(contractId: string) {
  return useQuery({
    queryKey: ["contract-services", contractId],
    enabled: !!contractId,
    queryFn: async (): Promise<ContractServiceItem[]> => {
      const { data, error } = await supabase
        .from("contract_services")
        .select(`
          id, service_id, unit_price, initial_reading,
          service:services(id, name, type, unit)
        `)
        .eq("contract_id", contractId);
      if (error) throw error;
      return (data ?? []) as unknown as ContractServiceItem[];
    },
  });
}

// Lịch sử HĐ = extensions + transfers + terminations, sort mới→cũ (GIỮ NGUYÊN
// thứ tự của bản cũ: sort theo created_at desc sau khi gộp 3 nguồn).
export function useContractHistory(contractId: string) {
  return useQuery({
    queryKey: ["contract-history", contractId],
    enabled: !!contractId,
    queryFn: async (): Promise<ContractHistoryItem[]> => {
      const [ext, tra, ter] = await Promise.all([
        supabase.from("contract_extensions").select("*")
          .eq("contract_id", contractId).order("created_at", { ascending: false }),
        supabase.from("contract_transfers").select("*")
          .eq("contract_id", contractId).order("created_at", { ascending: false }),
        supabase.from("contract_terminations").select("*")
          .eq("contract_id", contractId).order("created_at", { ascending: false }),
      ]);
      if (ext.error) throw ext.error;
      if (tra.error) throw tra.error;
      if (ter.error) throw ter.error;
      const history: ContractHistoryItem[] = [
        ...(ext.data ?? []).map((e) => ({
          id: e.id, type: "extension" as const, created_at: e.created_at,
          status: e.status, details: e as Record<string, unknown>,
        })),
        ...(tra.data ?? []).map((t) => ({
          id: t.id, type: "transfer" as const, created_at: t.created_at,
          status: t.status, details: t as Record<string, unknown>,
        })),
        ...(ter.data ?? []).map((t) => ({
          id: t.id, type: "termination" as const, created_at: t.created_at,
          status: t.status, details: t as Record<string, unknown>,
        })),
      ];
      history.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      return history;
    },
  });
}
