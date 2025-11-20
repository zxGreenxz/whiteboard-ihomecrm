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
// Will be implemented in Phase 19B

// ==================== TASK REPORTS ====================
// Will be implemented in Phase 19C
