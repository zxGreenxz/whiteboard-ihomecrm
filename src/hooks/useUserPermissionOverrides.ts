import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

// Row trong user_permission_overrides.
export interface UserPermissionOverride {
  id: string;
  user_id: string;
  resource: string;
  action: string;
  effect: "grant" | "revoke";
  reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Helper: key chuẩn cho mỗi cặp (resource, action).
export const overrideKey = (resource: string, action: string) => `${resource}.${action}`;

// Lấy danh sách override hiện tại cho 1 user. Chỉ super admin được phép
// (RLS sẽ trả mảng rỗng nếu không phải super admin).
export const useUserPermissionOverrides = (userId: string | null | undefined) => {
  return useQuery({
    queryKey: ["user_permission_overrides", userId],
    enabled: !!userId,
    queryFn: async (): Promise<UserPermissionOverride[]> => {
      if (!userId) return [];
      const { data, error } = await (supabase as any)
        .from("user_permission_overrides")
        .select("*")
        .eq("user_id", userId);
      if (error) {
        console.error("useUserPermissionOverrides error:", error);
        return [];
      }
      return (data as UserPermissionOverride[]) ?? [];
    },
    staleTime: 30 * 1000,
  });
};

export interface SaveOverridesInput {
  userId: string;
  reason?: string | null;
  // State mong muốn: mỗi (resource, action) có 1 effect, hoặc bỏ qua = inherit.
  desired: Array<{ resource: string; action: string; effect: "grant" | "revoke" }>;
}

// Replace toàn bộ override của 1 user bằng `desired`. Logic: load current,
// diff, delete những row không còn cần, upsert những row mới/đổi.
export const useSaveUserPermissionOverrides = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, desired, reason }: SaveOverridesInput) => {
      const { data: currentRows, error: loadErr } = await (supabase as any)
        .from("user_permission_overrides")
        .select("id, resource, action, effect")
        .eq("user_id", userId);
      if (loadErr) throw loadErr;

      const currentMap = new Map<string, { id: string; effect: "grant" | "revoke" }>();
      for (const row of (currentRows as Array<{ id: string; resource: string; action: string; effect: "grant" | "revoke" }>) ?? []) {
        currentMap.set(overrideKey(row.resource, row.action), { id: row.id, effect: row.effect });
      }

      const desiredMap = new Map<string, "grant" | "revoke">();
      for (const d of desired) desiredMap.set(overrideKey(d.resource, d.action), d.effect);

      // Rows to delete: in current but not in desired
      const idsToDelete: string[] = [];
      for (const [key, row] of currentMap) {
        if (!desiredMap.has(key)) idsToDelete.push(row.id);
      }
      if (idsToDelete.length > 0) {
        const { error: delErr } = await (supabase as any)
          .from("user_permission_overrides")
          .delete()
          .in("id", idsToDelete);
        if (delErr) throw delErr;
      }

      // Rows to upsert: new or effect changed
      const rowsToUpsert: Array<{
        user_id: string;
        resource: string;
        action: string;
        effect: "grant" | "revoke";
        reason: string | null;
        created_by: string | null;
      }> = [];
      const actorId = (await supabase.auth.getUser()).data.user?.id ?? null;
      for (const d of desired) {
        const existing = currentMap.get(overrideKey(d.resource, d.action));
        if (!existing || existing.effect !== d.effect) {
          rowsToUpsert.push({
            user_id: userId,
            resource: d.resource,
            action: d.action,
            effect: d.effect,
            reason: reason ?? null,
            created_by: actorId,
          });
        }
      }
      if (rowsToUpsert.length > 0) {
        const { error: upErr } = await (supabase as any)
          .from("user_permission_overrides")
          .upsert(rowsToUpsert, { onConflict: "user_id,resource,action" });
        if (upErr) throw upErr;
      }

      return { deleted: idsToDelete.length, upserted: rowsToUpsert.length };
    },
    onSuccess: (_res, vars) => {
      queryClient.invalidateQueries({ queryKey: ["user_permission_overrides", vars.userId] });
      queryClient.invalidateQueries({ queryKey: ["auth", "effective_permissions"] });
      toast.success("Đã lưu phân quyền chi tiết");
    },
    onError: (error: Error) => {
      toast.error(`Lưu thất bại: ${error.message}`);
    },
  });
};

// Xoá tất cả override → user inherit hoàn toàn từ role baseline.
export const useResetUserPermissionOverrides = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await (supabase as any)
        .from("user_permission_overrides")
        .delete()
        .eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: (_res, userId) => {
      queryClient.invalidateQueries({ queryKey: ["user_permission_overrides", userId] });
      queryClient.invalidateQueries({ queryKey: ["auth", "effective_permissions"] });
      toast.success("Đã khôi phục về quyền của vai trò");
    },
    onError: (error: Error) => {
      toast.error(`Khôi phục thất bại: ${error.message}`);
    },
  });
};
