import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

/**
 * Quản lý token chia sẻ trang công khai "Phòng trống" (/r/:token).
 * Bảng public_room_share_tokens RLS owner-only (owner_id = auth.uid()) nên mọi
 * truy vấn tự lọc theo chủ. Tạo token qua RPC create_public_room_token (gán owner_id).
 */
export type PublicRoomToken = Database["public"]["Tables"]["public_room_share_tokens"]["Row"];

const KEY = ["public-room-tokens"] as const;

export function usePublicRoomTokens() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<PublicRoomToken[]> => {
      const { data, error } = await supabase
        .from("public_room_share_tokens")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreatePublicRoomToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (label?: string | null) => {
      const { data, error } = await supabase.rpc("create_public_room_token", { p_label: label ?? null });
      if (error) throw error;
      return data as PublicRoomToken;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success("Đã tạo link chia sẻ");
    },
    onError: (e) => toast.error("Không thể tạo link: " + e.message),
  });
}

export function useUpdateTokenLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ token, label }: { token: string; label: string | null }) => {
      const { error } = await supabase
        .from("public_room_share_tokens")
        .update({ label: label?.trim() || null })
        .eq("token", token);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success("Đã cập nhật nhãn");
    },
    onError: (e) => toast.error("Không thể cập nhật: " + e.message),
  });
}

export function useSetTokenRevoked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ token, revoked }: { token: string; revoked: boolean }) => {
      const { error } = await supabase
        .from("public_room_share_tokens")
        .update({ revoked })
        .eq("token", token);
      if (error) throw error;
      return revoked;
    },
    onSuccess: (revoked) => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success(revoked ? "Đã thu hồi link" : "Đã khôi phục link");
    },
    onError: (e) => toast.error("Không thể đổi trạng thái: " + e.message),
  });
}

export function useDeletePublicRoomToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) => {
      const { error } = await supabase.from("public_room_share_tokens").delete().eq("token", token);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success("Đã xoá link");
    },
    onError: (e) => toast.error("Không thể xoá: " + e.message),
  });
}
