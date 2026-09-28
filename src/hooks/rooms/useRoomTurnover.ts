import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import { classifyDbError } from '@/lib/contracts/errors';
import {
  parseRoomTurnoverQueue,parseRoomTurnoverSnapshot,saveRoomTurnover,turnoverErrorMessage,
  type SaveRoomTurnoverInput,
} from '@/lib/contract-lifecycle/turnover';

export function useRoomTurnover(roomId:string) {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({
    queryKey:['room-turnover',selectedOrganizationId,roomId],
    enabled:Boolean(roomId&&selectedOrganizationId),staleTime:15_000,
    queryFn:async()=>{
      if(!selectedOrganizationId) throw new Error('Chưa chọn tổ chức');
      const {data,error}=await supabase.rpc('read_room_turnover_v1',{p_organization_id:selectedOrganizationId,p_room_id:roomId});
      if(error) throw error;
      const snapshot=parseRoomTurnoverSnapshot(data);
      if(snapshot.turnover&&(snapshot.turnover.room_id!==roomId||snapshot.turnover.organization_id!==selectedOrganizationId)) {
        throw new Error('Việc dọn/sửa không khớp phòng');
      }
      return snapshot;
    },
  });
}

export function useRoomTurnoverQueue(buildingIds:string[]=[],page=0,pageSize=25) {
  const { selectedOrganizationId }=useOrganization();
  const scope=[...buildingIds].sort();
  return useQuery({
    queryKey:['room-turnover','queue',selectedOrganizationId,scope,page,pageSize],
    enabled:Boolean(selectedOrganizationId),staleTime:15_000,refetchInterval:60_000,
    queryFn:async()=>{
      if(!selectedOrganizationId) throw new Error('Chưa chọn tổ chức');
      const {data,error}=await supabase.rpc('list_room_turnover_queue_v1',{
        p_organization_id:selectedOrganizationId,p_building_ids:scope.length?scope:undefined,p_limit:pageSize,p_offset:page*pageSize,
      });
      if(error) throw error;
      return parseRoomTurnoverQueue(data);
    },
  });
}

export function useSaveRoomTurnover() {
  const { selectedOrganizationId }=useOrganization();
  const queryClient=useQueryClient();
  const invalidate=()=>{
    for(const key of [['room-turnover'],['rooms'],['my-available-rooms']]) void queryClient.invalidateQueries({queryKey:key});
  };
  return useMutation({
    retry:false,
    mutationFn:async(input:Omit<SaveRoomTurnoverInput,'organizationId'>)=>{
      if(!selectedOrganizationId) throw new Error('Chưa chọn tổ chức');
      return saveRoomTurnover((_name,args)=>supabase.rpc('save_room_turnover_v1',args),{...input,organizationId:selectedOrganizationId});
    },
    onSuccess:()=>{invalidate();toast.success('Đã lưu theo dõi dọn/sửa');},
    onError:(error)=>{if(classifyDbError(error)==='conflict') invalidate();toast.error(turnoverErrorMessage(error));},
  });
}
