import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { rpcNullable } from "@/lib/rpcNullable";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { notifyActionError } from "@/lib/actionFeedback";
import { requireAccountWriteReceipt } from "@/lib/accountSettingsWriteReceipt";
import { requireReadRows, readString, readNullableString, readNumber } from "@/lib/accountProfitReadModels";

/**
 * Quản lý "phòng khách nhờ sale / pass" — overlay lên phòng đang có khách để hiển
 * thị trên trang công khai /r/:token với SĐT khách + chính sách sale riêng.
 * Ghi qua RPC SECURITY DEFINER (gán user_id = owner của tòa + guard quyền theo
 * scope tòa). Đọc trực tiếp bảng (RLS tự lọc owner/scope nhân viên).
 */
export type PassListing = Database["public"]["Tables"]["room_pass_listings"]["Row"];
export type PassListingFormRoom =
  Database["public"]["Functions"]["pass_listing_form_rooms"]["Returns"][number];
export type PassListingRoomCustomer =
  Database["public"]["Functions"]["pass_listing_room_customers"]["Returns"][number];

const KEY = ["pass-listings"] as const;
const FORM_ROOMS_KEY = ["pass-listing-form-rooms"] as const;

export function usePassListings() {
  return useQuery({
    queryKey: KEY,
    meta: { errorDisplay: "inline" },
    queryFn: async (): Promise<PassListing[]> => {
      const { data, error } = await supabase
        .from("room_pass_listings")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return requireReadRows<PassListing>(data, row =>
        ['id', 'room_id', 'building_id', 'user_id'].every(key => readString(row[key])) &&
        typeof row.active === 'boolean' && typeof row.contact_manager === 'boolean' &&
        ['contact_name', 'contact_phone', 'sale_policy', 'avail_date'].every(key => readNullableString(row[key])) &&
        (row.pass_price === null || readNumber(row.pass_price)));
    },
  });
}

/** Danh sách phòng trong scope (owner + nhân viên), KHÔNG lọc AVAILABLE. */
export function usePassListingFormRooms() {
  return useQuery({
    queryKey: FORM_ROOMS_KEY,
    meta: { errorDisplay: "inline" },
    queryFn: async (): Promise<PassListingFormRoom[]> => {
      const { data, error } = await supabase.rpc("pass_listing_form_rooms");
      if (error) throw error;
      return requireReadRows<PassListingFormRoom>(data, row =>
        ['room_id', 'building_id', 'owner_id', 'room_name', 'building_name'].every(key => readString(row[key])) &&
        readNullableString(row.room_code) && readNullableString(row.current_listing_id) &&
        typeof row.has_active_contract === 'boolean' && (row.rent_price === null || readNumber(row.rent_price)));
    },
  });
}

/** Khách thuê của phòng (HĐ active) — để điền sẵn SĐT/tên đại diện + cho chọn. */
export function usePassListingRoomCustomers(roomId: string | null | undefined) {
  return useQuery({
    queryKey: ["pass-listing-room-customers", roomId],
    meta: { errorDisplay: "inline" },
    enabled: !!roomId,
    queryFn: async (): Promise<PassListingRoomCustomer[]> => {
      const { data, error } = await supabase.rpc("pass_listing_room_customers", { p_room_id: roomId! });
      if (error) throw error;
      return requireReadRows<PassListingRoomCustomer>(data, row =>
        readNullableString(row.full_name) && readNullableString(row.phone) && typeof row.is_representative === 'boolean');
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
  availDate?: string | null;   // 'YYYY-MM-DD'
  active?: boolean;
  contactManager?: boolean;    // true = ẩn SĐT khách công khai, hiện "Liên hệ quản lý"
}

export function useUpsertPassListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertPassListingInput) => {
      const { data, error } = await supabase.rpc("upsert_room_pass_listing", {
        p_id: rpcNullable(input.id ?? null),
        p_room_id: input.roomId,
        p_contact_name: rpcNullable(input.contactName ?? null),
        p_contact_phone: rpcNullable(input.contactPhone ?? null),
        p_sale_policy: rpcNullable(input.salePolicy ?? null),
        p_pass_price: rpcNullable(input.passPrice ?? null),
        p_avail_date: input.availDate ?? undefined,
        p_active: input.active ?? true,
        p_contact_manager: input.contactManager ?? false,
      });
      if (error) throw error;
      return requireAccountWriteReceipt(data, {
        id: input.id ?? undefined, room_id: input.roomId,
        contact_name: input.contactName ?? null, contact_phone: input.contactPhone ?? null,
        sale_policy: input.salePolicy ?? null, pass_price: input.passPrice ?? null,
        avail_date: input.availDate ?? null, active: input.active ?? true,
        contact_manager: input.contactManager ?? false,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: FORM_ROOMS_KEY });
      qc.invalidateQueries({ queryKey: ["phong-trong"] });
      toast.success("Đã lưu phòng khách nhờ sale");
    },
    onError: (error) => notifyActionError(error, "Chưa xác nhận được kết quả lưu phòng pass"),
  });
}

export function useSetPassListingActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { data, error } = await supabase.rpc("set_room_pass_listing_active", { p_id: id, p_active: active });
      if (error) throw error;
      requireAccountWriteReceipt(data, { id, active });
      return active;
    },
    onSuccess: (active) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["phong-trong"] });
      toast.success(active ? "Đã bật hiển thị" : "Đã ẩn khỏi trang công khai");
    },
    onError: (error) => notifyActionError(error, "Chưa xác nhận được kết quả đổi hiển thị phòng pass"),
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
      toast.success("Phòng pass đã được gỡ khỏi danh sách.");
    },
    onError: (error) => notifyActionError(error, "Chưa xác nhận được kết quả gỡ phòng pass"),
  });
}
