import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUserId } from "@/lib/authSession";
import { toast } from "sonner";
import { startOfMonth, endOfMonth, subMonths, format } from "date-fns";
import { getRepresentativeName } from "@/lib/contractCustomerHelpers";

export interface DashboardStats {
  totalRooms: number;
  occupiedRooms: number;
  availableRooms: number;
  reservedRooms: number;
  occupancyRate: number;
  revenueThisMonth: number;
  totalDebt: number;
  newContractsThisMonth: number;
  unresolvedIssues: number;
}

export interface RevenueData {
  month: string;
  revenue: number;
  growth?: number;
}

export interface OccupancyData {
  status: string;
  count: number;
  percentage: number;
}

export interface Alert {
  id: string;
  type: "overdue_invoice" | "expiring_contract" | "urgent_issue" | "deposit_shortfall";
  title: string;
  description: string;
  severity: "high" | "medium" | "low";
  date: string;
  link?: string;
}

export interface RecentActivity {
  id: string;
  type: "contract" | "payment" | "issue";
  title: string;
  description: string;
  date: string;
  amount?: number;
}

// ==== get_dashboard_summary: 1 RPC gộp thay ~15 query widget ====
// (migration 20260703180000, SECURITY INVOKER — RLS áp y hệt query cũ; đã
// verify 6 user × 2 scope × 17 con số khớp 100%). useDashboardStats /
// useOccupancyChart / OperationsSummary cùng ăn chung MỘT queryKey nên cả
// Dashboard chỉ bắn đúng 1 request cho toàn bộ số liệu KPI.
export interface DashboardSummary {
  total_rooms: number;
  occupied_rooms: number;
  reserved_rooms: number;
  revenue_this_month: number;
  total_debt: number;
  new_contracts_this_month: number;
  unresolved_issues: number;
  leads_total: number;
  leads_converted: number;
  leads_new_month: number;
  deposits_total: number;
  deposits_moved_in: number;
  deposits_new_month: number;
  contracts_active: number;
  contracts_new_month: number;
  contracts_expiring_soon: number;
  contracts_terminated_month: number;
}

const dashboardSummaryQuery = (buildingId?: string | null) => ({
  queryKey: ["dashboard-summary", buildingId ?? null] as const,
  queryFn: async (): Promise<DashboardSummary> => {
    const { data, error } = await supabase.rpc("get_dashboard_summary", {
      p_building_id: buildingId ?? null,
    });
    if (error) throw error;
    return data as unknown as DashboardSummary;
  },
  // Stats dashboard không cần tươi từng phút: 5 phút + dừng khi tab ẩn.
  // Mutation vẫn invalidate queryKey nên số liệu cập nhật khi có thay đổi thật.
  staleTime: 5 * 60_000,
  refetchInterval: 5 * 60_000,
  refetchIntervalInBackground: false,
});

export const useDashboardSummary = (buildingId?: string | null) =>
  useQuery(dashboardSummaryQuery(buildingId));

// Dashboard stats — GIỮ NGUYÊN interface cũ, dữ liệu lấy từ RPC gộp (select
// map; cùng queryKey với useDashboardSummary → React Query dedupe 1 request).
export const useDashboardStats = (buildingId?: string | null) => {
  return useQuery({
    ...dashboardSummaryQuery(buildingId),
    select: (s: DashboardSummary): DashboardStats => {
      const totalRooms = s.total_rooms || 0;
      const occupiedRooms = s.occupied_rooms || 0;
      const reservedRooms = s.reserved_rooms || 0;
      return {
        totalRooms,
        occupiedRooms,
        reservedRooms,
        availableRooms: Math.max(0, totalRooms - occupiedRooms - reservedRooms),
        occupancyRate: totalRooms ? (occupiedRooms / totalRooms) * 100 : 0,
        revenueThisMonth: Number(s.revenue_this_month) || 0,
        totalDebt: Number(s.total_debt) || 0,
        newContractsThisMonth: s.new_contracts_this_month || 0,
        unresolvedIssues: s.unresolved_issues || 0,
      };
    },
  });
};

// Revenue chart data (last 12 months)
// 1 dataset phân trang cho cả kỳ rồi group theo tháng ở client — bản cũ bắn 12 query
// TUẦN TỰ (mỗi tháng 1 round-trip) khiến chart mất 1.5-2.5s mỗi lần mở
// Dashboard. Đồng thời respect bộ lọc toà (bản cũ bỏ qua buildingId).
export const useRevenueChart = (months: number = 12, buildingId?: string | null) => {
  return useQuery({
    queryKey: ["revenue-chart", months, buildingId],
    queryFn: async (): Promise<RevenueData[]> => {
      const userId = await getSessionUserId();
      if (!userId) throw new Error('Not authenticated');

      const rangeStart = startOfMonth(subMonths(new Date(), months - 1));
      const rangeEnd = endOfMonth(new Date());

      // RPC gộp theo tháng server-side (20260726132000) — bản cũ fetchAllRows
      // toàn bộ bút toán P&L cả kỳ về client chỉ để cộng ra 12 con số.
      // Range vẫn do client tính để giữ đúng múi giờ máy user.
      const { data: monthRows, error } = await supabase.rpc("revenue_by_month", {
        p_start: format(rangeStart, "yyyy-MM-dd"),
        p_end: format(rangeEnd, "yyyy-MM-dd"),
        p_building_id: buildingId ?? undefined,
      });
      if (error) throw error;

      // Khởi tạo đủ 12 tháng (tháng không có bút toán P&L vẫn hiện 0).
      const byMonth = new Map<string, number>();
      const data: RevenueData[] = [];
      for (let i = months - 1; i >= 0; i--) {
        const key = format(subMonths(new Date(), i), "MM/yyyy");
        byMonth.set(key, 0);
        data.push({ month: key, revenue: 0 });
      }
      for (const row of monthRows ?? []) {
        const d = new Date(`${row.month_start}T00:00:00`);
        if (Number.isNaN(d.getTime())) continue;
        const key = format(d, "MM/yyyy");
        if (byMonth.has(key)) {
          byMonth.set(key, (byMonth.get(key) || 0) + (Number(row.revenue) || 0));
        }
      }
      for (const row of data) {
        row.revenue = byMonth.get(row.month) || 0;
      }

      // Calculate growth
      for (let i = 1; i < data.length; i++) {
        const current = data[i].revenue;
        const previous = data[i - 1].revenue;
        if (previous > 0) {
          data[i].growth = ((current - previous) / previous) * 100;
        }
      }

      return data;
    },
  });
};

// Occupancy chart — suy trực tiếp từ RPC gộp (trước đây tự bắn lại 4 query
// TRÙNG y hệt số useDashboardStats đã có). Cùng queryKey → 0 request thêm.
export const useOccupancyChart = (buildingId?: string | null) => {
  return useQuery({
    ...dashboardSummaryQuery(buildingId),
    select: (s: DashboardSummary): OccupancyData[] => {
      const totalRooms = s.total_rooms || 0;
      const occupiedRooms = s.occupied_rooms || 0;
      const reservedRooms = s.reserved_rooms || 0;
      const availableRooms = Math.max(0, totalRooms - occupiedRooms - reservedRooms);
      const total = totalRooms || 1;

      const result: OccupancyData[] = [
        {
          status: "Đã thuê",
          count: occupiedRooms,
          percentage: (occupiedRooms / total) * 100,
        },
        {
          status: "Còn trống",
          count: availableRooms,
          percentage: (availableRooms / total) * 100,
        },
      ];
      if (reservedRooms > 0) {
        result.push({
          status: "Đã cọc",
          count: reservedRooms,
          percentage: (reservedRooms / total) * 100,
        });
      }
      return result;
    },
  });
};

// Alerts
export const useAlerts = (buildingId?: string | null) => {
  return useQuery({
    queryKey: ["dashboard-alerts", buildingId],
    queryFn: async (): Promise<Alert[]> => {
      const userId = await getSessionUserId();
      if (!userId) throw new Error('Not authenticated');

      const alerts: Alert[] = [];

      // Overdue invoices
      const { data: overdueInvoices } = await supabase
        .from("invoices")
        .select(
          `id, invoice_number, due_date, total_amount, paid_amount,
           contract:contracts(
             contract_customers!contract_customers_contract_id_fkey(
               is_representative,
               customer:customers!contract_customers_customer_id_fkey(full_name)
             )
           )`
        )
        .in("status", ["APPROVED", "PARTIAL_PAID"])
        .is("deleted_at", null)
        .lt("due_date", new Date().toISOString())
        .order("due_date", { ascending: true })
        .limit(5);

      overdueInvoices?.forEach((invoice: any) => {
        const debt = (invoice.total_amount || 0) - (invoice.paid_amount || 0);
        const customerName = getRepresentativeName(invoice.contract, "Khách hàng");
        alerts.push({
          id: invoice.id,
          type: "overdue_invoice",
          title: "Hóa đơn quá hạn",
          description: `${customerName} - ${invoice.invoice_number || "Hóa đơn"} - Nợ ${debt.toLocaleString()}đ`,
          severity: "high",
          date: invoice.due_date,
          link: `/invoices/${invoice.id}`,
        });
      });

      // Expiring contracts (within 30 days)
      const thirtyDaysFromNow = new Date();
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

      const { data: expiringContracts } = await supabase
        .from("contracts")
        .select(
          `id, contract_number, end_date,
           contract_customers!contract_customers_contract_id_fkey(
             is_representative,
             customer:customers!contract_customers_customer_id_fkey(full_name)
           )`
        )
        .in("status", ["ACTIVE"])
        .lte("end_date", thirtyDaysFromNow.toISOString())
        .gte("end_date", new Date().toISOString())
        .order("end_date", { ascending: true })
        .limit(5);

      expiringContracts?.forEach((contract: any) => {
        const daysLeft = Math.ceil((new Date(contract.end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        const customerName = getRepresentativeName(contract, "Khách hàng");
        alerts.push({
          id: contract.id,
          type: "expiring_contract",
          title: "Hợp đồng sắp hết hạn",
          description: `${customerName} - ${contract.contract_number} - Còn ${daysLeft} ngày`,
          severity: daysLeft <= 7 ? "high" : daysLeft <= 15 ? "medium" : "low",
          date: contract.end_date,
          link: `/contracts/${contract.id}`,
        });
      });

      // Unresolved urgent issues > 24h
      const twentyFourHoursAgo = new Date();
      twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

      const { data: urgentIssues } = await supabase
        .from("issues")
        .select("id, title, priority, created_at")
        .eq("priority", "URGENT")
        .not("status", "in", '("RESOLVED","CLOSED")')
        .lt("created_at", twentyFourHoursAgo.toISOString())
        .order("created_at", { ascending: true })
        .limit(5);

      urgentIssues?.forEach((issue) => {
        alerts.push({
          id: issue.id,
          type: "urgent_issue",
          title: "Công việc khẩn cấp chưa xử lý",
          description: `${issue.title} - Quá 24h chưa giải quyết`,
          severity: "high",
          date: issue.created_at,
          link: `/issues/${issue.id}`,
        });
      });

      // Deposit shortfall — HĐ đang hiệu lực còn thiếu cọc (mode DEBT/legacy;
      // KHÔNG gồm FIRST_INVOICE vì khoản đó thu qua hoá đơn đầu, đã có cảnh báo
      // hoá đơn quá hạn riêng). Đánh dấu để admin nhớ thu đủ cọc.
      const { data: depositShortContracts } = await supabase
        .from("contracts")
        .select(
          `id, contract_number, total_deposit, deposit_paid, deposit_remaining, deposit_topup_due_date,
           contract_customers!contract_customers_contract_id_fkey(
             is_representative,
             customer:customers!contract_customers_customer_id_fkey(full_name)
           )`
        )
        .in("status", ["ACTIVE"])
        .is("deleted_at", null)
        .gte("deposit_remaining", 10000)
        .or("deposit_debt_mode.is.null,deposit_debt_mode.eq.DEBT")
        .order("deposit_remaining", { ascending: false })
        .limit(5);

      depositShortContracts?.forEach((c: any) => {
        const customerName = getRepresentativeName(c, "Khách hàng");
        const dueIso = c.deposit_topup_due_date as string | null;
        const overdue = dueIso ? new Date(dueIso).getTime() < Date.now() : false;
        const dueText = dueIso
          ? ` - hẹn ${new Date(dueIso).toLocaleDateString("vi-VN")}`
          : "";
        alerts.push({
          id: `deposit-${c.id}`,
          type: "deposit_shortfall",
          title: "Hợp đồng thiếu cọc",
          description: `${customerName} - ${c.contract_number || "HĐ"} - Thiếu ${Number(
            c.deposit_remaining || 0,
          ).toLocaleString()}đ${dueText}`,
          severity: overdue ? "high" : "medium",
          date: dueIso || new Date().toISOString(),
          link: `/contracts/${c.id}`,
        });
      });

      return alerts.sort((a, b) => {
        const severityOrder = { high: 0, medium: 1, low: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      });
    },
  });
};

// Recent activities
export const useRecentActivities = (buildingId?: string | null) => {
  return useQuery({
    queryKey: ["recent-activities", buildingId],
    queryFn: async (): Promise<RecentActivity[]> => {
      const userId = await getSessionUserId();
      if (!userId) throw new Error('Not authenticated');

      const activities: RecentActivity[] = [];

      // Recent contracts (last 7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const { data: recentContracts } = await supabase
        .from("contracts")
        .select(
          `id, contract_number, created_at,
           contract_customers!contract_customers_contract_id_fkey(
             is_representative,
             customer:customers!contract_customers_customer_id_fkey(full_name)
           ),
           room:rooms(name)`
        )
        .gte("created_at", sevenDaysAgo.toISOString())
        .order("created_at", { ascending: false })
        .limit(5);

      recentContracts?.forEach((contract: any) => {
        const customerName = getRepresentativeName(contract, "Khách hàng");
        activities.push({
          id: contract.id,
          type: "contract",
          title: "Hợp đồng mới",
          description: `${customerName} - ${contract.room?.name || "Căn hộ"}`,
          date: contract.created_at,
        });
      });

      // Cash collection activities only. The view removes reversals and returned
      // change; customer credit stays included, while non-cash CT is excluded.
      const { data: recentReceipts, error: receiptsError } = await supabase
        .from("active_payment_receipts")
        .select("id, invoice_id, collected_amount, payment_date")
        .neq("payment_method", "CT")
        .gt("collected_amount", 0)
        .gte("payment_date", format(sevenDaysAgo, "yyyy-MM-dd"))
        .order("payment_date", { ascending: false })
        .order("id", { ascending: true })
        .limit(5);
      if (receiptsError) throw receiptsError;

      const invoiceIds = Array.from(new Set(
        (recentReceipts ?? [])
          .map((receipt: any) => receipt.invoice_id as string | null)
          .filter((id: string | null): id is string => !!id),
      ));
      const invoiceById = new Map<string, any>();
      if (invoiceIds.length > 0) {
        const { data: receiptInvoices, error: invoicesError } = await supabase
          .from("invoices")
          .select(
            `id,
             contract:contracts(
               contract_customers!contract_customers_contract_id_fkey(
                 is_representative,
                 customer:customers!contract_customers_customer_id_fkey(full_name)
               )
             )`,
          )
          .in("id", invoiceIds);
        if (invoicesError) throw invoicesError;
        for (const invoice of receiptInvoices ?? []) {
          invoiceById.set(invoice.id, invoice);
        }
      }

      recentReceipts?.forEach((receipt: any) => {
        const invoice = receipt.invoice_id ? invoiceById.get(receipt.invoice_id) : null;
        const customerName = getRepresentativeName(invoice?.contract, "Khách hàng");
        activities.push({
          id: receipt.id,
          type: "payment",
          title: "Thu tiền",
          description: customerName,
          date: receipt.payment_date,
          amount: Number(receipt.collected_amount) || 0,
        });
      });

      // Recent issues (last 7 days)
      const { data: recentIssues } = await supabase
        .from("issues")
        .select("id, title, priority, created_at")
        .gte("created_at", sevenDaysAgo.toISOString())
        .order("created_at", { ascending: false })
        .limit(5);

      recentIssues?.forEach((issue) => {
        activities.push({
          id: issue.id,
          type: "issue",
          title: "Công việc mới",
          description: issue.title,
          date: issue.created_at,
        });
      });

      return activities.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 10);
    },
  });
};
