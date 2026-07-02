import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";

// --- Types ---
export interface Shareholder {
  id: string;
  user_id: string;
  auth_user_id: string | null;
  name: string;
  note: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface BuildingShareholder {
  id: string;
  user_id: string;
  building_id: string;
  shareholder_id: string;
  percent: number;
}

export interface ShareholderFormValues {
  name: string;
  note?: string | null;
  is_active?: boolean;
  auth_user_id?: string | null;
}

// --- Queries ---

// Danh sách cổ đông (owner/admin thấy tất cả; cổ đông chỉ thấy mình qua RLS).
export const useShareholders = () => {
  return useQuery({
    queryKey: ["shareholders"],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("shareholders" as any)
        .select("*") as any)
        .is("deleted_at", null)
        .order("name", { ascending: true });
      if (error) {
        toast.error("Không thể tải danh sách cổ đông");
        throw error;
      }
      return (data || []) as Shareholder[];
    },
  });
};

// Cổ đông tương ứng tài khoản đang đăng nhập (null nếu user không phải cổ đông).
export const useMyShareholder = () => {
  return useQuery({
    queryKey: ["my-shareholder"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const auth = { user: await getSessionUser() };
      if (!auth.user) return null;
      const { data, error } = await (supabase
        .from("shareholders" as any)
        .select("*") as any)
        .eq("auth_user_id", auth.user.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) return null;
      return (data as Shareholder) ?? null;
    },
  });
};

// Tên các tòa caller có cổ phần / hưởng lương LN — qua RPC SECURITY DEFINER
// get_my_share_buildings (migration 20260701170000). Trang lợi nhuận dùng hook
// này để hiện TÊN TÒA vì cổ đông KHÔNG còn quyền đọc bảng buildings (tách quyền
// khỏi khu vận hành: can_access_building đã bỏ nhánh cổ đông).
export interface ShareBuilding {
  id: string;
  name: string | null;
}
export const useMyShareBuildings = () => {
  return useQuery({
    queryKey: ["my-share-buildings"],
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ShareBuilding[]> => {
      const { data, error } = await (supabase as any).rpc("get_my_share_buildings");
      if (error) return [];
      return (data ?? []) as ShareBuilding[];
    },
  });
};

// Toàn bộ tỷ lệ % theo tòa (cho ma trận cấu hình).
export const useBuildingShareholders = () => {
  return useQuery({
    queryKey: ["building-shareholders"],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("building_shareholders" as any)
        .select("*") as any);
      if (error) {
        toast.error("Không thể tải tỷ lệ cổ đông");
        throw error;
      }
      return ((data || []) as any[]).map((r) => ({
        ...r,
        percent: Number(r.percent) || 0,
      })) as BuildingShareholder[];
    },
  });
};

// --- Mutations ---

export const useCreateShareholder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: ShareholderFormValues) => {
      const auth = { user: await getSessionUser() };
      if (!auth.user) throw new Error("User not authenticated");
      const { data, error } = await supabase
        .from("shareholders" as any)
        .insert({
          user_id: auth.user.id,
          name: values.name,
          note: values.note ?? null,
          is_active: values.is_active ?? true,
          auth_user_id: values.auth_user_id ?? null,
        })
        .select()
        .single();
      if (error) {
        toast.error(error.message || "Không thể tạo cổ đông");
        throw error;
      }
      return data as Shareholder;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholders"] });
      toast.success("Đã tạo cổ đông");
    },
  });
};

export const useUpdateShareholder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; values: ShareholderFormValues }) => {
      const patch: any = {
        name: input.values.name,
        note: input.values.note ?? null,
        is_active: input.values.is_active ?? true,
      };
      if (input.values.auth_user_id !== undefined) {
        patch.auth_user_id = input.values.auth_user_id;
      }
      const { data, error } = await supabase
        .from("shareholders" as any)
        .update(patch)
        .eq("id", input.id)
        .select("id");
      if (error) {
        toast.error(error.message || "Không thể cập nhật cổ đông");
        throw error;
      }
      if (!data || data.length === 0) throw new Error("Không có quyền sửa cổ đông này");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholders"] });
      toast.success("Đã cập nhật cổ đông");
    },
  });
};

export const useDeleteShareholder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("shareholders" as any)
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select("id");
      if (error) {
        toast.error(error.message || "Không thể xoá cổ đông");
        throw error;
      }
      if (!data || data.length === 0) throw new Error("Không có quyền xoá cổ đông này");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholders"] });
      toast.success("Đã xoá cổ đông");
    },
  });
};

// Upsert 1 ô tỷ lệ (building × shareholder).
export const useUpsertBuildingShare = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { building_id: string; shareholder_id: string; percent: number }) => {
      const auth = { user: await getSessionUser() };
      if (!auth.user) throw new Error("User not authenticated");
      const { error } = await supabase
        .from("building_shareholders" as any)
        .upsert(
          {
            user_id: auth.user.id,
            building_id: input.building_id,
            shareholder_id: input.shareholder_id,
            percent: input.percent,
          },
          { onConflict: "building_id,shareholder_id" }
        );
      if (error) {
        toast.error(error.message || "Không thể lưu tỷ lệ");
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["building-shareholders"] });
    },
  });
};

// Đồng bộ toàn bộ tỷ lệ tòa cho 1 cổ đông = danh sách rows truyền vào
// (xoá tòa không còn, upsert tòa mới/đổi %).
export const useSyncShareholderBuildings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      shareholder_id: string;
      rows: Array<{ building_id: string; percent: number }>;
    }) => {
      const auth = { user: await getSessionUser() };
      if (!auth.user) throw new Error("User not authenticated");

      const { data: existing } = await (supabase
        .from("building_shareholders" as any)
        .select("id, building_id") as any)
        .eq("shareholder_id", input.shareholder_id);

      const keep = new Set(input.rows.map((r) => r.building_id));
      const toDelete = ((existing || []) as any[])
        .filter((e) => !keep.has(e.building_id))
        .map((e) => e.id);
      if (toDelete.length > 0) {
        const { error } = await (supabase
          .from("building_shareholders" as any)
          .delete() as any)
          .in("id", toDelete);
        if (error) throw error;
      }

      if (input.rows.length > 0) {
        const { error } = await supabase
          .from("building_shareholders" as any)
          .upsert(
            input.rows.map((r) => ({
              user_id: auth.user!.id,
              shareholder_id: input.shareholder_id,
              building_id: r.building_id,
              percent: r.percent,
            })),
            { onConflict: "building_id,shareholder_id" }
          );
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["building-shareholders"] });
    },
  });
};

export const useDeleteBuildingShare = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { building_id: string; shareholder_id: string }) => {
      const { error } = await (supabase
        .from("building_shareholders" as any)
        .delete() as any)
        .eq("building_id", input.building_id)
        .eq("shareholder_id", input.shareholder_id);
      if (error) {
        toast.error(error.message || "Không thể xoá tỷ lệ");
        throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["building-shareholders"] });
    },
  });
};

// Tạo tài khoản đăng nhập cho cổ đông (edge admin-create-user) + gán auth_user_id.
export const useCreateShareholderLogin = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      shareholder_id: string;
      email: string;
      password: string;
      full_name?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke("admin-create-user", {
        body: {
          email: input.email,
          password: input.password,
          full_name: input.full_name ?? "",
        },
      });
      if (error) throw new Error(error.message || "Tạo tài khoản thất bại");
      if ((data as any)?.error) throw new Error((data as any).error);
      const newUserId = (data as any)?.user?.id as string | undefined;
      if (!newUserId) throw new Error("Không nhận được ID tài khoản mới");

      const { error: upErr } = await supabase
        .from("shareholders" as any)
        .update({ auth_user_id: newUserId })
        .eq("id", input.shareholder_id);
      if (upErr) throw new Error(upErr.message || "Không gán được tài khoản cho cổ đông");
      return { userId: newUserId };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shareholders"] });
      toast.success("Đã tạo tài khoản đăng nhập cho cổ đông");
    },
    onError: (e: any) => {
      toast.error("Không thể tạo tài khoản", { description: e?.message ?? String(e) });
    },
  });
};
