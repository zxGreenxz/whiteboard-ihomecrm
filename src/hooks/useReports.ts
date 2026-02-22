import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addDays, differenceInDays } from "date-fns";


// ==================== REAL ESTATE REPORTS ====================

/**
 * Get vacant rooms report
 * Returns rooms with status 'available' or no active contract
 */
export function useVacantRoomsReport(buildingId?: string, floorId?: string) {
  return useQuery({
    queryKey: ["reports", "vacant-rooms", buildingId, floorId],
    queryFn: async () => {
      // Get all rooms
      let roomsQuery = supabase
        .from("rooms")
        .select(`
          id,
          name,
          area,
          rent_price,
          status,
          description,
          floor,
          building_id,
          buildings (id, name)
        `)
        .is("deleted_at", null)
        .order("name", { ascending: true });

      if (buildingId) {
        roomsQuery = roomsQuery.eq("building_id", buildingId);
      }

      const { data: rooms, error: roomsError } = await roomsQuery;
      if (roomsError) throw roomsError;

      // Get active contracts to determine which rooms are occupied
      const { data: activeContracts, error: contractsError } = await supabase
        .from("contracts")
        .select("room_id, end_date")
        .in("status", ["ACTIVE", "DRAFT", "EXTENDED"])
        .is("deleted_at", null);

      if (contractsError) throw contractsError;

      const occupiedRoomIds = new Set(activeContracts?.map(c => c.room_id) || []);

      // Filter vacant rooms (not occupied)
      let vacantRooms = (rooms || [])
        .filter(room => !occupiedRoomIds.has(room.id))
        .map(room => {
          // Find the most recent ended contract for this room
          const lastContract = activeContracts?.find(c => c.room_id === room.id);
          const lastEndDate = lastContract?.end_date;
          const daysVacant = lastEndDate
            ? differenceInDays(new Date(), new Date(lastEndDate))
            : null;

          return {
            ...room,
            days_vacant: daysVacant,
            last_end_date: lastEndDate,
          };
        });

      // Filter by floor if provided
      if (floorId) {
        vacantRooms = vacantRooms.filter(room => String(room.floor) === floorId);
      }

      return vacantRooms;
    },
  });
}

/**
 * Get expiring contracts report
 * Returns rooms with contracts expiring within specified days
 */
export function useExpiringContractsReport(daysAhead: number = 30, buildingId?: string, floorId?: string) {
  return useQuery({
    queryKey: ["reports", "expiring-contracts", daysAhead, buildingId, floorId],
    queryFn: async () => {
      const today = new Date();
      const futureDate = addDays(today, daysAhead);

      const query = supabase
        .from("contracts")
        .select(`
          id,
          contract_number,
          start_date,
          end_date,
          rent_price,
          status,
          room_id,
          tenants (
            id,
            full_name,
            phone,
            email
          ),
          rooms (
            id,
            name,
            floor,
            building_id,
            buildings (id, name)
          )
        `)
        .eq("status", "ACTIVE")
        .is("deleted_at", null)
        .gte("end_date", today.toISOString())
        .lte("end_date", futureDate.toISOString())
        .order("end_date", { ascending: true });

      const { data, error } = await query;
      if (error) throw error;

      let contracts = (data || []).map(contract => ({
        ...contract,
        days_left: differenceInDays(new Date(contract.end_date), today),
      }));

      // Filter by building
      if (buildingId) {
        contracts = contracts.filter(c => c.rooms?.building_id === buildingId);
      }

      // Filter by floor
      if (floorId) {
        contracts = contracts.filter(c => String(c.rooms?.floor) === floorId);
      }

      return contracts;
    },
  });
}

/**
 * Get renewals and transfers report
 * Returns contracts with EXTENDED or TRANSFERRED status within a date range
 */
export function useRenewalsTransfersReport(
  startDate?: string,
  endDate?: string,
  buildingId?: string
) {
  return useQuery({
    queryKey: ["reports", "renewals-transfers", startDate, endDate, buildingId],
    queryFn: async () => {
      let query = supabase
        .from("contracts")
        .select(`
          id,
          contract_number,
          rent_price,
          status,
          updated_at,
          start_date,
          tenants (id, full_name),
          rooms (id, name, building_id, buildings (id, name))
        `)
        .in("status", ["EXTENDED", "TRANSFERRED"])
        .is("deleted_at", null)
        .order("updated_at", { ascending: false });

      if (startDate) {
        query = query.gte("updated_at", startDate);
      }
      if (endDate) {
        query = query.lte("updated_at", endDate);
      }

      const { data, error } = await query;
      if (error) throw error;

      let results = data || [];

      if (buildingId) {
        results = results.filter((c) => c.rooms?.building_id === buildingId);
      }

      return results;
    },
  });
}

/**
 * Get occupancy report
 * Returns occupancy rates per building with optional building filter
 */
export function useOccupancyReport(buildingId?: string) {
  return useQuery({
    queryKey: ["reports", "occupancy", buildingId],
    queryFn: async () => {
      let roomsQuery = supabase
        .from("rooms")
        .select(`id, name, status, building_id, buildings (id, name)`)
        .is("deleted_at", null);

      if (buildingId) {
        roomsQuery = roomsQuery.eq("building_id", buildingId);
      }

      const { data: rooms, error: roomsError } = await roomsQuery;
      if (roomsError) throw roomsError;

      const { data: activeContracts, error: contractsError } = await supabase
        .from("contracts")
        .select("room_id")
        .in("status", ["ACTIVE", "EXTENDED"])
        .is("deleted_at", null);
      if (contractsError) throw contractsError;

      const occupiedRoomIds = new Set(activeContracts?.map(c => c.room_id) || []);

      const buildingMap: Record<string, { building: string; total: number; occupied: number; available: number; maintenance: number }> = {};

      (rooms || []).forEach(room => {
        const bName = room.buildings?.name || "Không xác định";
        if (!buildingMap[bName]) {
          buildingMap[bName] = { building: bName, total: 0, occupied: 0, available: 0, maintenance: 0 };
        }
        buildingMap[bName].total++;
        if (occupiedRoomIds.has(room.id)) {
          buildingMap[bName].occupied++;
        } else if (room.status === "MAINTENANCE") {
          buildingMap[bName].maintenance++;
        } else {
          buildingMap[bName].available++;
        }
      });

      const byBuilding = Object.values(buildingMap).map(b => ({
        ...b,
        occupancyRate: b.total > 0 ? Number(((b.occupied / b.total) * 100).toFixed(1)) : 0,
      }));

      const totalRooms = (rooms || []).length;
      const totalOccupied = byBuilding.reduce((s, b) => s + b.occupied, 0);
      const totalAvailable = byBuilding.reduce((s, b) => s + b.available, 0);
      const totalMaintenance = byBuilding.reduce((s, b) => s + b.maintenance, 0);

      return {
        summary: {
          total: totalRooms,
          occupied: totalOccupied,
          available: totalAvailable,
          maintenance: totalMaintenance,
          occupancyRate: totalRooms > 0 ? Number(((totalOccupied / totalRooms) * 100).toFixed(1)) : 0,
        },
        byBuilding,
      };
    },
  });
}

/**
 * Get monthly occupancy trend data for the last 12 months
 */
export function useOccupancyTrend(buildingId?: string) {
  return useQuery({
    queryKey: ["reports", "occupancy-trend", buildingId],
    queryFn: async () => {
      let roomsQuery = supabase
        .from("rooms")
        .select("id, building_id")
        .is("deleted_at", null);

      if (buildingId) {
        roomsQuery = roomsQuery.eq("building_id", buildingId);
      }

      const { data: rooms, error: roomsError } = await roomsQuery;
      if (roomsError) throw roomsError;

      const totalRooms = (rooms || []).length;
      if (totalRooms === 0) return [];

      const roomIds = new Set((rooms || []).map(r => r.id));

      const { data: contracts, error: contractsError } = await supabase
        .from("contracts")
        .select("room_id, start_date, end_date, status")
        .in("status", ["ACTIVE", "EXTENDED", "TERMINATED", "EXPIRED"])
        .is("deleted_at", null);
      if (contractsError) throw contractsError;

      const months: { month: string; rate: number; occupied: number; total: number }[] = [];
      const now = new Date();

      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        const monthLabel = `${d.getMonth() + 1}/${d.getFullYear()}`;

        const occupiedCount = (contracts || []).filter(c => {
          if (!roomIds.has(c.room_id)) return false;
          const start = new Date(c.start_date);
          const end = new Date(c.end_date);
          return start <= monthEnd && end >= d;
        }).length;

        months.push({
          month: monthLabel,
          rate: totalRooms > 0 ? Number(((occupiedCount / totalRooms) * 100).toFixed(1)) : 0,
          occupied: occupiedCount,
          total: totalRooms,
        });
      }

      return months;
    },
  });
}

// ==================== FINANCE REPORTS ====================

/**
 * Get cash book report
 * Returns daily cash transactions with running balance
 */
export function useCashBookReport(startDate?: Date, endDate?: Date) {
  return useQuery({
    queryKey: ["reports", "cash-book", startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      // Get payments (income)
      let paymentsQuery = supabase
        .from("payments")
        .select(`
          id,
          amount,
          payment_date,
          payment_method,
          notes,
          invoices (
            invoice_number,
            tenants (full_name)
          )
        `)
        .order("payment_date", { ascending: true });

      if (startDate) {
        paymentsQuery = paymentsQuery.gte("payment_date", startDate.toISOString());
      }
      if (endDate) {
        paymentsQuery = paymentsQuery.lte("payment_date", endDate.toISOString());
      }

      const { data: payments, error: paymentsError } = await paymentsQuery;
      if (paymentsError) throw paymentsError;

      // Transform into cash book entries
      const entries = payments?.map(payment => ({
        date: payment.payment_date,
        type: "INCOME" as const,
        description: `Thanh toán từ ${payment.invoices?.tenants?.full_name || "N/A"} - ${payment.invoices?.invoice_number || ""}`,
        amount: payment.amount,
        method: payment.payment_method,
        notes: payment.notes,
      })) || [];

      // Calculate running balance
      let runningBalance = 0;
      return entries.map(entry => {
        runningBalance += entry.type === "INCOME" ? entry.amount : -entry.amount;
        return {
          ...entry,
          balance: runningBalance,
        };
      });
    },
  });
}

/**
 * Get cash flow report
 * Returns income vs expense with net flow
 */
export function useCashFlowReport(startDate?: Date, endDate?: Date) {
  return useQuery({
    queryKey: ["reports", "cash-flow", startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      // Get payments (income)
      let paymentsQuery = supabase
        .from("payments")
        .select("amount, payment_date")
        .order("payment_date", { ascending: true });

      if (startDate) {
        paymentsQuery = paymentsQuery.gte("payment_date", startDate.toISOString());
      }
      if (endDate) {
        paymentsQuery = paymentsQuery.lte("payment_date", endDate.toISOString());
      }

      const { data: payments, error: paymentsError } = await paymentsQuery;
      if (paymentsError) throw paymentsError;

      // Group by month
      const monthlyData: Record<string, { income: number; expense: number }> = {};

      payments?.forEach(payment => {
        const month = payment.payment_date.substring(0, 7); // YYYY-MM
        if (!monthlyData[month]) {
          monthlyData[month] = { income: 0, expense: 0 };
        }
        monthlyData[month].income += payment.amount;
      });

      return Object.entries(monthlyData).map(([month, data]) => ({
        month,
        income: data.income,
        expense: data.expense,
        netFlow: data.income - data.expense,
      }));
    },
  });
}

/**
 * Get debt report with aging analysis
 * Returns debts categorized by age (0-30, 31-60, 61-90, >90 days)
 */
export function useDebtReport() {
  return useQuery({
    queryKey: ["reports", "debt"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          id,
          invoice_number,
          amount,
          amount_paid,
          due_date,
          status,
          created_at,
          tenants (
            id,
            full_name,
            phone
          ),
          rooms (
            room_number,
            buildings (name)
          )
        `)
        .eq("status", "PENDING")
        .order("due_date", { ascending: true });

      if (error) throw error;

      const today = new Date();
      return data.map(invoice => {
        const daysOverdue = differenceInDays(today, new Date(invoice.due_date));
        const remainingAmount = invoice.amount - (invoice.amount_paid || 0);

        let agingCategory = "0-30";
        if (daysOverdue > 90) agingCategory = ">90";
        else if (daysOverdue > 60) agingCategory = "61-90";
        else if (daysOverdue > 30) agingCategory = "31-60";

        return {
          ...invoice,
          days_overdue: Math.max(0, daysOverdue),
          remaining_amount: remainingAmount,
          aging_category: agingCategory,
        };
      });
    },
  });
}

/**
 * Get customer debt report
 * Returns customers with outstanding debts
 */
export function useCustomerDebtReport() {
  return useQuery({
    queryKey: ["reports", "customer-debt"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          id,
          amount,
          amount_paid,
          due_date,
          tenants (
            id,
            full_name,
            phone,
            email
          ),
          rooms (
            room_number,
            buildings (name)
          )
        `)
        .eq("status", "PENDING")
        .order("due_date", { ascending: true });

      if (error) throw error;

      // Group by tenant
      const tenantDebts: Record<string, any> = {};
      data.forEach(invoice => {
        const tenantId = invoice.tenants?.id;
        if (!tenantId) return;

        if (!tenantDebts[tenantId]) {
          tenantDebts[tenantId] = {
            tenant: invoice.tenants,
            room: invoice.rooms,
            totalDebt: 0,
            invoiceCount: 0,
            oldestDueDate: invoice.due_date,
            invoices: [],
          };
        }

        const remaining = invoice.amount - (invoice.amount_paid || 0);
        tenantDebts[tenantId].totalDebt += remaining;
        tenantDebts[tenantId].invoiceCount++;
        tenantDebts[tenantId].invoices.push(invoice);
      });

      return Object.values(tenantDebts).map((debt: any) => ({
        ...debt,
        daysOverdue: differenceInDays(new Date(), new Date(debt.oldestDueDate)),
      }));
    },
  });
}

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
          tenants (full_name, phone),
          rooms (room_number, buildings (name))
        `)
        .lte("due_date", futureDate.toISOString())
        .order("due_date", { ascending: true });

      if (error) throw error;

      return data.map(invoice => ({
        ...invoice,
        days_until_due: differenceInDays(new Date(invoice.due_date), today),
        remaining_amount: invoice.amount - (invoice.amount_paid || 0),
      }));
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
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          id,
          amount,
          amount_paid,
          tenants (
            id,
            full_name,
            phone
          ),
          rooms (
            room_number,
            buildings (name)
          )
        `)
        .gt("amount_paid", 0);

      if (error) throw error;

      // Filter for overpayments
      return data
        .filter(invoice => (invoice.amount_paid || 0) > invoice.amount)
        .map(invoice => ({
          ...invoice,
          overpaid_amount: (invoice.amount_paid || 0) - invoice.amount,
        }));
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
      const { data, error } = await supabase
        .from("deposits")
        .select(`
          *,
          leads (
            id,
            full_name,
            phone,
            email
          ),
          rooms (
            room_number,
            buildings (name)
          )
        `)
        .order("deposit_date", { ascending: false });

      if (error) throw error;

      return data.map(deposit => ({
        ...deposit,
        days_held: differenceInDays(new Date(), new Date(deposit.deposit_date)),
      }));
    },
  });
}

/**
 * Get profit distribution report
 * Returns revenue breakdown and profit analysis
 */
export function useProfitDistributionReport(startDate?: Date, endDate?: Date) {
  return useQuery({
    queryKey: ["reports", "profit-distribution", startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      // Get total revenue (paid invoices)
      let revenueQuery = supabase
        .from("invoices")
        .select("amount, amount_paid")
        .eq("status", "PAID");

      if (startDate) {
        revenueQuery = revenueQuery.gte("created_at", startDate.toISOString());
      }
      if (endDate) {
        revenueQuery = revenueQuery.lte("created_at", endDate.toISOString());
      }

      const { data: invoices, error: invoicesError } = await revenueQuery;
      if (invoicesError) throw invoicesError;

      const totalRevenue = invoices?.reduce((sum, inv) => sum + (inv.amount_paid || inv.amount), 0) || 0;

      // Get total expenses
      let expensesQuery = supabase
        .from("expenses")
        .select("amount, category");

      if (startDate) {
        expensesQuery = expensesQuery.gte("expense_date", startDate.toISOString().split('T')[0]);
      }
      if (endDate) {
        expensesQuery = expensesQuery.lte("expense_date", endDate.toISOString().split('T')[0]);
      }

      const { data: expenses, error: expensesError } = await expensesQuery;
      if (expensesError) throw expensesError;

      const totalExpenses = expenses?.reduce((sum, exp) => sum + (exp.amount || 0), 0) || 0;
      const netProfit = totalRevenue - totalExpenses;
      const profitMargin = totalRevenue > 0 ? Number(((netProfit / totalRevenue) * 100).toFixed(2)) : 0;

      // Calculate revenue breakdown by invoice type (if available)
      // For now, treat all as rent revenue
      return {
        totalRevenue,
        totalExpenses,
        netProfit,
        profitMargin,
        breakdown: {
          rent: totalRevenue,
          services: 0,
          other: 0,
        },
      };
    },
  });
}

// ==================== TASK REPORTS ====================

/**
 * Get tasks overview report
 * Returns summary statistics of all tasks
 */
export function useTasksOverviewReport() {
  return useQuery({
    queryKey: ["reports", "tasks-overview"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("issues")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;

      const total = data.length;
      const completed = data.filter(t => t.status === "RESOLVED").length;
      const inProgress = data.filter(t => t.status === "IN_PROGRESS").length;
      const pending = data.filter(t => t.status === "OPEN").length;
      const overdue = data.filter(t => {
        if (!t.due_date || t.status === "RESOLVED") return false;
        return new Date(t.due_date) < new Date();
      }).length;

      // Group by priority
      const byPriority = {
        HIGH: data.filter(t => t.priority === "HIGH").length,
        MEDIUM: data.filter(t => t.priority === "MEDIUM").length,
        LOW: data.filter(t => t.priority === "LOW").length,
      };

      // Group by category
      const byCategory = data.reduce((acc: Record<string, number>, task) => {
        const category = task.category || "OTHER";
        acc[category] = (acc[category] || 0) + 1;
        return acc;
      }, {});

      return {
        summary: {
          total,
          completed,
          inProgress,
          pending,
          overdue,
          completionRate: total > 0 ? Number(((completed / total) * 100).toFixed(1)) : 0,
        },
        byPriority,
        byCategory,
        recentTasks: data.slice(0, 10),
      };
    },
  });
}

/**
 * Get tasks by staff report
 * Returns task distribution and performance by staff member
 */
export function useTasksByStaffReport() {
  return useQuery({
    queryKey: ["reports", "tasks-by-staff"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("issues")
        .select(`
          *,
          assigned_to_user:assigned_to (
            id,
            email,
            raw_user_meta_data
          )
        `)
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Group by staff
      const staffTasks: Record<string, any> = {};

      data.forEach(task => {
        const staffId = task.assigned_to || "unassigned";
        const staffName = task.assigned_to_user?.raw_user_meta_data?.full_name ||
                         task.assigned_to_user?.email ||
                         "Chưa phân công";

        if (!staffTasks[staffId]) {
          staffTasks[staffId] = {
            staffId,
            staffName,
            total: 0,
            completed: 0,
            inProgress: 0,
            pending: 0,
            overdue: 0,
            tasks: [],
          };
        }

        staffTasks[staffId].total++;
        staffTasks[staffId].tasks.push(task);

        if (task.status === "RESOLVED") staffTasks[staffId].completed++;
        else if (task.status === "IN_PROGRESS") staffTasks[staffId].inProgress++;
        else if (task.status === "OPEN") staffTasks[staffId].pending++;

        if (task.due_date && new Date(task.due_date) < new Date() && task.status !== "RESOLVED") {
          staffTasks[staffId].overdue++;
        }
      });

      return Object.values(staffTasks).map((staff: any) => ({
        ...staff,
        completionRate: staff.total > 0 ? Number(((staff.completed / staff.total) * 100).toFixed(1)) : 0,
      }));
    },
  });
}

/**
 * Get tasks by room report
 * Returns maintenance and repair history for each room
 */
export function useTasksByRoomReport() {
  return useQuery({
    queryKey: ["reports", "tasks-by-room"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("issues")
        .select(`
          *,
          rooms (
            id,
            room_number,
            buildings (name)
          )
        `)
        .not("room_id", "is", null)
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Group by room
      const roomTasks: Record<string, any> = {};

      data.forEach(task => {
        const roomId = task.room_id;
        if (!roomId) return;

        const roomKey = `${task.rooms?.buildings?.name} - ${task.rooms?.room_number}`;

        if (!roomTasks[roomKey]) {
          roomTasks[roomKey] = {
            room: task.rooms,
            roomDisplay: roomKey,
            total: 0,
            completed: 0,
            inProgress: 0,
            pending: 0,
            tasks: [],
          };
        }

        roomTasks[roomKey].total++;
        roomTasks[roomKey].tasks.push(task);

        if (task.status === "RESOLVED") roomTasks[roomKey].completed++;
        else if (task.status === "IN_PROGRESS") roomTasks[roomKey].inProgress++;
        else if (task.status === "OPEN") roomTasks[roomKey].pending++;
      });

      return Object.values(roomTasks).map((room: any) => ({
        ...room,
        completionRate: room.total > 0 ? Number(((room.completed / room.total) * 100).toFixed(1)) : 0,
      }));
    },
  });
}

// ==================== PROMOTIONS, NEW LEASES, TERMINATIONS REPORTS ====================

/**
 * Get promotions report - contracts with discounts
 */
export function usePromotionsReport(startDate?: Date, endDate?: Date, buildingId?: string) {
  return useQuery({
    queryKey: ["reports", "promotions", startDate?.toISOString(), endDate?.toISOString(), buildingId],
    queryFn: async () => {
      let query = supabase
        .from("contracts")
        .select(`
          id,
          contract_number,
          rent_price,
          discounts,
          status,
          start_date,
          end_date,
          signed_date,
          tenants:tenant_id (full_name, phone),
          rooms:room_id (
            id,
            room_number,
            buildings:building_id (id, name)
          )
        `)
        .not("discounts", "is", null)
        .is("deleted_at", null)
        .order("signed_date", { ascending: false });

      if (startDate) {
        query = query.gte("signed_date", startDate.toISOString());
      }
      if (endDate) {
        query = query.lte("signed_date", endDate.toISOString());
      }

      const { data, error } = await query;
      if (error) throw error;

      // Filter by building if specified
      let filtered = data || [];
      if (buildingId) {
        filtered = filtered.filter((c: any) => c.rooms?.buildings?.id === buildingId);
      }

      return filtered.map((contract: any) => {
        const discounts = contract.discounts as any;
        const discountAmount = discounts?.amount || discounts?.value || 0;
        const discountType = discounts?.type || "fixed";
        const savings = discountType === "percent"
          ? (contract.rent_price * discountAmount) / 100
          : discountAmount;
        const effectiveRent = contract.rent_price - savings;

        return {
          ...contract,
          monthly_rent: contract.rent_price,
          discount_amount: discountAmount,
          discount_type: discountType === "percent" ? "Phần trăm" : "Cố định",
          promotion_name: discounts?.name || discounts?.description || null,
          savings,
          effective_rent: effectiveRent > 0 ? effectiveRent : 0,
        };
      });
    },
  });
}

/**
 * Get new leases report - contracts created in period
 */
export function useNewLeasesReport(startDate?: Date, endDate?: Date, buildingId?: string) {
  return useQuery({
    queryKey: ["reports", "new-leases", startDate?.toISOString(), endDate?.toISOString(), buildingId],
    queryFn: async () => {
      let query = supabase
        .from("contracts")
        .select(`
          id,
          contract_number,
          rent_price,
          total_deposit,
          start_date,
          end_date,
          signed_date,
          status,
          payment_cycle,
          tenants:tenant_id (full_name, phone),
          rooms:room_id (
            id,
            room_number,
            buildings:building_id (id, name)
          )
        `)
        .is("deleted_at", null)
        .order("signed_date", { ascending: false });

      if (startDate) {
        query = query.gte("signed_date", startDate.toISOString());
      }
      if (endDate) {
        query = query.lte("signed_date", endDate.toISOString());
      }

      const { data, error } = await query;
      if (error) throw error;

      let filtered = data || [];
      if (buildingId) {
        filtered = filtered.filter((c: any) => c.rooms?.buildings?.id === buildingId);
      }

      return filtered.map((contract: any) => {
        const start = new Date(contract.start_date);
        const end = new Date(contract.end_date);
        const durationMonths = Math.max(1, Math.round(differenceInDays(end, start) / 30));
        const totalValue = contract.rent_price * durationMonths;

        return {
          ...contract,
          monthly_rent: contract.rent_price,
          deposit_amount: contract.total_deposit,
          duration_months: durationMonths,
          total_value: totalValue,
        };
      });
    },
  });
}

/**
 * Get terminations report - terminated/cancelled contracts
 */
export function useTerminationsReport(startDate?: Date, endDate?: Date, buildingId?: string) {
  return useQuery({
    queryKey: ["reports", "terminations", startDate?.toISOString(), endDate?.toISOString(), buildingId],
    queryFn: async () => {
      // Get terminated contracts
      let query = supabase
        .from("contracts")
        .select(`
          id,
          contract_number,
          rent_price,
          total_deposit,
          start_date,
          end_date,
          actual_end_date,
          signed_date,
          status,
          tenants:tenant_id (full_name, phone),
          rooms:room_id (
            id,
            room_number,
            buildings:building_id (id, name)
          )
        `)
        .in("status", ["TERMINATED", "EXPIRED"])
        .is("deleted_at", null)
        .order("actual_end_date", { ascending: false });

      if (startDate) {
        query = query.gte("actual_end_date", startDate.toISOString());
      }
      if (endDate) {
        query = query.lte("actual_end_date", endDate.toISOString());
      }

      const { data: contracts, error: contractsError } = await query;
      if (contractsError) throw contractsError;

      // Get termination details
      const contractIds = (contracts || []).map(c => c.id);
      let terminations: any[] = [];
      if (contractIds.length > 0) {
        const { data: termData } = await supabase
          .from("contract_terminations")
          .select("contract_id, termination_type, termination_date, notes")
          .in("contract_id", contractIds);
        terminations = termData || [];
      }

      const termMap = new Map(terminations.map(t => [t.contract_id, t]));

      let filtered = contracts || [];
      if (buildingId) {
        filtered = filtered.filter((c: any) => c.rooms?.buildings?.id === buildingId);
      }

      // Get total contracts count for termination rate
      const { count: totalContracts } = await supabase
        .from("contracts")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null);

      return {
        items: filtered.map((contract: any) => {
          const term = termMap.get(contract.id);
          const endDate = contract.actual_end_date || contract.end_date;
          const durationActual = differenceInDays(new Date(endDate), new Date(contract.start_date));

          return {
            ...contract,
            termination_reason: term?.notes || term?.termination_type || null,
            termination_type: term?.termination_type || (contract.status === "EXPIRED" ? "Hết hạn" : "Thanh lý"),
            duration_actual: durationActual,
          };
        }),
        totalContracts: totalContracts || 0,
        terminationRate: totalContracts && totalContracts > 0
          ? Number(((filtered.length / totalContracts) * 100).toFixed(1))
          : 0,
      };
    },
  });
}
