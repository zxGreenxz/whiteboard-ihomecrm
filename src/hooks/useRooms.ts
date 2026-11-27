import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { confirmedRecordId, recordWriteMessage, repeatableWrite } from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { RoomWithRelations } from "@/types/room";
import { compareBuildingThenRoom } from "@/lib/roomSort";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";
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
      // hermes-parity:begin w2d-rooms — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
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
      // hermes-parity:end w2d-rooms
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
/** Đợt 9: so trường đã gửi với dòng đọc lại (khoá jsonb xếp lại). Bỏ `user_id`: trigger máy chủ có thể đặt lại người đứng tên. */
const canonical = (value: unknown): string => JSON.stringify(value ?? null, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sentFieldsMatch = (saved: Record<string, unknown>, sent: Record<string, unknown>) => Object.keys(sent).every(key => key === 'user_id' || canonical(saved[key]) === canonical(sent[key]));
/**
 * Tên trùng một căn hộ KHÁC còn sống trong tòa (`idx_rooms_unique_name_per_building`, chỉ dòng chưa xoá): tra căn hộ đó để
 * câu từ chối nêu mã. Không thấy hoặc tra hỏng thì trả lời từ chối gốc (câu chung «Tên căn hộ đã có trong tòa nhà này»).
 */
async function roomNameTaken(error: unknown, room: RoomInsert): Promise<unknown> {
  const detail = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown; details?: unknown } : {};
  if (String(detail.code ?? '') !== '23505' || !/idx_rooms_unique_name_per_building/.test(`${String(detail.message ?? '')} ${String(detail.details ?? '')}`)) return error;
  try {
    const { data, error: readError } = await supabase.from('rooms').select('id,name').eq('building_id', room.building_id).eq('name', room.name).is('deleted_at', null).maybeSingle();
    if (!readError && data?.id) return new FinancialWorkflowError(`Căn hộ «${data.name}» đã có trong tòa nhà này (mã ${data.id}). Đặt tên khác, hoặc mở căn hộ đó để sửa.`, 'failure', [], error);
  } catch { /* Tra hỏng: giữ lời từ chối gốc, không đoán mã. */ }
  return error;
}
/**
 * Đợt 9 (luật 5): tạo căn hộ không giữ dấu «chờ đối chiếu» nào. Mã căn hộ do trình duyệt sinh (`createRecordOnce`; `rooms`
 * nhận `id`, không trigger BEFORE INSERT nào gán `id` — production 26/11/2026): kết quả chưa rõ báo «bấm lại» và không khoá
 * form; lần bấm lại cùng tòa + tên gửi ĐÚNG mã cũ nên khoá chính chặn căn hộ thứ hai. Dấu bản trước (khoá chung `create`,
 * công ty đang chọn) không còn chặn gì, gỡ sau lần tạo xong.
 */
export const useCreateRoom = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const refresh = () => { queryClient.invalidateQueries({queryKey:['rooms']}); queryClient.invalidateQueries({queryKey:['buildings']}); };
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (room: RoomInsert) => {
      const { getSessionUser } = await import('@/lib/authSession');
      const user = await getSessionUser();
      if (!user) throw { code: 'PGRST301', message: 'Not authenticated' };
      const payload = withOrg(room, selectedOrganizationId);
      const created = await repeatableWrite('tạo căn hộ', async () => {
        const { createRecordOnce, normalizeVietnameseName } = await import('@/lib/clientRecordCreate');
        const { row } = await createRecordOnce<Room>({
          table: 'rooms', userId: user.id, organizationId: payload.organization_id,
          matchKeys: [`b:${room.building_id}|n:${normalizeVietnameseName(room.name)}`],
          payload, operation: 'tạo căn hộ',
          sameAs: saved => sentFieldsMatch(saved, payload), describe: saved => `Căn hộ ${String(saved.name)}`,
        });
        return row;
      }).catch(async (error: unknown) => { throw await roomNameTaken(error, room); });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'room-create', businessKey: 'create' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần tạo sau gỡ lại. */ }
      return created;
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
