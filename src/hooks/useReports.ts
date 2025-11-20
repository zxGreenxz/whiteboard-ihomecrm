import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addDays, differenceInDays } from "date-fns";

// ==================== REAL ESTATE REPORTS ====================

/**
 * Get vacant rooms report
 * Returns list of currently vacant rooms with details
 */
export function useVacantRoomsReport() {
  return useQuery({
    queryKey: ["reports", "vacant-rooms"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select(`
          *,
          buildings (
            id,
            name,
            code
          ),
          contracts (
            id,
            end_date,
            status
          )
        `)
        .eq("status", "AVAILABLE")
        .order("building_id", { ascending: true })
        .order("room_number", { ascending: true });

      if (error) throw error;

      // Calculate days vacant for each room
      return data.map(room => {
        // Find the most recent ended contract
        const lastContract = room.contracts
          ?.filter((c: any) => c.status === "COMPLETED" || c.status === "CANCELLED")
          ?.sort((a: any, b: any) => new Date(b.end_date).getTime() - new Date(a.end_date).getTime())[0];

        const daysVacant = lastContract
          ? differenceInDays(new Date(), new Date(lastContract.end_date))
          : null;

        return {
          ...room,
          days_vacant: daysVacant,
          last_end_date: lastContract?.end_date,
        };
      });
    },
  });
}

/**
 * Get expiring contracts report
 * Returns contracts expiring within specified days
 */
export function useExpiringContractsReport(daysAhead: number = 30) {
  return useQuery({
    queryKey: ["reports", "expiring-contracts", daysAhead],
    queryFn: async () => {
      const today = new Date();
      const futureDate = addDays(today, daysAhead);

      const { data, error } = await supabase
        .from("contracts")
        .select(`
          *,
          rooms (
            id,
            room_number,
            buildings (
              name
            )
          ),
          tenants (
            id,
            full_name,
            phone,
            email
          )
        `)
        .eq("status", "ACTIVE")
        .gte("end_date", today.toISOString())
        .lte("end_date", futureDate.toISOString())
        .order("end_date", { ascending: true });

      if (error) throw error;

      return data.map(contract => ({
        ...contract,
        days_left: differenceInDays(new Date(contract.end_date), today),
      }));
    },
  });
}

/**
 * Get occupancy report
 * Returns occupancy statistics and trends
 */
export function useOccupancyReport() {
  return useQuery({
    queryKey: ["reports", "occupancy"],
    queryFn: async () => {
      // Get room statistics
      const { data: rooms, error: roomsError } = await supabase
        .from("rooms")
        .select("id, status, building_id, buildings (name)");

      if (roomsError) throw roomsError;

      // Calculate statistics
      const total = rooms.length;
      const occupied = rooms.filter(r => r.status === "OCCUPIED").length;
      const available = rooms.filter(r => r.status === "AVAILABLE").length;
      const maintenance = rooms.filter(r => r.status === "MAINTENANCE").length;
      const occupancyRate = total > 0 ? (occupied / total) * 100 : 0;

      // Group by building
      const byBuilding = rooms.reduce((acc: any, room) => {
        const buildingName = room.buildings?.name || "Unknown";
        if (!acc[buildingName]) {
          acc[buildingName] = { total: 0, occupied: 0, available: 0, maintenance: 0 };
        }
        acc[buildingName].total++;
        if (room.status === "OCCUPIED") acc[buildingName].occupied++;
        if (room.status === "AVAILABLE") acc[buildingName].available++;
        if (room.status === "MAINTENANCE") acc[buildingName].maintenance++;
        return acc;
      }, {});

      return {
        summary: {
          total,
          occupied,
          available,
          maintenance,
          occupancyRate: Number(occupancyRate.toFixed(2)),
        },
        byBuilding: Object.entries(byBuilding).map(([name, stats]: [string, any]) => ({
          building: name,
          ...stats,
          occupancyRate: Number(((stats.occupied / stats.total) * 100).toFixed(2)),
        })),
      };
    },
  });
}

/**
 * Get new leases report
 * Returns newly signed contracts within date range
 */
export function useNewLeasesReport(startDate?: Date, endDate?: Date) {
  return useQuery({
    queryKey: ["reports", "new-leases", startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      let query = supabase
        .from("contracts")
        .select(`
          *,
          rooms (
            id,
            room_number,
            buildings (name)
          ),
          tenants (
            id,
            full_name,
            phone
          )
        `)
        .eq("status", "ACTIVE")
        .order("start_date", { ascending: false });

      if (startDate) {
        query = query.gte("start_date", startDate.toISOString());
      }
      if (endDate) {
        query = query.lte("start_date", endDate.toISOString());
      }

      const { data, error } = await query;
      if (error) throw error;

      return data.map(contract => ({
        ...contract,
        total_value: contract.monthly_rent * contract.duration_months,
      }));
    },
  });
}

/**
 * Get terminations report
 * Returns cancelled/ended contracts within date range
 */
export function useTerminationsReport(startDate?: Date, endDate?: Date) {
  return useQuery({
    queryKey: ["reports", "terminations", startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      let query = supabase
        .from("contracts")
        .select(`
          *,
          rooms (
            id,
            room_number,
            buildings (name)
          ),
          tenants (
            id,
            full_name,
            phone
          )
        `)
        .in("status", ["CANCELLED", "COMPLETED"])
        .order("end_date", { ascending: false });

      if (startDate) {
        query = query.gte("end_date", startDate.toISOString());
      }
      if (endDate) {
        query = query.lte("end_date", endDate.toISOString());
      }

      const { data, error } = await query;
      if (error) throw error;

      return data.map(contract => ({
        ...contract,
        duration_actual: differenceInDays(
          new Date(contract.end_date),
          new Date(contract.start_date)
        ),
      }));
    },
  });
}

/**
 * Get price history report
 * Returns rent price changes over time
 */
export function usePriceHistoryReport() {
  return useQuery({
    queryKey: ["reports", "price-history"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contracts")
        .select(`
          id,
          monthly_rent,
          start_date,
          end_date,
          status,
          rooms (
            id,
            room_number,
            buildings (name)
          )
        `)
        .order("start_date", { ascending: false });

      if (error) throw error;

      // Group by room to show price changes
      const priceHistory = data.reduce((acc: any, contract) => {
        const roomKey = `${contract.rooms?.buildings?.name} - ${contract.rooms?.room_number}`;
        if (!acc[roomKey]) {
          acc[roomKey] = [];
        }
        acc[roomKey].push({
          contract_id: contract.id,
          rent: contract.monthly_rent,
          start_date: contract.start_date,
          end_date: contract.end_date,
          status: contract.status,
        });
        return acc;
      }, {});

      return Object.entries(priceHistory).map(([room, history]: [string, any]) => ({
        room,
        history: history.sort((a: any, b: any) =>
          new Date(b.start_date).getTime() - new Date(a.start_date).getTime()
        ),
        currentPrice: history[0]?.rent,
        priceChanges: history.length - 1,
      }));
    },
  });
}

/**
 * Get promotions report
 * Returns list of promotions and discounts
 */
export function usePromotionsReport() {
  return useQuery({
    queryKey: ["reports", "promotions"],
    queryFn: async () => {
      // Get contracts with discounts
      const { data, error } = await supabase
        .from("contracts")
        .select(`
          id,
          monthly_rent,
          discount_amount,
          discount_type,
          promotion_name,
          start_date,
          end_date,
          status,
          rooms (
            room_number,
            buildings (name)
          ),
          tenants (full_name)
        `)
        .or("discount_amount.gt.0,promotion_name.not.is.null")
        .order("start_date", { ascending: false });

      if (error) throw error;

      return data.map(contract => ({
        ...contract,
        savings: contract.discount_amount || 0,
        effective_rent: contract.monthly_rent - (contract.discount_amount || 0),
      }));
    },
  });
}

/**
 * Get contract changes report
 * Returns extensions, transfers, and reassignments
 */
export function useContractChangesReport(startDate?: Date, endDate?: Date) {
  return useQuery({
    queryKey: ["reports", "contract-changes", startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      let query = supabase
        .from("contracts")
        .select(`
          *,
          rooms (
            room_number,
            buildings (name)
          ),
          tenants (full_name, phone)
        `)
        .not("parent_contract_id", "is", null)
        .order("created_at", { ascending: false });

      if (startDate) {
        query = query.gte("created_at", startDate.toISOString());
      }
      if (endDate) {
        query = query.lte("created_at", endDate.toISOString());
      }

      const { data, error } = await query;
      if (error) throw error;

      return data.map(contract => ({
        ...contract,
        change_type: contract.parent_contract_id ? "EXTENSION" : "NEW",
      }));
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
