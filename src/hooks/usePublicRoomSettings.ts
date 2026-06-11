import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";

/**
 * Cấu hình hiển thị trang công khai "Phòng trống" theo CHỦ tài khoản (1 dòng/owner).
 * RPC get_public_available_rooms đọc soon_days + hotline_id. Bảng RLS owner-only.
 */
export interface PublicRoomSettings {
  soon_days: number;
  show_rented: boolean;
  hotline_id: string | null;
}

export const PUBLIC_ROOM_SETTINGS_DEFAULTS: PublicRoomSettings = {
  soon_days: 30,
  show_rented: true,
  hotline_id: null,
};

const KEY = ["public-room-settings"] as const;

export function usePublicRoomSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<PublicRoomSettings> => {
      const { data, error } = await supabase
        .from("public_room_settings")
        .select("soon_days, show_rented, hotline_id")
        .maybeSingle();
      if (error) throw error;
      if (!data) return PUBLIC_ROOM_SETTINGS_DEFAULTS;
      return {
        soon_days: data.soon_days ?? 30,
        show_rented: data.show_rented ?? true,
        hotline_id: data.hotline_id ?? null,
      };
    },
  });
}

export function useUpsertPublicRoomSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: PublicRoomSettings) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Chưa đăng nhập");
      const { error } = await supabase
        .from("public_room_settings")
        .upsert(
          { owner_id: user.id, ...values, updated_at: new Date().toISOString() },
          { onConflict: "owner_id" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success("Đã lưu cài đặt hiển thị");
    },
    onError: (e) => toast.error("Không thể lưu cài đặt: " + e.message),
  });
}
