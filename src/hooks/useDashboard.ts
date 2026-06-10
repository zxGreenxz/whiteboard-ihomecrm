import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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

// Helper to get building IDs for filtering. Trust RLS for staff/admin/owner
// visibility (buildings_select_staff already covers employer↔staff scope) so
// staff users see employer's buildings instead of an empty list, which would
// silently fall through to "all visible contracts" and produce nonsense like
// totalRooms=0 + occupiedRooms=252 → availableRooms=-252.
const getBuildingIds = async (_userId: string, buildingId?: string | null): Promise<string[]> => {
  if (buildingId) return [buildingId];
  const { data: userBuildings } = await supabase
    .from("buildings")
    .select("id")
    .is("deleted_at", null);
  return userBuildings?.map(b => b.id) || [];
};

// Dashboard stats
export const useDashboardStats = (buildingId?: string | null) => {
  return useQuery({
    queryKey: ["dashboard-stats", buildingId],
    queryFn: async (): Promise<DashboardStats> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const buildingIds = await getBuildingIds(user.id, buildingId);

      const monthStart = startOfMonth(new Date());
      const monthEnd = endOfMonth(new Date());

      // Occupied rooms (active contracts) — filter theo toà của phòng.
      let occupiedRoomsQuery = supabase
        .from("contracts")
        .select("room_id, room:rooms!inner(building_id)")
        .in("status", ["ACTIVE"])
        .not("room_id", "is", null);
      if (buildingIds.length > 0) {
        occupiedRoomsQuery = occupiedRoomsQuery.in("rooms.building_id", buildingIds);
      }

      // Doanh thu tháng — respect bộ lọc toà (bản cũ bỏ qua: chọn toà nhưng
      // doanh thu vẫn là tổng mọi toà).
      let paymentsQuery = supabase
        .from("payments")
        .select(
          buildingId
            ? "amount, invoice:invoices!inner(building_id)"
            : "amount",
        )
        .gte("payment_date", monthStart.toISOString())
        .lte("payment_date", monthEnd.toISOString());
      if (buildingId) {
        paymentsQuery = (paymentsQuery as any).eq("invoice.building_id", buildingId);
      }

      // Công nợ — respect bộ lọc toà.
      let debtQuery = supabase
        .from("invoices")
        .select("total_amount, paid_amount")
        .in("status", ["APPROVED", "PARTIAL_PAID"])
        .is("deleted_at", null);
      if (buildingIds.length > 0) {
        debtQuery = debtQuery.in("building_id", buildingIds);
      }

      // 7 truy vấn độc lập — chạy SONG SONG (bản cũ await tuần tự từng cái,
      // cộng dồn ~7 round-trip latency mỗi 60s).
      const [
        totalRoomsRes,
        activeContractsRes,
        reservedRoomsRes,
        paymentsRes,
        unpaidInvoicesRes,
        newContractsRes,
        unresolvedIssuesRes,
      ] = await Promise.all([
        buildingIds.length > 0
          ? supabase
              .from("rooms")
              .select("*", { count: "exact", head: true })
              .in("building_id", buildingIds)
              .is("deleted_at", null)
          : Promise.resolve({ count: 0 } as any),
        occupiedRoomsQuery,
        buildingIds.length > 0
          ? supabase
              .from("rooms")
              .select("*", { count: "exact", head: true })
              .in("building_id", buildingIds)
              .is("deleted_at", null)
              .eq("status", "RESERVED")
          : Promise.resolve({ count: 0 } as any),
        paymentsQuery,
        debtQuery,
        supabase
          .from("contracts")
          .select("*", { count: "exact", head: true })
          .gte("created_at", monthStart.toISOString())
          .lte("created_at", monthEnd.toISOString()),
        supabase
          .from("issues")
          .select("*", { count: "exact", head: true })
          .not("status", "in", '("RESOLVED","CLOSED")'),
      ]);

      const totalRooms = totalRoomsRes.count || 0;
      const activeContracts = activeContractsRes.data;
      const reservedRooms = reservedRoomsRes.count || 0;
      const payments = paymentsRes.data;
      const unpaidInvoices = unpaidInvoicesRes.data;
      const newContracts = newContractsRes.count;
      const unresolvedIssues = unresolvedIssuesRes.count;

      const occupiedRooms = activeContracts?.length || 0;
      const availableRooms = Math.max(0, (totalRooms || 0) - occupiedRooms - reservedRooms);
      const occupancyRate = totalRooms ? (occupiedRooms / totalRooms) * 100 : 0;

      const revenueThisMonth =
        (payments as any[])?.reduce((sum, p) => sum + (Number(p.amount) || 0), 0) || 0;

      const totalDebt = unpaidInvoices?.reduce((sum, inv) => {
        const debt = (inv.total_amount || 0) - (inv.paid_amount || 0);
        return sum + debt;
      }, 0) || 0;

      return {
        totalRooms: totalRooms || 0,
        occupiedRooms,
        availableRooms,
        occupancyRate,
        revenueThisMonth,
        totalDebt,
        newContractsThisMonth: newContracts || 0,
        unresolvedIssues: unresolvedIssues || 0,
        reservedRooms,
      };
    },
    refetchInterval: 60000,
  });
};

// Revenue chart data (last 12 months)
// 1 QUERY cho cả kỳ rồi group theo tháng ở client — bản cũ bắn 12 query
// TUẦN TỰ (mỗi tháng 1 round-trip) khiến chart mất 1.5-2.5s mỗi lần mở
// Dashboard. Đồng thời respect bộ lọc toà (bản cũ bỏ qua buildingId).
export const useRevenueChart = (months: number = 12, buildingId?: string | null) => {
  return useQuery({
    queryKey: ["revenue-chart", months, buildingId],
    queryFn: async (): Promise<RevenueData[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const rangeStart = startOfMonth(subMonths(new Date(), months - 1));
      const rangeEnd = endOfMonth(new Date());

      let query = supabase
        .from("payments")
        .select(
          buildingId
            ? "amount, payment_date, invoice:invoices!inner(building_id)"
            : "amount, payment_date",
        )
        .gte("payment_date", rangeStart.toISOString())
        .lte("payment_date", rangeEnd.toISOString());
      if (buildingId) {
        query = query.eq("invoice.building_id", buildingId);
      }
      const { data: payments } = await query;

      // Khởi tạo đủ 12 tháng (tháng không có payment vẫn hiện 0).
      const byMonth = new Map<string, number>();
      const data: RevenueData[] = [];
      for (let i = months - 1; i >= 0; i--) {
        const key = format(subMonths(new Date(), i), "MM/yyyy");
        byMonth.set(key, 0);
        data.push({ month: key, revenue: 0 });
      }
      for (const p of (payments as any[]) || []) {
        const d = new Date(p.payment_date);
        if (Number.isNaN(d.getTime())) continue;
        const key = format(d, "MM/yyyy");
        if (byMonth.has(key)) {
          byMonth.set(key, (byMonth.get(key) || 0) + (Number(p.amount) || 0));
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

// Occupancy chart data
export const useOccupancyChart = (buildingId?: string | null) => {
  return useQuery({
    queryKey: ["occupancy-chart", buildingId],
    queryFn: async (): Promise<OccupancyData[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const buildingIds = await getBuildingIds(user.id, buildingId);

      let totalRooms = 0;
      if (buildingIds.length > 0) {
        const { count } = await supabase
          .from("rooms")
          .select("*", { count: "exact", head: true })
          .in("building_id", buildingIds)
          .is("deleted_at", null);
        totalRooms = count || 0;
      }

      // Get rooms by status
      let contractsQuery = supabase
        .from("contracts")
        .select("room_id, room:rooms!inner(building_id)")
        .in("status", ["ACTIVE"])
        .not("room_id", "is", null);

      if (buildingIds.length > 0) {
        contractsQuery = contractsQuery.in("rooms.building_id", buildingIds);
      }

      const { data: activeContracts } = await contractsQuery;

      // Phòng "cọc giữ chỗ" (RESERVED) — tách riêng, không gộp vào "Còn trống".
      let reservedRooms = 0;
      if (buildingIds.length > 0) {
        const { count: rc } = await supabase
          .from("rooms")
          .select("*", { count: "exact", head: true })
          .in("building_id", buildingIds)
          .is("deleted_at", null)
          .eq("status", "RESERVED");
        reservedRooms = rc || 0;
      }

      const occupiedRooms = activeContracts?.length || 0;
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
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const alerts: Alert[] = [];

      // Overdue invoices
      const { data: overdueInvoices } = await (supabase as any)
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

      const { data: expiringContracts } = await (supabase as any)
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
      const { data: depositShortContracts } = await (supabase as any)
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
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const activities: RecentActivity[] = [];

      // Recent contracts (last 7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const { data: recentContracts } = await (supabase as any)
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

      // Recent payments (last 7 days)
      const { data: recentPayments } = await (supabase as any)
        .from("payments")
        .select(
          `id, amount, payment_date,
           invoice:invoices(
             contract:contracts(
               contract_customers!contract_customers_contract_id_fkey(
                 is_representative,
                 customer:customers!contract_customers_customer_id_fkey(full_name)
               )
             )
           )`
        )
        .gte("payment_date", sevenDaysAgo.toISOString())
        .order("payment_date", { ascending: false })
        .limit(5);

      recentPayments?.forEach((payment: any) => {
        const customerName = getRepresentativeName(payment.invoice?.contract, "Khách hàng");
        activities.push({
          id: payment.id,
          type: "payment",
          title: "Thu tiền",
          description: customerName,
          date: payment.payment_date,
          amount: payment.amount,
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
