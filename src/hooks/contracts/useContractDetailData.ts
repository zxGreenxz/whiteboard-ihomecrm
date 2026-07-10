// Data layer cho ContractDetailView (Phase 9B) — gom 6 nhóm query phụ của trang
// chi tiết HĐ về 1 chỗ. GIỮ NGUYÊN query key các query có sẵn; 2 query mới
// (services/history — trước là useEffect + state thủ công) đặt key mới.
// KHÁC HÀNH VI CŨ CÓ CHỦ Ý: lỗi fetch được THROW để UI hiện error state,
// không console.error rồi giả thành []/null nữa (4 chỗ nuốt lỗi cũ).
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type {
  ContractServiceItem,
  ContractHistoryItem,
  ContractVehicle,
  ContractDepositVoucher,
} from "@/components/contracts/detail/types";

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
      // Chỉ giữ phiếu có ít nhất 1 item is_deposit
      return ((data ?? []) as unknown as Array<
        ContractDepositVoucher & {
          income_expense_items?: Array<{ type?: { is_deposit?: boolean } | null }>;
        }
      >).filter((v) => (v.income_expense_items ?? []).some((it) => it.type?.is_deposit));
    },
  });
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
      const base = () =>
        supabase
          .from("income_expenses")
          .select("id", { count: "exact", head: true })
          .eq("contract_id", contractId)
          .eq("approval_status", "UNAPPROVED")
          .is("deleted_at", null);
      const [f, r] = await Promise.all([
        base().like("notes", "[CẤN CỌC BỎ CỌC%"),
        base().like("notes", "[HOÀN KHÁCH THANH LÝ]%"),
      ]);
      if (f.error) throw f.error;
      if (r.error) throw r.error;
      return { forfeit: f.count ?? 0, refund: r.count ?? 0 };
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
  refund_amount: number | null;
}

// Quyết toán thanh lý (audit contract_terminations) — trả lời "khách này
// thanh lý gồm những gì": cọc, khấu trừ, hoàn khách.
export function useContractTerminationInfo(contractId: string, status?: string) {
  return useQuery({
    queryKey: ["contract-termination-info", contractId, status],
    enabled: !!contractId && status === "TERMINATED",
    queryFn: async (): Promise<ContractTerminationInfo | null> => {
      const { data, error } = await supabase
        .from("contract_terminations")
        .select(
          "termination_type, actual_move_out_date, outstanding_debt, early_termination_fee, total_deposit, total_deductions, refund_amount",
        )
        .eq("contract_id", contractId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as ContractTerminationInfo | null;
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
