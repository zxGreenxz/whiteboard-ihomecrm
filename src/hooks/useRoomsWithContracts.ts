import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabaseFetchAll";

export interface RoomWithContract {
  id: string;
  name: string;
  rent_price: number;
  floor: number;
  status: string;
  activeContract?: {
    id: string;
    end_date: string;
    /** Giá thuê GHI TRONG HỢP ĐỒNG — khác `rent_price` của phòng ở 44% hợp đồng. */
    rent_price: number | null;
    tenant?: {
      full_name: string;
    };
  };
}

/**
 * Hình dạng một dòng PostgREST trả về cho select ở dưới. Khai tường minh thay
 * vì `any` để `rows.map` được kiểm cột — `fetchAllRows` chỉ ràng buộc kiểu TRẢ
 * VỀ, nên đây là một khẳng định có tên và nhìn thấy được tại chỗ.
 */
interface SupabaseRoomRow {
  id: string;
  name: string;
  rent_price: number;
  floor: number;
  status: string;
  building_id: string | null;
  contracts?: SupabaseContractRow[];
}

interface SupabaseContractRow {
  id: string;
  end_date: string;
  rent_price: number | null;
  status: string;
  contract_customers?: Array<{
    is_representative: boolean;
    customer?: { id: string; full_name: string } | null;
  }>;
}

/**
 * Lấy danh sách phòng kèm hợp đồng ĐANG HIỆU LỰC (ACTIVE). Join:
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
      // PHÂN TRANG: RoomsPage gọi hook này KHÔNG kèm buildingId (org-wide), và
      // join 4 tầng làm mỗi dòng nặng. Không `.range()` thì PostgREST cắt ở 1000
      // phòng và sơ đồ toà nhà mất phòng mà không báo gì. `id` là tiebreaker duy
      // nhất; order phải ổn định thì ranh giới trang mới không sót/trùng.
      const rows = await fetchAllRows<SupabaseRoomRow>((from, to) => {
        let query = supabase
          .from("rooms")
          .select(
            `id, name, rent_price, floor, status, building_id,
             contracts!inner (
               id, end_date, rent_price, status,
               contract_customers!contract_customers_contract_id_fkey (
                 is_representative,
                 customer:customers!contract_customers_customer_id_fkey ( id, full_name )
               )
             )`
          )
          .is("deleted_at", null)
          .in("contracts.status", ["ACTIVE"])
          .order("id", { ascending: true }) as any;

        if (buildingId) {
          query = query.eq("building_id", buildingId);
        }

        return query.range(from, to);
      }, { label: "rooms-with-contracts" });

      if (rows === null) {
        // fetchAllRows fail-closed: null = LỖI, không phải "không có phòng nào".
        throw new Error("Không tải được danh sách phòng kèm hợp đồng. Hãy thử lại.");
      }

      return rows.map((room) => {
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
                rent_price: c.rent_price,
                tenant: repTenant ? { full_name: repTenant.full_name } : undefined,
              }
            : undefined,
        };
      });
    },
  });
};
