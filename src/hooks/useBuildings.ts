import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { confirmedRecordId, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useOrganization } from '@/contexts/OrganizationContext';
import { withOrg } from '@/lib/orgPayload';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import type { BuildingStatus, BuildingWithRelations } from "@/types/building";
import { toast } from "sonner";
import { nullIfNotFound } from "@/hooks/readErrors";
import { friendlyError } from "@/lib/friendlyError";

type Building = Database["public"]["Tables"]["buildings"]["Row"];
type BuildingInsert = Database["public"]["Tables"]["buildings"]["Insert"];
type BuildingUpdate = Database["public"]["Tables"]["buildings"]["Update"];

// Fetch all buildings with areas (N-N qua area_buildings) and non-deleted rooms count.
// Mặc định ẩn tòa ảo (is_virtual=true) — nó là "bucket tài chính" gom thu/chi không
// thuộc toà thật (hiện là "Kho Văn Phòng Chung"), KHÔNG phải toà vật lý. Chỉ form/ô
// lọc thu chi & báo cáo tài chính truyền { includeVirtual: true } để chọn được nó.
export const useBuildings = (options?: {
  includeVirtual?: boolean;
  // enabled: dialog mounted-sẵn gate fetch khi đóng (default true).
  enabled?: boolean;
}) => {
  const includeVirtual = options?.includeVirtual ?? false;
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: ["buildings", { includeVirtual }],
    queryFn: async () => {
      let q = (supabase
        .from("buildings")
        .select(`
          *,
          area_links:area_buildings(area_id, area:areas(id, name, code)),
          rooms:rooms(count)
        `) as any)
        .is("deleted_at", null)
        .is("rooms.deleted_at", null);
      if (!includeVirtual) {
        q = q.eq("is_virtual", false);
      }
      const { data, error } = await q.order("created_at", { ascending: false });

      if (error) {
        // KHÔNG nuốt lỗi: throw để vào isError + retry (trước trả [] làm ô lọc toà rỗng âm thầm).
        console.error('useBuildings error:', error);
        throw error;
      }
      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách tòa nhà. Tải lại trước khi chọn tòa.');

      // Transform: rooms count + bung membership khu vực thành area_ids/areas
      return (data as any[]).map(building => ({
        ...building,
        rooms_count: building.rooms?.[0]?.count || 0,
        area_ids: (building.area_links || []).map((l: any) => l.area_id),
        areas: (building.area_links || []).map((l: any) => l.area).filter(Boolean),
      }));
    },
  });
};

// Fetch single building by ID
export const useBuilding = (id: string) => {
  return useQuery({
    queryKey: ["buildings", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("buildings")
        .select(`
          *,
          area_links:area_buildings(area_id, area:areas(id, name, code))
        `)
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) return nullIfNotFound(error, "useBuilding");

      return data
        ? {
            ...data,
            area_ids: (data.area_links || []).map((l: any) => l.area_id),
            areas: (data.area_links || []).map((l: any) => l.area).filter(Boolean),
          }
        : null;
    },
    enabled: !!id,
  });
};

// Confirm the core before any owner/service caller may continue.
export const useCreateBuilding = (options:{silentSuccess?:boolean}={}) => {
  const queryClient=useQueryClient();const {selectedOrganizationId}=useOrganization();
  const guard=persistentFinancialWorkflow('building-create');
  const refresh=()=>queryClient.invalidateQueries({queryKey:['buildings']});
  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn:async(building:Omit<BuildingInsert,'user_id'>)=>{
      const user=await getSessionUser();if(!user)throw new Error('Not authenticated');
      const payload=withOrg({...building,user_id:user.id},selectedOrganizationId);
      return guard.run('create','tạo tòa nhà',async()=>{
        const {data,error}=await supabase.from('buildings').insert(payload).select().single();
        if(error)throw error;confirmedRecordId(data,'tạo tòa nhà');return data;
      },undefined,payload.organization_id);
    },
    onSuccess:data=>{refresh();if(!options.silentSuccess)toast.success(`Đã tạo tòa nhà ${data.name || data.id}`);},
    onError:error=>{refresh();toast.error('Chưa tạo được tòa nhà',{description:recordWriteMessage(error,'tạo tòa nhà')});},
  });
};
export const useUpdateBuilding = (options:{silentSuccess?:boolean}={}) => {
  const queryClient=useQueryClient();const refresh=()=>queryClient.invalidateQueries({queryKey:['buildings']});
  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn:async({id,updates}:{id:string;updates:BuildingUpdate})=>{
      const {data,error}=await supabase.from('buildings').update(updates).eq('id',id).select().single();
      if(error)throw error;confirmedRecordId(data,'cập nhật tòa nhà',id);return data;
    },
    onSuccess:data=>{refresh();if(!options.silentSuccess)toast.success(`Đã cập nhật tòa nhà ${data.name || data.id}`);},
    onError:error=>{refresh();toast.error('Chưa cập nhật được tòa nhà',{description:recordWriteMessage(error,'cập nhật tòa nhà')});},
  });
};
// Soft delete building
export const useDeleteBuilding = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // First check if building has rooms
      const { data: rooms, error: checkError } = await supabase
        .from("rooms")
        .select("id")
        .eq("building_id", id)
        .is("deleted_at", null);

      if (checkError) throw checkError;
      if (!Array.isArray(rooms)) throw new Error('Chưa kiểm tra được các căn hộ của tòa nhà. Tải lại để kiểm tra.');

      if (rooms.length > 0) throw new Error(`Không thể xóa tòa nhà đang có ${rooms.length} căn hộ`);

      // Soft delete
      const { data, error } = await supabase
        .from("buildings")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select('id')
        .single();

      if (error) throw error;
      if (data?.id !== id) throw new Error('Chưa xác nhận được tòa nhà đã xóa. Tải lại danh sách để kiểm tra.');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      toast.success("Tòa nhà đã được xóa thành công");
    },
    onError: (error) => {
      if (error instanceof Error && /^Không thể xóa tòa nhà đang có \d+ căn hộ$/.test(error.message)) toast.error(error.message);
      else { const feedback = friendlyError(error, 'Chưa xóa được tòa nhà', { operation: 'xóa tòa nhà' }); toast.error(feedback.title, { description: feedback.description }); }
      console.error("Error deleting building:", error);
    },
  });
};


// Toggle building status with optimistic update
export const useUpdateBuildingStatus = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: BuildingStatus;
    }) => {
      const { data, error } = await supabase
        .from("buildings")
        .update({ status })
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      confirmedRecordId(data,'đổi trạng thái tòa nhà',id);
      if(data.status!==status)throw new FinancialWorkflowError('Chưa xác nhận được trạng thái tòa nhà đã đổi. Tải lại để đối chiếu.','unknown',[{id,label:'Tòa nhà cần đối chiếu'}]);
      return data;
    },
    onMutate: async ({ id, status }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["buildings"] });

      // Snapshot previous value
      const previousBuildings = queryClient.getQueryData<BuildingWithRelations[]>(["buildings"]);

      // Optimistically update the cache
      queryClient.setQueryData<BuildingWithRelations[]>(["buildings"], (old) =>
        old?.map((b) => (b.id === id ? { ...b, status } : b))
      );

      return { previousBuildings };
    },
    onError: (error, _variables, context) => {
      toast.error('Chưa đổi được trạng thái tòa nhà',{description:recordWriteMessage(error,'đổi trạng thái tòa nhà')});
      // Revert on error
      if (context?.previousBuildings) {
        queryClient.setQueryData(["buildings"], context.previousBuildings);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
    },
    onSuccess: data => {
      toast.success('Đã đổi trạng thái tòa nhà ' + (data.name || data.id) + '.');
    },
  });
};
