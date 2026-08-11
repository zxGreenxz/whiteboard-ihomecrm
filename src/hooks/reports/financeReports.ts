import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { addDays, differenceInDays } from "date-fns";

// ==================== FINANCE REPORTS ====================

/**
 * Get payment schedule report
 * Returns upcoming and past due invoices
 */
export function usePaymentScheduleReport(daysAhead: number = 30) {
  return useQuery({
    queryKey: ["reports", "payment-schedule", daysAhead],
    queryFn: async () => {
      const today = new Date();
      const futureDate = addDays(today, daysAhead);

      const { data, error } = await supabase
        .from("invoices")
        .select(`
          *,
          building:buildings!invoices_building_id_fkey (id, name),
          room:rooms!invoices_room_id_fkey (id, name),
          contract:contracts!invoices_contract_id_fkey (
            id,
            contract_customers!contract_customers_contract_id_fkey (
              is_representative,
              customer:customers!contract_customers_customer_id_fkey (id, full_name, phone)
            )
          )
        `)
        .lte("due_date", futureDate.toISOString())
        .order("due_date", { ascending: true });

      if (error) throw error;

      return data.map((invoice: any) => {
        const cust = (invoice.contract?.contract_customers || []).find((c: any) => c.is_representative)
          || invoice.contract?.contract_customers?.[0];
        return {
          ...invoice,
          amount: invoice.total_amount,
          amount_paid: invoice.paid_amount,
          tenants: cust?.customer ?? null,
          rooms: invoice.room
            ? { room_number: invoice.room.name, buildings: invoice.building }
            : null,
          days_until_due: differenceInDays(new Date(invoice.due_date), today),
          remaining_amount: invoice.remaining_amount ?? (invoice.total_amount - (invoice.paid_amount || 0)),
        };
      });
    },
  });
}

/**
 * Get overpayment report
 * Returns customers who have overpaid
 */
export function useOverpaymentReport() {
  return useQuery({
    queryKey: ["reports", "overpayment"],
    queryFn: async () => {
      // PAGED: mọi hoá đơn từng thu đều paid_amount>0 → dễ vượt 1000 → phân trang.
      const data = await fetchAllRows<any>(
        (from, to) => supabase
          .from("invoices")
          .select(`
            id,
            invoice_number,
            total_amount,
            paid_amount,
            building:buildings!invoices_building_id_fkey (id, name),
            room:rooms!invoices_room_id_fkey (id, name),
            contract:contracts!invoices_contract_id_fkey (
              id,
              contract_customers!contract_customers_contract_id_fkey (
                is_representative,
                customer:customers!contract_customers_customer_id_fkey (id, full_name, phone)
              )
            )
          `)
          .gt("paid_amount", 0)
          .is("deleted_at", null)
          .order("id", { ascending: true })
          .range(from, to),
        { label: "reports.overpayment" },
      );
      if (data === null) throw new Error("Lỗi tải hoá đơn (tiền thừa)");

      // Filter for overpayments
      return data
        .filter((invoice: any) => (invoice.paid_amount || 0) > invoice.total_amount)
        .map((invoice: any) => {
          const cust = (invoice.contract?.contract_customers || []).find((c: any) => c.is_representative)
            || invoice.contract?.contract_customers?.[0];
          return {
            ...invoice,
            amount: invoice.total_amount,
            amount_paid: invoice.paid_amount,
            tenants: cust?.customer ?? null,
            rooms: invoice.room
              ? { room_number: invoice.room.name, buildings: invoice.building }
              : null,
            overpaid_amount: (invoice.paid_amount || 0) - invoice.total_amount,
          };
        });
    },
  });
}

/** Tổng tiền thừa — RPC SQL aggregate (miễn nhiễm cap-1000). buildingIds=[] → tất cả. */
export function useOverpaymentSummary(buildingIds?: string[]) {
  return useQuery({
    queryKey: ["reports", "overpayment", "summary", buildingIds ?? []],
    queryFn: async (): Promise<{ total: number; count: number }> => {
      const { data, error } = await supabase.rpc("get_overpayment_summary", {
        p_building_ids: buildingIds && buildingIds.length ? buildingIds : undefined,
      });
      if (error) throw error;
      const d = (data ?? {}) as any;
      return { total: Number(d.total) || 0, count: Number(d.count) || 0 };
    },
  });
}

/**
 * Get deposits report
 * Returns list of customer deposits
 */
export function useDepositsReport() {
  return useQuery({
    queryKey: ["reports", "deposits"],
    queryFn: async () => {
      // PAGED: bảng deposits tích luỹ → phân trang (deposit_date + id tiebreaker).
      const data = await fetchAllRows<any>(
        (from, to) => supabase
          .from("deposits")
          .select(`
            *,
            tenant:tenants!deposits_tenant_id_fkey (
              id,
              full_name,
              phone,
              email
            ),
            room:rooms!deposits_room_id_fkey (
              id,
              name,
              building:buildings!rooms_building_id_fkey (id, name)
            )
          `)
          .is("deleted_at", null)
          .order("deposit_date", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
        { label: "reports.deposits" },
      );
      if (data === null) throw new Error("Lỗi tải danh sách tiền cọc");

      return data.map((deposit: any) => ({
        ...deposit,
        tenants: deposit.tenant,
        rooms: deposit.room ? { room_number: deposit.room.name, buildings: deposit.room.building } : null,
        leads: deposit.tenant,
        days_held: differenceInDays(new Date(), new Date(deposit.deposit_date)),
      }));
    },
  });
}

/** Tổng BC tiền cọc — RPC SQL aggregate (miễn nhiễm cap-1000). */
export function useDepositsReportSummary(status?: string, buildingIds?: string[]) {
  return useQuery({
    queryKey: ["reports", "deposits", "summary", status ?? null, buildingIds ?? []],
    queryFn: async (): Promise<{ total: number; count: number; holdingTotal: number; inInvoiceTotal: number }> => {
      const { data, error } = await supabase.rpc("get_deposits_report_summary", {
        p_status: status && status !== "all" ? status : undefined,
        p_building_ids: buildingIds && buildingIds.length ? buildingIds : undefined,
      });
      if (error) throw error;
      const d = (data ?? {}) as any;
      return {
        total: Number(d.total) || 0,
        count: Number(d.count) || 0,
        holdingTotal: Number(d.holding_total) || 0,
        inInvoiceTotal: Number(d.in_invoice_total) || 0,
      };
    },
  });
}
