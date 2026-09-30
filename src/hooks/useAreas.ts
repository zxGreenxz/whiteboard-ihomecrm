import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { confirmedRecordId, recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { nullIfNotFound } from "@/hooks/readErrors";
import { friendlyError } from "@/lib/friendlyError";

export class AreaMembershipPartialError extends Error {
  constructor(public readonly areaId: string, public readonly removedBuildingIds: readonly string[], public readonly cause: unknown) {
    super(`Đã gỡ ${removedBuildingIds.length} tòa khỏi khu vực nhưng chưa gán được tòa mới. Tải lại danh sách để kiểm tra khu vực trước khi sửa tiếp.`);
    this.name = "AreaMembershipPartialError";
  }
}

export class AreaDeletePartialError extends FinancialWorkflowError {
  constructor(public readonly areaId: string, cause: unknown) {
    super(`Khu vực ${areaId} đã xóa mềm nhưng chưa gỡ xong khỏi các tòa. Tải lại khu vực và tòa để đối chiếu; không xóa lại khu này.`, 'partial', cause instanceof FinancialWorkflowError ? cause.completed : [{id:areaId,label:'Khu vực đã xoá mềm'}], cause);
  }
}

type AreaInsert = Database["public"]["Tables"]["areas"]["Insert"];
type AreaUpdate = Database["public"]["Tables"]["areas"]["Update"];

// Fetch all areas with buildings count
export const useAreas = () => {
  return useQuery({
    queryKey: ["areas"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("areas")
        .select(`
          *,
          members:area_buildings(count)
        `)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (error) {
        console.error('useAreas error:', error);
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa tải được danh sách khu vực.');
      return data.map(area => ({
        ...area,
        buildings_count: area.members?.[0]?.count || 0
      }));
    },
  });
};

// Fetch single area by ID
export const useArea = (id: string) => {
  return useQuery({
    queryKey: ["areas", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("areas")
        .select(`*`)
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) return nullIfNotFound(error, "useArea");

      if (!data?.id || data.id !== id) throw new Error('Chưa xác nhận được thông tin khu vực.');
      return data;
    },
    enabled: !!id,
  });
};

// Create new area
export const useCreateArea = () => {
  const queryClient = useQueryClient();
  const guard=persistentFinancialWorkflow('area-write',{scope:'actor'});

  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (area: Omit<AreaInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      return guard.run('new','tạo khu vực',async(progress)=>{
      const { data, error } = await supabase
        .from("areas")
        .insert({
          ...area,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      const savedId=confirmedRecordId(data,'tạo khu vực');
      progress.completed.push({id:savedId,label:'Khu vực đã nhận mã'});
      return data;
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      toast.success("Khu vực đã được tạo thành công");
    },
    onError: (error) => {
      queryClient.invalidateQueries({queryKey:['areas']});
      toast.error(recordWriteMessage(error,'tạo khu vực'));
      console.error("Error creating area:", error);
    },
  });
};

// Update existing area
export const useUpdateArea = () => {
  const queryClient = useQueryClient();
  const guard=persistentFinancialWorkflow('area-write',{scope:'actor'});

  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: AreaUpdate;
    }) => {
      return guard.run(id,'cập nhật khu vực',async(progress)=>{
      const { data, error } = await supabase
        .from("areas")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      const savedId=confirmedRecordId(data,'cập nhật khu vực',id);
      progress.completed.push({id:savedId,label:'Khu vực đã nhận mã'});
      return data;
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      queryClient.invalidateQueries({ queryKey: ["areas", data.id] });
      toast.success("Khu vực đã được cập nhật thành công");
    },
    onError: (error) => {
      queryClient.invalidateQueries({queryKey:['areas']});
      toast.error(recordWriteMessage(error,'cập nhật khu vực'));
      console.error("Error updating area:", error);
    },
  });
};

// Assign/unassign buildings to an area — N-N qua area_buildings:
// 1 toà có thể thuộc nhiều khu, gán/gỡ chỉ chạm join rows của khu đang sửa.
export const useAssignBuildingsToArea = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      areaId,
      toAddIds,
      toRemoveIds,
    }: {
      areaId: string;
      toAddIds: string[];
      toRemoveIds: string[];
    }) => {
      const guard=persistentFinancialWorkflow('area-write',{scope:'actor'});
      return guard.run(areaId,'gán tòa vào khu vực',async(progress)=>{
        const user=await getSessionUser();if(!user)throw {code:'PGRST301'};
        const {data:current,error:readError}=await supabase.from('area_buildings').select('area_id,building_id').eq('area_id',areaId);
        if(readError)throw readError;
        if(!Array.isArray(current) || current.some(row=>row.area_id!==areaId || typeof row.building_id!=='string' || !row.building_id) || new Set(current.map(row=>row.building_id)).size!==current.length)throw new Error('Chưa xác nhận được các tòa đang thuộc khu vực.');
        const confirmPairs=(rows:unknown,ids:string[],label:string)=>{
          const start=progress.completed.length;
          if(Array.isArray(rows)){
            for(const row of rows){
              if(row && typeof row==='object' && row.area_id===areaId && typeof row.building_id==='string' && row.building_id){
                progress.completed.push({id:`${areaId}:${row.building_id}`,label:'Liên kết khu và tòa đã nhận mã, cần đối chiếu'});
              }
            }
          }
          if(!Array.isArray(rows) || rows.length!==ids.length || new Set(rows.map(row=>row?.building_id)).size!==ids.length || rows.some(row=>!row || row.area_id!==areaId || !row.building_id || !ids.includes(row.building_id)))throw new FinancialWorkflowError('Chưa xác nhận đủ các tòa đã thay đổi trong khu vực. Giữ mã khu và đối chiếu trước khi tiếp tục.','unknown',[{id:areaId,label:'Khu vực cần đối chiếu'}]);
          for(let index=start;index<progress.completed.length;index++)progress.completed[index]!.label=label;
        };
        const removed=[...new Set(toRemoveIds)].filter(id=>current.some(row=>row.building_id===id));
        // Keep main's DELETE then UPSERT, including original arrays and overlap.
        if(toRemoveIds.length){
          const {data:rows,error}=await supabase.from('area_buildings').delete().eq('area_id',areaId).in('building_id',toRemoveIds).select('area_id,building_id');
          if(error)throw error;confirmPairs(rows,removed,'Đã gỡ tòa khỏi khu vực');
        }
        const missing=[...new Set(toAddIds)].filter(id=>removed.includes(id)||!current.some(row=>row.building_id===id));
        if(toAddIds.length){
          const {data:rows,error}=await supabase.from('area_buildings').upsert(toAddIds.map(building_id=>({area_id:areaId,building_id,user_id:user.id})),{onConflict:'area_id,building_id',ignoreDuplicates:true}).select('area_id,building_id');
          if(error)throw error;confirmPairs(rows,missing,'Đã gán tòa vào khu vực');
        }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      // Scope nhân viên gán theo khu là LIVE → membership đổi ảnh hưởng hiển thị phạm vi
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
    },
    onError: (error) => {
      if (error instanceof AreaMembershipPartialError || error instanceof FinancialWorkflowError) {
        queryClient.invalidateQueries({ queryKey: ["buildings"] });
        queryClient.invalidateQueries({ queryKey: ["areas"] });
        queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
        toast.error("Khu vực mới cập nhật một phần", { description: recordWriteMessage(error,'gán tòa vào khu vực') });
      } else {
        const feedback = friendlyError(error, "Chưa cập nhật được tòa trong khu vực", { operation: "gán tòa vào khu vực" });
        toast.error(feedback.title, { description: feedback.description });
      }
      console.error("Error assigning buildings to area:", error);
    },
  });
};

// Soft delete area — khu vực chỉ là NHÃN NHÓM toà: xoá khu thì gỡ nhãn khỏi
// các toà (toà vẫn giữ các khu khác). Riêng khu đang được dùng làm PHẠM VI
// phân quyền nhân viên (staff_assignments.area_id) thì DB chặn (trigger
// AREA_IN_STAFF_SCOPE) — phải gỡ phân quyền trước, tránh nâng quyền nhầm.
export const useDeleteArea = () => {
  const queryClient = useQueryClient();
  const guard=persistentFinancialWorkflow('area-write',{scope:'actor'});

  return useMutation({
    mutationFn: async (id: string) => {
      let coreConfirmed=false;
      try {return await guard.run(id,'xoá khu vực',async(progress)=>{
      const {data:before,error:readError}=await supabase.from('area_buildings').select('area_id,building_id').eq('area_id',id);
      if(readError)throw readError;
      if(!Array.isArray(before)||before.some(row=>row.area_id!==id||typeof row.building_id!=='string'||!row.building_id))throw new Error('Chưa xác nhận được liên kết khu vực cần gỡ.');

      // Soft delete trước — nếu khu đang là phạm vi phân quyền thì trigger DB
      // chặn ngay tại đây, membership chưa bị gỡ (không mất dữ liệu nhóm).
      const { data: removedArea, error } = await supabase
        .from("areas")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select('id')
        .single();

      if (error) throw error;
      confirmedRecordId(removedArea,'xoá khu vực',id);coreConfirmed=true;
      progress.completed.push({id,label:'Khu vực đã xoá mềm'});

      // Gỡ membership (join rows) — toà về "Chưa phân khu" nếu không còn khu khác
      const { data:removed, error: unassignError } = await supabase
        .from("area_buildings")
        .delete()
        .eq("area_id", id).select('area_id,building_id');

      if (unassignError) throw unassignError;
      if(!Array.isArray(removed)||removed.length!==before.length||new Set(removed.map(row=>row.building_id)).size!==before.length||removed.some(row=>row.area_id!==id||!before.some(old=>old.building_id===row.building_id)))throw new Error('Chưa xác nhận đủ liên kết khu vực đã gỡ.');
      progress.completed.push(...removed.map(row=>({id:`${id}:${row.building_id}`,label:'Liên kết khu và tòa đã gỡ'})));
      });}catch(error){if(coreConfirmed&&recordWriteBlocked(error))throw new AreaDeletePartialError(id,error);throw error;}
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Khu vực đã được xóa thành công");
    },
    onError: (error) => {
      if (error instanceof AreaDeletePartialError || error instanceof FinancialWorkflowError) {
        for (const key of ['areas', 'buildings', 'staff_assignments']) queryClient.invalidateQueries({ queryKey: [key] });
        toast.error('Khu vực mới xóa một phần', { description: recordWriteMessage(error,'xoá khu vực') });
      } else if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string' && error.message.includes('AREA_IN_STAFF_SCOPE')) {
        toast.error('Khu vực đang được dùng làm phạm vi phân quyền nhân viên — gỡ phân quyền trước khi xoá.');
      } else {
        const feedback = friendlyError(error, 'Chưa xóa được khu vực', { operation: 'xóa khu vực' });
        toast.error(feedback.title, { description: feedback.description });
      }
      console.error("Error deleting area:", error);
    },
  });
};
