import { FinancialWorkflowError, RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import { confirmedRecordId, recordWriteBlocked, recordWriteMessage, repeatableWrite, settleZeroRowDelete } from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { nullIfNotFound } from "@/hooks/readErrors";
import { friendlyError } from "@/lib/friendlyError";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg, withOrgAll } from "@/lib/orgPayload";

/**
 * Đã gỡ tòa khỏi khu vực nhưng máy chủ từ chối gán tòa mới (lời từ chối rõ). Không còn gì chờ đối chiếu nên không khoá
 * (đợt 8): danh sách tải lại theo máy chủ, chọn lại tòa cần gán để thử lần nữa. Mã các liên kết đã gỡ nằm trong `completed`.
 */
export class AreaMembershipPartialError extends FinancialWorkflowError {
  constructor(public readonly areaId: string, public readonly removedBuildingIds: readonly string[], cause: unknown) {
    super(`Đã gỡ ${removedBuildingIds.length} tòa khỏi khu vực nhưng máy chủ chưa cho gán tòa mới. Danh sách đã tải lại theo máy chủ; chọn lại tòa cần gán để thử lần nữa.`, 'failure', removedBuildingIds.map(buildingId => ({ id: `${areaId}:${buildingId}`, label: 'Đã gỡ tòa khỏi khu vực' })), cause);
  }
}

/**
 * Đợt 8: lần xoá khu vực đã gửi lệnh xoá mềm nhưng chưa xong — chưa rõ khu đã xoá chưa (`softDeleted` false), hoặc đã xoá
 * mềm mà chưa gỡ hết khỏi các tòa. Xoá lặp lại được (xoá mềm chỉ khớp khu còn sống, gỡ liên kết theo mã khu) nên không
 * khoá; hộp quản lý giữ nút «Xoá lại» vì khu đã xoá mềm không còn trong danh sách để bấm xoá lần nữa.
 */
export class AreaDeletePartialError extends RepeatableWriteUnknownError {
  constructor(public readonly areaId: string, cause: unknown, readonly softDeleted = true) {
    super('xoá khu vực', cause, [{ id: areaId, label: softDeleted ? 'Khu vực đã xoá mềm' : 'Khu vực cần đối chiếu' }]);
    this.message = softDeleted
      ? 'Khu vực đã xoá nhưng chưa gỡ xong khỏi các tòa. Bấm «Xoá lại» để gỡ tiếp; thao tác này không xoá thêm gì khác.'
      : 'Chưa xác nhận được khu vực đã xoá hay chưa. Bấm «Xoá lại» để thử lần nữa: khu đã xoá thì lần này chỉ gỡ nốt khỏi các tòa.';
  }
}

type AreaMember = { area_id: string; building_id: string };

/**
 * Bước chuẩn bị không ghi gì: đọc các tòa đang thuộc khu, đứng TRƯỚC mọi lệnh ghi. Đọc hỏng hay dữ liệu lạ dạng nghĩa là
 * chưa đổi gì ⇒ từ chối rõ (không phải «chưa rõ kết quả»), bấm lại được.
 */
async function readAreaMembers(areaId: string, operation: string): Promise<AreaMember[]> {
  let reply: { data: unknown; error: unknown };
  try { reply = await supabase.from('area_buildings').select('area_id,building_id').eq('area_id', areaId); }
  catch (error) { reply = { data: null, error }; }
  const rows = reply.data;
  if (reply.error || !Array.isArray(rows) || rows.some(row => !row || row.area_id !== areaId || typeof row.building_id !== 'string' || !row.building_id) || new Set(rows.map(row => row.building_id)).size !== rows.length) {
    throw new FinancialWorkflowError(`Chưa đọc được các tòa đang thuộc khu vực nên chưa ${operation}. Bấm lại để thử lần nữa.`, 'failure', [], reply.error ?? undefined);
  }
  return rows as AreaMember[];
}

/** Biên nhận lệnh gỡ / gán phải khớp đúng các cặp khu–tòa mong đợi; lệch là chưa rõ, kèm mã các cặp đã nhận để đối chiếu. */
function confirmPairs(rows: unknown, areaId: string, ids: readonly string[]): void {
  const received = Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object' && row.area_id === areaId && typeof row.building_id === 'string' && row.building_id) : [];
  if (!Array.isArray(rows) || rows.length !== ids.length || new Set(rows.map(row => row?.building_id)).size !== ids.length || rows.some(row => !row || row.area_id !== areaId || !row.building_id || !ids.includes(row.building_id))) {
    throw new FinancialWorkflowError('Chưa xác nhận đủ các tòa đã thay đổi trong khu vực.', 'unknown', received.map(row => ({ id: `${areaId}:${row.building_id}`, label: 'Liên kết khu và tòa đã nhận mã, cần đối chiếu' })));
  }
}

/**
 * Biên nhận lệnh gỡ liên kết theo mã khu. Gỡ khớp THIẾU cặp (RLS không cho gỡ, hoặc cặp đã gỡ trước đó) thì đọc lại đúng
 * các cặp chưa nhận: không còn ⇒ đã gỡ; còn nguyên ⇒ từ chối rõ «chưa có quyền» (không phải chưa rõ, bấm lại vô ích).
 * Biên nhận lạ dạng hoặc có cặp ngoài danh sách vẫn là chưa rõ (`confirmPairs`).
 */
async function confirmRemovedPairs(rows: unknown, areaId: string, expected: readonly string[], operation: string): Promise<void> {
  const got = Array.isArray(rows) && rows.every(row => row && typeof row === 'object' && row.area_id === areaId && typeof row.building_id === 'string' && expected.includes(row.building_id))
    ? rows.map(row => row.building_id as string) : null;
  if (got && new Set(got).size === got.length && got.length < expected.length) {
    const left = expected.filter(id => !got.includes(id));
    await settleZeroRowDelete(operation, () => supabase.from('area_buildings').select('area_id,building_id').eq('area_id', areaId).in('building_id', left), () => false);
    return;
  }
  confirmPairs(rows, areaId, expected);
}

type AreaInsert = Database["public"]["Tables"]["areas"]["Insert"];
type AreaUpdate = Database["public"]["Tables"]["areas"]["Update"];

// Fetch all areas with buildings count
export const useAreas = () => {
  return useQuery({
    queryKey: ["areas"],
    queryFn: async () => {
      // hermes-parity:begin w2d-areas — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
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
      // hermes-parity:end w2d-areas
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

/** Đợt 9: so trường đã gửi với dòng đọc lại. Bỏ `user_id` (máy chủ có thể đặt). */
const canonical = (value: unknown): string => JSON.stringify(value ?? null, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sentFieldsMatch = (saved: Record<string, unknown>, sent: Record<string, unknown>) => Object.keys(sent).every(key => key === 'user_id' || canonical(saved[key]) === canonical(sent[key]));

/**
 * Đợt 9 (luật 5): tạo khu vực không giữ dấu «chờ đối chiếu» nào. Mã khu do trình duyệt sinh (`createRecordOnce`; `areas` nhận
 * `id`, không trigger nào gán `id` — production 26/11/2026): kết quả chưa rõ báo «bấm lại», lần bấm lại cùng tên gửi ĐÚNG mã
 * cũ nên khoá chính chặn khu thứ hai. Dấu bản trước (khoá `new`, phạm vi người dùng) gỡ sau lần tạo xong.
 */
export const useCreateArea = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (area: Omit<AreaInsert, "user_id" | "organization_id">) => {
      const user = await getSessionUser();

      if (!user) {
        throw new Error("User not authenticated");
      }

      const payload = withOrg({ ...area, user_id: user.id }, selectedOrganizationId);
      const created = await repeatableWrite('tạo khu vực', async () => {
        const { createRecordOnce, normalizeVietnameseName } = await import('@/lib/clientRecordCreate');
        const { row } = await createRecordOnce<Database["public"]["Tables"]["areas"]["Row"]>({
          table: 'areas', userId: user.id, organizationId: payload.organization_id,
          matchKeys: [`n:${normalizeVietnameseName(area.name)}`],
          payload, operation: 'tạo khu vực',
          sameAs: saved => sentFieldsMatch(saved, payload), describe: saved => `Khu vực ${String(saved.name)}`,
        });
        return row;
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'area-write', businessKey: 'new' }, { organizationId: 'actor-scope' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần tạo sau gỡ lại. */ }
      return created;
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

  return useMutation({
    meta:{handlesFeedback:true},
    // Đợt 8 (luật 5): đặt giá trị theo mã, chạy lại cho cùng kết quả: không giữ dấu «chờ đối chiếu»; kết quả chưa rõ báo
    // rõ và cho lưu lại. Khớp 0 dòng (RLS, khu đã mất) là PGRST116: từ chối rõ.
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: AreaUpdate;
    }) => {
      const area = await repeatableWrite('cập nhật khu vực', async () => {
        const { data, error } = await supabase
          .from("areas")
          .update(updates)
          .eq("id", id)
          .select()
          .single();

        if (error) throw error;
        confirmedRecordId(data,'cập nhật khu vực',id);
        return data;
      });
      // Khoá dấu bản trước là mã khu, chung cho sửa / gán tòa / xoá; đường tạo dùng khoá 'new' nên không bị đụng.
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'area-write', businessKey: id }, { organizationId: 'actor-scope' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần ghi sau gỡ lại. */ }
      return area;
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
  const { selectedOrganizationId } = useOrganization();

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
      // Đợt 8 (luật 5): gỡ rồi gán theo cặp khu–tòa là đặt giá trị, chạy lại cho cùng kết quả (cặp đã gỡ khớp 0 dòng, cặp đã
      // gán được ON CONFLICT DO NOTHING bỏ qua), nên không giữ dấu; kết quả chưa rõ báo rõ, danh sách tải lại, chọn lại là
      // gửi lại. Bước chuẩn bị (phiên, đọc các tòa hiện có) đứng trước mọi lệnh ghi: hỏng là từ chối rõ, chưa đổi gì.
      const user=await getSessionUser();if(!user)throw {code:'PGRST301',message:'Not authenticated'};
      const current=await readAreaMembers(areaId,'gán tòa vào khu vực');
      const removed=[...new Set(toRemoveIds)].filter(id=>current.some(row=>row.building_id===id));
      const missing=[...new Set(toAddIds)].filter(id=>removed.includes(id)||!current.some(row=>row.building_id===id));
      await repeatableWrite('gán tòa vào khu vực',async()=>{
        // Keep main's DELETE then UPSERT, including original arrays and overlap.
        if(toRemoveIds.length){
          const {data:rows,error}=await supabase.from('area_buildings').delete().eq('area_id',areaId).in('building_id',toRemoveIds).select('area_id,building_id');
          if(error)throw error;await confirmRemovedPairs(rows,areaId,removed,'gán tòa vào khu vực');
        }
        if(toAddIds.length){
          const {data:rows,error}=await supabase.from('area_buildings').upsert(withOrgAll(toAddIds.map(building_id=>({area_id:areaId,building_id,user_id:user.id})),selectedOrganizationId),{onConflict:'area_id,building_id',ignoreDuplicates:true}).select('area_id,building_id');
          // Đã gỡ xong mà máy chủ từ chối gán (lời từ chối rõ): báo phần đã gỡ, không còn gì chờ đối chiếu.
          if(error && removed.length && !recordWriteBlocked(error))throw new AreaMembershipPartialError(areaId,removed,error);
          if(error)throw error;confirmPairs(rows,areaId,missing);
        }
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'area-write', businessKey: areaId }, { organizationId: 'actor-scope' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần ghi sau gỡ lại. */ }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      // Scope nhân viên gán theo khu là LIVE → membership đổi ảnh hưởng hiển thị phạm vi
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
    },
    onError: (error) => {
      // Lệnh gỡ / gán có thể đã chạy một phần: tải lại để hộp hiện đúng trạng thái máy chủ (chọn lại tòa là gửi lại).
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      if (error instanceof FinancialWorkflowError) {
        const title = error instanceof AreaMembershipPartialError ? "Khu vực mới cập nhật một phần"
          : error instanceof RepeatableWriteUnknownError ? "Chưa xác nhận được thay đổi tòa trong khu vực" : "Chưa cập nhật được tòa trong khu vực";
        toast.error(title, { description: recordWriteMessage(error,'gán tòa vào khu vực') });
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

  return useMutation({
    // Đợt 8 (luật 5): xoá mềm chỉ khớp khu còn sống, rồi gỡ mọi liên kết theo mã khu: chạy lại cho cùng kết quả nên không
    // giữ dấu. Lần bấm lại sau một lần mất phản hồi khớp 0 dòng ⇒ đọc lại thấy đã xoá (giữ giờ xoá cũ) và gỡ tiếp các tòa
    // còn lại; khu còn nguyên ⇒ máy chủ không cho xoá (RLS) ⇒ báo không có quyền. Phép đọc liên kết đứng trước mọi lệnh ghi.
    mutationFn: async (id: string): Promise<{ alreadyDeleted: boolean }> => {
      const before=await readAreaMembers(id,'xoá khu vực');
      let softDeleted=false;
      let alreadyDeleted=false;
      try {
        await repeatableWrite('xoá khu vực',async()=>{
          // Soft delete trước — nếu khu đang là phạm vi phân quyền thì trigger DB
          // chặn ngay tại đây, membership chưa bị gỡ (không mất dữ liệu nhóm).
          const { data: removedArea, error } = await supabase
            .from("areas")
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", id)
            .is("deleted_at", null)
            .select('id');

          if (error) throw error;
          if (Array.isArray(removedArea) && removedArea.length === 0) {
            await settleZeroRowDelete('xoá khu vực', () => supabase.from('areas').select('id, deleted_at').eq('id', id).maybeSingle());
            alreadyDeleted=true;
          } else confirmedRecordId(Array.isArray(removedArea) && removedArea.length === 1 ? removedArea[0] : null,'xoá khu vực',id);
          softDeleted=true;

          // Gỡ membership (join rows) — toà về "Chưa phân khu" nếu không còn khu khác
          const { data:removed, error: unassignError } = await supabase
            .from("area_buildings")
            .delete()
            .eq("area_id", id).select('area_id,building_id');

          if (unassignError) throw unassignError;
          await confirmRemovedPairs(removed, id, before.map(row => row.building_id), 'xoá khu vực');
        });
      } catch (error) {
        // Lời từ chối rõ trước khi khu được xoá mềm (khu là phạm vi phân quyền, không có quyền xoá): chưa xoá gì, đi nguyên.
        if (!softDeleted && !(error instanceof RepeatableWriteUnknownError)) throw error;
        throw new AreaDeletePartialError(id, error, softDeleted);
      }
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'area-write', businessKey: id }, { organizationId: 'actor-scope' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần xoá sau gỡ lại. */ }
      return { alreadyDeleted };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["areas"] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success(result.alreadyDeleted ? 'Khu vực đã được xoá trước đó.' : "Khu vực đã được xóa thành công");
    },
    onError: (error) => {
      for (const key of ['areas', 'buildings', 'staff_assignments']) queryClient.invalidateQueries({ queryKey: [key] });
      if (error instanceof AreaDeletePartialError) {
        toast.error(error.softDeleted ? 'Khu vực mới xóa một phần' : 'Chưa xác nhận được kết quả xoá khu vực', { description: recordWriteMessage(error,'xoá khu vực') });
      } else if (error instanceof FinancialWorkflowError) {
        toast.error('Chưa xóa được khu vực', { description: recordWriteMessage(error,'xoá khu vực') });
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
