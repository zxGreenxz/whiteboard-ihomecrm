import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

/**
 * Quản lý "phòng khách nhờ sale / pass" — overlay lên phòng đang có khách để hiển
 * thị trên trang công khai /r/:token với SĐT khách + chính sách sale riêng.
 * Ghi qua RPC SECURITY DEFINER (gán user_id = owner của tòa + guard quyền theo
 * scope tòa). Đọc trực tiếp bảng (RLS tự lọc owner/scope nhân viên).
 */
export type PassListing = Database["public"]["Tables"]["room_pass_listings"]["Row"];
export type PassListingFormRoom =
  Database["public"]["Functions"]["pass_listing_form_rooms"]["Returns"][number];

const KEY = ["pass-listings"] as const;
const FORM_ROOMS_KEY = ["pass-listing-form-rooms"] as const;

export function usePassListings() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<PassListing[]> => {
      const { data, error } = await supabase
        .from("room_pass_listings")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Danh sách phòng trong scope (owner + nhân viên), KHÔNG lọc AVAILABLE. */
export function usePassListingFormRooms() {
  return useQuery({
    queryKey: FORM_ROOMS_KEY,
    queryFn: async (): Promise<PassListingFormRoom[]> => {
      const { data, error } = await supabase.rpc("pass_listing_form_rooms");
      if (error) throw error;
      return (data ?? []) as PassListingFormRoom[];
    },
  });
}

export interface UpsertPassListingInput {
  id?: string | null;
  roomId: string;
  contactName?: string | null;
  contactPhone?: string | null;
  salePolicy?: string | null;
  passPrice?: number | null;
  active?: boolean;
}

export function useUpsertPassListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertPassListingInput) => {
      const { data, error } = await supabase.rpc("upsert_room_pass_listing", {
        p_id: input.id ?? null,
        p_room_id: input.roomId,
        p_contact_name: input.contactName ?? null,
        p_contact_phone: input.contactPhone ?? null,
        p_sale_policy: input.salePolicy ?? null,
        p_pass_price: input.passPrice ?? null,
        p_active: input.active ?? true,
      });
      if (error) throw error;
      return data as PassListing;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: FORM_ROOMS_KEY });
      qc.invalidateQueries({ queryKey: ["phong-trong"] });
      toast.success("Đã lưu phòng khách nhờ sale");
    },
    onError: (e) => toast.error("Không thể lưu: " + (e as Error).message),
  });
}

export function useSetPassListingActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase.rpc("set_room_pass_listing_active", { p_id: id, p_active: active });
      if (error) throw error;
      return active;
    },
    onSuccess: (active) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["phong-trong"] });
      toast.success(active ? "Đã bật hiển thị" : "Đã ẩn khỏi trang công khai");
    },
    onError: (e) => toast.error("Không thể đổi trạng thái: " + (e as Error).message),
  });
}

export function useDeletePassListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("delete_room_pass_listing", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: FORM_ROOMS_KEY });
      qc.invalidateQueries({ queryKey: ["phong-trong"] });
      toast.success("Đã xoá");
    },
    onError: (e) => toast.error("Không thể xoá: " + (e as Error).message),
  });
}
