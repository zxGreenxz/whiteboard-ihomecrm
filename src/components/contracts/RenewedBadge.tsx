import { Badge } from "@/components/ui/badge";
import { useIsContractRenewed } from "@/hooks/useRenewedContracts";

/**
 * Chip "Đã gia hạn" — hiện khi HĐ có bản ghi gia hạn trong contract_extensions.
 * Dấu này TÁCH RIÊNG khỏi status (status vẫn 'ACTIVE'); không còn dựa vào 'EXTENDED'.
 *
 * Dùng cho 1 hợp đồng đơn lẻ (vd trang chi tiết) — tự query. Với danh sách nhiều
 * HĐ, hãy dùng useRenewedContractIds 1 lần rồi render <Badge> theo set để khỏi N query.
 */
export function RenewedBadge({ contractId, className }: { contractId?: string | null; className?: string }) {
  const { isRenewed } = useIsContractRenewed(contractId);
  if (!isRenewed) return null;
  return (
    <Badge className={`bg-blue-500 hover:bg-blue-600 text-white ${className ?? ""}`}>
      Đã gia hạn
    </Badge>
  );
}
