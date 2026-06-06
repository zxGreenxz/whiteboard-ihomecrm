import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Tập `contract_id` ĐÃ GIA HẠN — suy từ bảng `contract_extensions` (có ≥1 bản ghi
 * gia hạn đã hoàn tất: status APPROVED/COMPLETED). Đây là NGUỒN của dấu "Đã gia hạn",
 * thay cho việc dựa vào `contracts.status = 'EXTENDED'` (đã ngưng dùng).
 *
 * Truyền vào danh sách id (1 hoặc nhiều) → 1 query duy nhất, trả về Set để tra O(1).
 */
export function useRenewedContractIds(contractIds: Array<string | null | undefined>) {
  const ids = Array.from(new Set((contractIds ?? []).filter((x): x is string => !!x)));
  return useQuery({
    queryKey: ["renewed-contract-ids", [...ids].sort()],
    enabled: ids.length > 0,
    queryFn: async (): Promise<Set<string>> => {
      const { data, error } = await supabase
        .from("contract_extensions")
        .select("contract_id")
        .in("contract_id", ids)
        .in("status", ["APPROVED", "COMPLETED"]);
      if (error) throw error;
      return new Set((data ?? []).map((r: { contract_id: string }) => r.contract_id));
    },
  });
}

/** Tiện cho 1 hợp đồng: trả về boolean "đã gia hạn". */
export function useIsContractRenewed(contractId?: string | null) {
  const q = useRenewedContractIds(contractId ? [contractId] : []);
  return { ...q, isRenewed: !!contractId && (q.data?.has(contractId) ?? false) };
}
