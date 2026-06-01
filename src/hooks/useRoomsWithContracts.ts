import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface RoomWithContract {
  id: string;
  name: string;
  rent_price: number;
  floor: number;
  status: string;
  activeContract?: {
    id: string;
    end_date: string;
    tenant?: {
      full_name: string;
    };
  };
}

interface SupabaseContractRow {
  id: string;
  end_date: string;
  status: string;
  contract_customers?: Array<{
    is_representative: boolean;
    customer?: { id: string; full_name: string } | null;
  }>;
}

/**
 * Lấy danh sách phòng kèm hợp đồng ĐANG HIỆU LỰC (ACTIVE/EXTENDED). Join:
 *   rooms ⟵ contracts ⟵ contract_customers ⟵ customers
 * Khách đại diện được chọn làm "tenant"; nếu không có thì lấy khách đầu tiên.
 *
 * Truyền `buildingId` để giới hạn 1 toà; bỏ trống để lấy toàn bộ.
 * Dùng chung cho Sơ đồ toà nhà và Danh mục căn hộ.
 */
export const useRoomsWithActiveContracts = (buildingId?: string) => {
  return useQuery({
    queryKey: ["rooms-with-contracts", buildingId || "all"],
    queryFn: async (): Promise<RoomWithContract[]> => {
      let query = supabase
        .from("rooms")
        .select(
          `id, name, rent_price, floor, status, building_id,
           contracts!inner (
             id, end_date, status,
             contract_customers!contract_customers_contract_id_fkey (
               is_representative,
               customer:customers!contract_customers_customer_id_fkey ( id, full_name )
             )
           )`
        )
        .is("deleted_at", null)
        .in("contracts.status", ["ACTIVE", "EXTENDED"]) as any;

      if (buildingId) {
        query = query.eq("building_id", buildingId);
      }

      const { data, error } = await query;
      if (error) throw error;

      return (data || []).map((room: any) => {
        const c: SupabaseContractRow | undefined = room.contracts?.[0];
        const reps = c?.contract_customers || [];
        const repTenant =
          reps.find((cc) => cc.is_representative)?.customer || reps[0]?.customer;
        return {
          id: room.id,
          name: room.name,
          rent_price: room.rent_price,
          floor: room.floor,
          status: room.status,
          activeContract: c
            ? {
                id: c.id,
                end_date: c.end_date,
                tenant: repTenant ? { full_name: repTenant.full_name } : undefined,
              }
            : undefined,
        };
      });
    },
  });
};
