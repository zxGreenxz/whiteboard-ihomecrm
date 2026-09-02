import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Meter = Database["public"]["Tables"]["meters"]["Row"];
type MeterInsert = Database["public"]["Tables"]["meters"]["Insert"];
type MeterUpdate = Database["public"]["Tables"]["meters"]["Update"];
type MeterType = Database["public"]["Enums"]["meter_type"];

// ============================================================================
// Types
// ============================================================================

export type MeterWithRoom = Meter & {
  building: { id: string; name: string } | null;
  room: { id: string; name: string } | null;
};

export type MetersGroupedByRoom = Record<
  string,
  {
    room: { id: string; name: string } | null;
    building: { id: string; name: string } | null;
    meters: MeterWithRoom[];
  }
>;

// ============================================================================
// Pure helper functions (extracted for testability)
// ============================================================================

type FeeType = Database["public"]["Enums"]["fee_type"];

/**
 * Dấu hiệu nhận diện dịch vụ theo loại công tơ, theo thứ tự ưu tiên:
 * `fee_type` (cột phân loại đúng nghĩa, bắt buộc ở dialog tạo/sửa dịch vụ) →
 * `code` → `name` (chỉ để tương thích dữ liệu cũ).
 *
 * Khớp TÊN chính xác từng là đường duy nhất và đã gãy thật: dịch vụ "Điện" bị
 * xoá mềm 10/05/2026, từ đó MỌI lần thêm công tơ điện đều throw dù org vẫn có
 * dịch vụ điện dưới tên khác (audit 02/09/2026, C-07).
 */
const METER_TYPE_TO_SERVICE_MATCH: Record<
  string,
  { label: string; feeType?: FeeType; codes: string[]; names: string[] }
> = {
  ELECTRICITY: { label: "Tiền điện", feeType: "TIEN_DIEN", codes: ["ELEC", "DIEN"], names: ["Điện", "Tiền điện"] },
  WATER: { label: "Tiền nước", feeType: "TIEN_NUOC", codes: ["WATER", "NUOC"], names: ["Nước", "Tiền nước"] },
  GAS: { label: "Gas", codes: ["GAS"], names: ["Gas"] },
};

/** Pure function to group meters by room_id */
export function groupMetersByRoom(meters: MeterWithRoom[]): MetersGroupedByRoom {
  const grouped: MetersGroupedByRoom = {};
  for (const meter of meters) {
    const key = meter.room_id || "no-room";
    if (!grouped[key]) {
      grouped[key] = {
        room: meter.room,
        building: meter.building,
        meters: [],
      };
    }
    grouped[key].meters.push(meter);
  }
  return grouped;
}

/** Pure function to filter out soft-deleted meters (deleted_at IS NULL) */
export function filterActiveMeters<T extends { deleted_at: string | null }>(
  meters: T[]
): T[] {
  return meters.filter((meter) => meter.deleted_at === null);
}

/** Pure function to filter meters by building_id and/or meter_type */
export function filterMeters(
  meters: MeterWithRoom[],
  filters: { building_id?: string | null; meter_type?: string | null }
): MeterWithRoom[] {
  return meters.filter((meter) => {
    if (filters.building_id && meter.building_id !== filters.building_id) {
      return false;
    }
    if (filters.meter_type && meter.meter_type !== filters.meter_type) {
      return false;
    }
    return true;
  });
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Resolve service_id from meter_type by querying the services table.
 * Thử lần lượt fee_type → code → name trong các dịch vụ ĐANG HOẠT ĐỘNG (ưu tiên
 * is_default). `maybeSingle()` thay `single()` vì 0 hay nhiều dòng đều không
 * phải lỗi ở bước dò. Không tìm thấy thì toast chỉ đúng chỗ phải tạo dịch vụ.
 */
async function resolveServiceId(meterType: string | null | undefined): Promise<string> {
  const match = meterType ? METER_TYPE_TO_SERVICE_MATCH[meterType] : undefined;
  if (!match) {
    toast.error("Không tìm thấy dịch vụ tương ứng với loại công tơ");
    throw new Error(`No service mapping for meter_type: ${meterType}`);
  }

  const activeServices = () =>
    supabase
      .from("services")
      .select("id")
      .is("deleted_at", null)
      .order("is_default", { ascending: false })
      .limit(1);

  const feeType = match.feeType;
  const attempts: Array<() => ReturnType<typeof activeServices>> = [];
  if (feeType) attempts.push(() => activeServices().eq("fee_type", feeType));
  attempts.push(() => activeServices().in("code", match.codes));
  attempts.push(() => activeServices().in("name", match.names));

  for (const attempt of attempts) {
    const { data, error } = await attempt().maybeSingle();
    if (error) {
      toast.error("Không kiểm tra được danh mục dịch vụ");
      throw error;
    }
    if (data?.id) return data.id;
  }

  toast.error(
    `Chưa có dịch vụ "${match.label}" đang hoạt động — vào Cài đặt ▸ Dịch vụ tạo trước khi thêm công tơ.`,
  );
  throw new Error(`Service not found for meter_type: ${meterType}`);
}

// ============================================================================
// Query hooks
// ============================================================================

/** Query danh sách công tơ, filter deleted_at IS NULL, hỗ trợ filter theo roomId và meterType */
export const useMeters = (roomId?: string, meterType?: MeterType) => {
  return useQuery({
    queryKey: ["meters", roomId, meterType],
    queryFn: async () => {
      let query = supabase
        .from("meters")
        .select("*")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (roomId) {
        query = query.eq("room_id", roomId);
      }
      if (meterType) {
        query = query.eq("meter_type", meterType);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useMeters error:", error);
        return [];
      }

      return data || [];
    },
  });
};

/** Query single meter by ID */
export const useMeter = (id: string) => {
  return useQuery({
    queryKey: ["meters", "detail", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meters")
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) {
        console.error("useMeter error:", error);
        return null;
      }

      return data;
    },
    enabled: !!id,
  });
};

/** Query từ view meters_with_latest_reading */
export const useMetersWithLatestReading = () => {
  return useQuery({
    queryKey: ["meters-with-latest-reading"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meters_with_latest_reading" as any)
        .select("*");

      if (error) {
        console.error("useMetersWithLatestReading error:", error);
        return [];
      }

      return data || [];
    },
  });
};

/** Query công tơ nhóm theo phòng */
export const useMetersGroupedByRoom = (
  buildingId?: string,
  meterType?: MeterType
) => {
  return useQuery({
    queryKey: ["meters", "grouped", buildingId, meterType],
    queryFn: async () => {
      let query = supabase
        .from("meters")
        .select("*, building:buildings(id, name), room:rooms(id, name)")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (buildingId) {
        query = query.eq("building_id", buildingId);
      }
      if (meterType) {
        query = query.eq("meter_type", meterType);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useMetersGroupedByRoom error:", error);
        return {} as MetersGroupedByRoom;
      }

      const meters = (data || []) as unknown as MeterWithRoom[];
      return groupMetersByRoom(meters);
    },
  });
};

/** Gọi RPC get_meters_without_readings, trả về UnrecordedMeter[] */
export const useUnrecordedMeters = (params: {
  buildingId?: string;
  roomId?: string;
  meterType?: MeterType;
  month: string;
}) => {
  const { buildingId, roomId, meterType, month } = params;

  return useQuery({
    queryKey: ["unrecorded-meters", buildingId, roomId, meterType, month],
    queryFn: async () => {
      // RBAC v2: bỏ p_user_id; quyền xác định qua can_access_building.
      const { data, error } = await supabase.rpc(
        "get_meters_without_readings_v2",
        {
          // 3 tham số lọc đều `DEFAULT NULL` ở server ⇒ vắng mặt = NULL. Dùng
          // `undefined` để khớp kiểu `p_x?: T` của tham số CÓ DEFAULT.
          p_building_id: buildingId ?? undefined,
          p_room_id: roomId ?? undefined,
          p_meter_type: meterType ?? undefined,
          p_month: month,
        }
      );

      if (error) {
        console.error("[useUnrecordedMeters] RPC error:", error);
        return [];
      }

      return data || [];
    },
    enabled: !!month,
  });
};

// ============================================================================
// Mutation hooks
// ============================================================================

/** Mutation INSERT vào meters với user_id = auth.uid() */
export const useCreateMeter = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (meter: Omit<MeterInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      // Auto-resolve service_id from meter_type
      const serviceId = await resolveServiceId(meter.meter_type);

      const { data, error } = await supabase
        .from("meters")
        .insert({ ...meter, user_id: user.id, service_id: serviceId })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã công tơ đã tồn tại");
        } else {
          toast.error("Không thể tạo công tơ");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meters"] });
      queryClient.invalidateQueries({ queryKey: ["meters-with-latest-reading"] });
      queryClient.invalidateQueries({ queryKey: ["unrecorded-meters"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating meter:", error);
    },
  });
};

/** Mutation UPDATE meters */
export const useUpdateMeter = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: MeterUpdate }) => {
      // Auto-resolve service_id when meter_type is being updated
      let resolvedUpdates = { ...updates };
      if (updates.meter_type) {
        const serviceId = await resolveServiceId(updates.meter_type);
        resolvedUpdates.service_id = serviceId;
      }

      const { data, error } = await supabase
        .from("meters")
        .update(resolvedUpdates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã công tơ đã tồn tại");
        } else {
          toast.error("Không thể cập nhật công tơ");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meters"] });
      queryClient.invalidateQueries({ queryKey: ["meters-with-latest-reading"] });
      queryClient.invalidateQueries({ queryKey: ["unrecorded-meters"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error updating meter:", error);
    },
  });
};

/** Mutation soft-delete (UPDATE deleted_at = NOW()) */
export const useDeleteMeter = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("meters")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        toast.error("Không thể xóa công tơ");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meters"] });
      queryClient.invalidateQueries({ queryKey: ["meters-with-latest-reading"] });
      queryClient.invalidateQueries({ queryKey: ["unrecorded-meters"] });
      toast.success("Dữ liệu đã được XOÁ thành công");
    },
    onError: (error) => {
      console.error("Error deleting meter:", error);
    },
  });
};
