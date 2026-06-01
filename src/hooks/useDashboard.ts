import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { startOfMonth, endOfMonth, subMonths, format } from "date-fns";
import { getRepresentativeName } from "@/lib/contractCustomerHelpers";

export interface DashboardStats {
  totalRooms: number;
  occupiedRooms: number;
  availableRooms: number;
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
  type: "overdue_invoice" | "expiring_contract" | "urgent_issue";
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

      let totalRooms = 0;
      if (buildingIds.length > 0) {
        const { count } = await supabase
          .from("rooms")
          .select("*", { count: "exact", head: true })
          .in("building_id", buildingIds)
          .is("deleted_at", null);
        totalRooms = count || 0;
      }

      // Get occupied rooms (active contracts) - filter by room's building
      let occupiedRoomsQuery = supabase
        .from("contracts")
        .select("room_id, room:rooms!inner(building_id)")
        .in("status", ["ACTIVE", "EXTENDED"])
        .not("room_id", "is", null);

      if (buildingIds.length > 0) {
        occupiedRoomsQuery = occupiedRoomsQuery.in("rooms.building_id", buildingIds);
      }

      const { data: activeContracts } = await occupiedRoomsQuery;

      const occupiedRooms = activeContracts?.length || 0;
      const availableRooms = (totalRooms || 0) - occupiedRooms;
      const occupancyRate = totalRooms ? (occupiedRooms / totalRooms) * 100 : 0;

      // Get revenue this month
      const monthStart = startOfMonth(new Date());
      const monthEnd = endOfMonth(new Date());

      const { data: payments } = await supabase
        .from("payments")
        .select("amount")
        .gte("payment_date", monthStart.toISOString())
        .lte("payment_date", monthEnd.toISOString());

      const revenueThisMonth = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;

      // Get total debt (unpaid invoices - APPROVED or PARTIAL_PAID)
      const { data: unpaidInvoices } = await supabase
        .from("invoices")
        .select("total_amount, paid_amount")
        .in("status", ["APPROVED", "PARTIAL_PAID"]);

      const totalDebt = unpaidInvoices?.reduce((sum, inv) => {
        const debt = (inv.total_amount || 0) - (inv.paid_amount || 0);
        return sum + debt;
      }, 0) || 0;

      // Get new contracts this month
      const { count: newContracts } = await supabase
        .from("contracts")
        .select("*", { count: "exact", head: true })
        .gte("created_at", monthStart.toISOString())
        .lte("created_at", monthEnd.toISOString());

      // Get unresolved issues
      const { count: unresolvedIssues } = await supabase
        .from("issues")
        .select("*", { count: "exact", head: true })
        .not("status", "in", '("RESOLVED","CLOSED")');

      return {
        totalRooms: totalRooms || 0,
        occupiedRooms,
        availableRooms,
        occupancyRate,
        revenueThisMonth,
        totalDebt,
        newContractsThisMonth: newContracts || 0,
        unresolvedIssues: unresolvedIssues || 0,
      };
    },
    refetchInterval: 60000,
  });
};

// Revenue chart data (last 12 months)
export const useRevenueChart = (months: number = 12, buildingId?: string | null) => {
  return useQuery({
    queryKey: ["revenue-chart", months, buildingId],
    queryFn: async (): Promise<RevenueData[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const data: RevenueData[] = [];

      for (let i = months - 1; i >= 0; i--) {
        const monthDate = subMonths(new Date(), i);
        const monthStart = startOfMonth(monthDate);
        const monthEnd = endOfMonth(monthDate);

        const { data: payments } = await supabase
          .from("payments")
          .select("amount")
          .gte("payment_date", monthStart.toISOString())
          .lte("payment_date", monthEnd.toISOString());

        const revenue = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;

        data.push({
          month: format(monthDate, "MM/yyyy"),
          revenue,
        });
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
        .in("status", ["ACTIVE", "EXTENDED"])
        .not("room_id", "is", null);

      if (buildingIds.length > 0) {
        contractsQuery = contractsQuery.in("rooms.building_id", buildingIds);
      }

      const { data: activeContracts } = await contractsQuery;

      const occupiedRooms = activeContracts?.length || 0;
      const availableRooms = totalRooms - occupiedRooms;

      const total = totalRooms || 1;

      return [
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
        .in("status", ["ACTIVE", "EXTENDED"])
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
