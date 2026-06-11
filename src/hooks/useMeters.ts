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

/** Mapping from meter_type to service name in the services table */
const METER_TYPE_TO_SERVICE_NAME: Record<string, string> = {
  ELECTRICITY: "Điện",
  WATER: "Nước",
  GAS: "Gas",
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
 * Throws and shows toast error if no matching service is found.
 */
async function resolveServiceId(meterType: string | null | undefined): Promise<string> {
  const serviceName = meterType ? METER_TYPE_TO_SERVICE_NAME[meterType] : undefined;
  if (!serviceName) {
    toast.error("Không tìm thấy dịch vụ tương ứng với loại công tơ");
    throw new Error(`No service mapping for meter_type: ${meterType}`);
  }

  const { data, error } = await supabase
    .from("services")
    .select("id")
    .eq("name", serviceName)
    .is("deleted_at", null)
    .limit(1)
    .single();

  if (error || !data) {
    toast.error("Không tìm thấy dịch vụ tương ứng với loại công tơ");
    throw new Error(`Service not found for meter_type: ${meterType} (name: ${serviceName})`);
  }

  return data.id;
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
      const { data, error } = await (supabase.rpc as any)(
        "get_meters_without_readings_v2",
        {
          p_building_id: buildingId ?? null,
          p_room_id: roomId ?? null,
          p_meter_type: meterType ?? null,
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
