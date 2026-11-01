import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/contexts/OrganizationContext";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { getSessionUser } from "@/lib/authSession";
import { financialReadNumber, financialReadRows } from "@/lib/financialReadValidation";
import { fetchAllRows } from "@/lib/supabaseFetchAll";

type CashFlowPeriodRow = Database["public"]["Functions"]["cashbook_cash_flow_v1"]["Returns"][number];

/** Dòng tiền bên ngoài tổ chức; không dùng tổng luân chuyển của sổ quỹ hằng ngày. */
// hermes-parity:begin cash-flow-external-report
export function useCashFlowReport(year: number, buildingId?: string, options?: { enabled?: boolean }) {
  const { selectedOrganizationId } = useOrganization();

  return useQuery({
    meta: { feedback: "inline" },
    // Giữ prefix để các nghiệp vụ thu/chi và hoàn tác tiếp tục làm mới báo cáo.
    queryKey: ["cash-flow-by-day", "external-cash-flow", selectedOrganizationId, year, buildingId, options?.enabled === false ? "awaiting-building" : "ready"],
    enabled: !!selectedOrganizationId && options?.enabled !== false,
    queryFn: async () => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");
      if (!selectedOrganizationId) throw new Error("Chưa chọn tổ chức để xem dòng tiền.");
      if (options?.enabled === false) throw new Error("Chưa xác nhận được tòa nhà của báo cáo dòng tiền.");
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        throw new TypeError("Năm báo cáo dòng tiền không hợp lệ.");
      }

      const data = await fetchAllRows<CashFlowPeriodRow>(
        (from, to) => supabase.rpc("cashbook_cash_flow_v1", {
          p_organization_id: selectedOrganizationId,
          p_year: year,
          p_building_ids: buildingId ? [buildingId] : undefined,
        })
          .order("building_id", { ascending: true, nullsFirst: true })
          .order("period", { ascending: true })
          .range(from, to),
        { label: "cash-flow-report" },
      );

      const periodPattern = new RegExp(`^${year}-(?:0[1-9]|1[0-2]|Q[1-4])$`);
      const seen = new Set<string>();
      return financialReadRows(data).map((row) => {
        if (
          !row || row.organization_id !== selectedOrganizationId ||
          (row.building_id !== null && typeof row.building_id !== "string") ||
          (buildingId && row.building_id !== buildingId) ||
          typeof row.period !== "string" || !periodPattern.test(row.period)
        ) {
          throw new TypeError("Chưa đọc được đúng phạm vi báo cáo dòng tiền.");
        }
        const key = JSON.stringify([row.building_id, row.period]);
        if (seen.has(key)) throw new TypeError("Báo cáo dòng tiền có kỳ bị trùng.");
        seen.add(key);
        return {
          ...row,
          income: financialReadNumber(row.income),
          expense: financialReadNumber(row.expense),
          net: financialReadNumber(row.net),
        };
      });
    },
  });
}
// hermes-parity:end cash-flow-external-report
