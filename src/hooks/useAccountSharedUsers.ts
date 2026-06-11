import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";

export interface AccountSharedUser {
  id: string;
  account_id: string;
  user_id: string;
  created_at: string;
  full_name?: string | null;  // JS-merged từ profiles
  email?: string | null;
}

// List user được share quyền dùng 1 sổ quỹ.
// RLS: owner thấy toàn bộ shared rows của sổ mình; shared user chỉ thấy
// hàng của chính họ; admin thấy hết.
export const useAccountSharedUsers = (accountId: string | null | undefined) => {
  return useQuery({
    queryKey: ["account_shared_users", accountId],
    enabled: !!accountId,
    queryFn: async (): Promise<AccountSharedUser[]> => {
      const { data, error } = await (supabase
        .from("account_shared_users" as any)
        .select("*") as any)
        .eq("account_id", accountId);

      if (error) {
        console.error("useAccountSharedUsers error", error);
        return [];
      }

      const rows = (data || []) as any[];
      if (rows.length === 0) return [];

      const userIds = Array.from(new Set(rows.map((r) => r.user_id))).filter(Boolean);
      const profileMap = new Map<string, any>();
      if (userIds.length > 0) {
        const { data: profiles } = await (supabase
          .from("profiles")
          .select("id, full_name, email" as any) as any)
          .in("id", userIds);
        for (const p of ((profiles as any[]) || [])) {
          profileMap.set(p.id, p);
        }
      }

      return rows.map((r) => ({
        ...r,
        full_name: profileMap.get(r.user_id)?.full_name ?? null,
        email: profileMap.get(r.user_id)?.email ?? null,
      }));
    },
  });
};

// Đồng bộ list shared users của 1 sổ quỹ với danh sách user_ids mới:
//   • Diff với DB hiện tại
//   • DELETE rows không còn trong list
//   • INSERT rows mới
// Dùng trong CashbookForm khi save.
export const useSyncAccountSharedUsers = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { accountId: string; userIds: string[] }) => {
      const authData = { user: await getSessionUser() };
      const creator = authData.user?.id ?? null;

      // 1. Lấy hiện trạng
      const { data: existing, error: selErr } = await (supabase
        .from("account_shared_users" as any)
        .select("id, user_id") as any)
        .eq("account_id", input.accountId);

      if (selErr) throw selErr;

      const haveIds = new Set<string>(((existing as any[]) || []).map((r) => r.user_id));
      const wantIds = new Set<string>(input.userIds);

      // 2. Rows cần xoá
      const toDelete = ((existing as any[]) || [])
        .filter((r) => !wantIds.has(r.user_id))
        .map((r) => r.id);
      if (toDelete.length > 0) {
        const { error } = await (supabase
          .from("account_shared_users" as any)
          .delete() as any)
          .in("id", toDelete);
        if (error) throw error;
      }

      // 3. Rows cần thêm
      const toInsert = Array.from(wantIds)
        .filter((uid) => !haveIds.has(uid))
        .map((uid) => ({
          account_id: input.accountId,
          user_id: uid,
          created_by: creator,
        }));
      if (toInsert.length > 0) {
        const { error } = await (supabase
          .from("account_shared_users" as any)
          .insert(toInsert) as any);
        if (error) throw error;
      }
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["account_shared_users", vars.accountId] });
    },
    onError: (err: any) => {
      console.error("useSyncAccountSharedUsers error", err);
      toast.error(err?.message || "Không thể cập nhật người được chia sẻ");
    },
  });
};
