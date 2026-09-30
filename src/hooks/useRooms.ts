import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { confirmedRecordId, confirmedRecordBatch, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { RoomWithRelations } from "@/types/room";
import { compareBuildingThenRoom } from "@/lib/roomSort";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg, withOrgAll } from "@/lib/orgPayload";
import { nullIfNotFound } from "@/hooks/readErrors";
import { friendlyError } from "@/lib/friendlyError";

type Room = Database["public"]["Tables"]["rooms"]["Row"];
type RoomInsert = Database["public"]["Tables"]["rooms"]["Insert"];
type RoomUpdate = Database["public"]["Tables"]["rooms"]["Update"];

// Fetch all rooms (optionally filtered by building)
// options.enabled: dialog/dropdown gate fetch khi chưa cần (default true).
export const useRooms = (
  buildingId?: string,
  options?: { enabled?: boolean }
) => {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: buildingId ? ["rooms", "building", buildingId] : ["rooms"],
    queryFn: async () => {
      // PHÂN TRANG: key ["rooms"] được gọi org-wide (5 dialog dùng chung). Một
      // request trần chỉ lấy được 1000 dòng và PostgREST KHÔNG báo gì —
      // portfolio >1000 phòng thì dropdown thiếu phòng mà không ai biết.
      // `id` là tiebreaker duy nhất, bắt buộc để ranh giới trang không sót/trùng
      // (giao kèo ở đầu src/lib/supabaseFetchAll.ts).
      const rows = await fetchAllRows((from, to) => {
        let query = supabase
          .from("rooms")
          .select(`
            *,
            building:buildings(id, name, code)
          `)
          .is("deleted_at", null)
          .order("building_id", { ascending: true })
          .order("floor", { ascending: true })
          .order("name", { ascending: true })
          .order("id", { ascending: true });

        if (buildingId) {
          query = query.eq("building_id", buildingId);
        }

        return query.range(from, to);
      }, { label: buildingId ? "rooms-building" : "rooms" });

      if (rows === null) {
        // KHÔNG nuốt lỗi: throw để vào isError + retry (trước trả [] làm dropdown rỗng âm thầm).
        // fetchAllRows đã console.error chi tiết lỗi PostgREST.
        throw new Error("Không tải được danh sách căn hộ. Hãy thử lại.");
      }

      // Sắp xếp theo toà nhà rồi tên phòng (MB* → G* → L* → 1,2,3,4...) — áp dụng
      // cho mọi nơi dùng useRooms: dropdown chọn phòng, sơ đồ toà nhà, danh sách...
      const rooms = rows as unknown as RoomWithRelations[];
      return [...rooms].sort((a, b) =>
        compareBuildingThenRoom(
          a.building?.name ?? "",
          a.name ?? "",
          b.building?.name ?? "",
          b.name ?? "",
        ),
      );
    },
  });
};

// Fetch single room by ID
export const useRoom = (id: string) => {
  return useQuery({
    queryKey: ["rooms", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select(`
          *,
          building:buildings(id, name, code)
        `)
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) {
        return nullIfNotFound(error, "useRoom");
      }

      return data as unknown as RoomWithRelations | null;
    },
    enabled: !!id,
  });
};

// Room writes require positive receipts; feedback is emitted once by the hook.
const duplicateRoomRules = [{ code: '23505', message: /idx_rooms_unique_name_per_building/, description: 'Tên căn hộ đã có trong tòa nhà này.', fieldErrors: { name: 'Tên căn hộ đã có trong tòa nhà này.' } }];
export const useCreateRoom = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const guard = persistentFinancialWorkflow('room-create');
  const refresh = () => { queryClient.invalidateQueries({queryKey:['rooms']}); queryClient.invalidateQueries({queryKey:['buildings']}); };
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (room: RoomInsert) => {
      const payload = withOrg(room, selectedOrganizationId);
      return guard.run('create', 'tạo căn hộ', async () => {
        const {data,error} = await supabase.from('rooms').insert(withOrg(room,selectedOrganizationId)).select().single();
        if(error) throw error;
        confirmedRecordId(data, 'tạo căn hộ');
        return data;
      }, undefined, payload.organization_id);
    },
    onSuccess: data => { refresh(); toast.success(`Đã tạo căn hộ ${data.name || data.id}`); },
    onError: error => { refresh(); toast.error('Chưa tạo được căn hộ', {description:recordWriteMessage(error,'tạo căn hộ',{rules:duplicateRoomRules})}); },
  });
};
export const useUpdateRoom = () => {
  const queryClient = useQueryClient();
  const refresh = () => { queryClient.invalidateQueries({queryKey:['rooms']}); queryClient.invalidateQueries({queryKey:['buildings']}); };
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async ({id,updates}: {id:string;updates:RoomUpdate}) => {
      const {data,error} = await supabase.from('rooms').update(updates).eq('id',id).select().single();
      if(error) throw error;
      confirmedRecordId(data,'cập nhật căn hộ',id);
      return data;
    },
    onSuccess: data => { refresh(); toast.success(`Đã cập nhật căn hộ ${data.name || data.id}`); },
    onError: error => { refresh(); toast.error('Chưa cập nhật được căn hộ',{description:recordWriteMessage(error,'cập nhật căn hộ',{rules:duplicateRoomRules})}); },
  });
};
export const useDeleteRoom = () => {
  const queryClient = useQueryClient();
  const refresh = () => { queryClient.invalidateQueries({queryKey:['rooms']}); queryClient.invalidateQueries({queryKey:['buildings']}); };
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (id:string) => {
      const {data,error} = await supabase.from('rooms').update({deleted_at:new Date().toISOString()}).eq('id',id).select('id,name').single();
      if(error) throw error;
      confirmedRecordId(data,'xóa căn hộ',id);
      return data;
    },
    onSuccess: data => { refresh(); toast.success(`Đã xóa căn hộ ${data.name || data.id}`); },
    onError: error => { refresh(); toast.error('Chưa xóa được căn hộ',{description:recordWriteMessage(error,'xóa căn hộ')}); },
  });
};
export const useBulkCreateRooms = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const guard = persistentFinancialWorkflow('room-bulk-create');
  const refresh = () => { queryClient.invalidateQueries({queryKey:['rooms']}); queryClient.invalidateQueries({queryKey:['buildings']}); };
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (rooms:RoomInsert[]) => {
      if(!rooms.length) throw new Error('Chưa chọn căn hộ để tạo.');
      const payload=withOrgAll(rooms,selectedOrganizationId);
      if(new Set(payload.map(row=>row.organization_id)).size!==1) throw new Error('Các căn hộ phải thuộc cùng tổ chức.');
      return guard.run('create','tạo căn hộ hàng loạt',async()=>{
        const {data,error}=await supabase.from('rooms').insert(withOrgAll(rooms,selectedOrganizationId)).select();
        if(error) throw error;
        confirmedRecordBatch(data,rooms.length,'tạo căn hộ hàng loạt');
        return data;
      },undefined,payload[0]!.organization_id);
    },
    onSuccess: data => { refresh(); toast.success(`Đã tạo ${data.length} căn hộ. Mã: ${data.map(row=>row.name || row.id).join(', ')}.`); },
    onError: error => { refresh(); toast.error('Chưa hoàn tất tạo căn hộ hàng loạt',{description:recordWriteMessage(error,'tạo căn hộ hàng loạt',{rules:duplicateRoomRules})}); },
  });
};
export const useUpdateRoomStatus = () => {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({queryKey:['rooms']});
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async ({id,status}:{id:string;status:Database['public']['Enums']['room_status']}) => {
      const {data,error}=await supabase.from('rooms').update({status}).eq('id',id).select().single();
      if(error) throw error;
      confirmedRecordId(data,'đổi trạng thái căn hộ',id);
      if(data.status!==status) throw new FinancialWorkflowError('Chưa xác nhận được trạng thái căn hộ đã đổi. Tải lại căn hộ để đối chiếu trước khi đổi tiếp.','unknown',[{id,label:'Căn hộ cần đối chiếu'}]);
      return data;
    },
    onSuccess: data => { refresh(); toast.success(`Đã đổi trạng thái căn hộ ${data.name || data.id}.`); },
    onError: error => { refresh(); toast.error('Chưa đổi được trạng thái căn hộ',{description:recordWriteMessage(error,'đổi trạng thái căn hộ')}); },
  });
};
