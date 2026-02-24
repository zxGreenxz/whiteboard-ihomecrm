import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Meter = Database["public"]["Tables"]["meters"]["Row"];
type MeterInsert = Database["public"]["Tables"]["meters"]["Insert"];
type MeterUpdate = Database["public"]["Tables"]["meters"]["Update"];

export const useMeters = (roomId?: string, meterType?: string) => {
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

/** Mapping from meter_type to service name in the services table */
const METER_TYPE_TO_SERVICE_NAME: Record<string, string> = {
  ELECTRICITY: "Điện",
  WATER: "Nước",
  GAS: "Gas",
};

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

export const useCreateMeter = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (meter: Omit<MeterInsert, "user_id">) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

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
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating meter:", error);
    },
  });
};

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
      toast.success("Công tơ đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating meter:", error);
    },
  });
};

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
      toast.success("Dữ liệu đã được XOÁ thành công");
    },
    onError: (error) => {
      console.error("Error deleting meter:", error);
    },
  });
};

// Types for grouped meters query
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


/** Pure function to group meters by room_id — extracted for testability */
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

/** Pure function to filter out soft-deleted meters (deleted_at IS NULL) — extracted for testability */
export function filterActiveMeters<T extends { deleted_at: string | null }>(
  meters: T[]
): T[] {
  return meters.filter((meter) => meter.deleted_at === null);
}
/** Pure function to filter meters by building_id and/or meter_type — extracted for testability */
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


export const useMetersGroupedByRoom = (
  buildingId?: string,
  meterType?: string
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

export const useUnrecordedMeters = (params: {
  buildingId?: string;
  roomId?: string;
  meterType?: string;
  month: string;
}) => {
  const { buildingId, roomId, meterType, month } = params;

  return useQuery({
    queryKey: ["meters", "unrecorded", buildingId, roomId, meterType, month],
    queryFn: async () => {
      const userId = (await supabase.auth.getUser()).data.user?.id ?? "";
      console.log("[useUnrecordedMeters] calling RPC with:", {
        p_user_id: userId,
        p_building_id: buildingId ?? null,
        p_room_id: roomId ?? null,
        p_meter_type: meterType ?? null,
        p_month: month,
      });

      const { data, error } = await supabase.rpc(
        "get_meters_without_readings",
        {
          p_user_id: userId,
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

      console.log("[useUnrecordedMeters] RPC returned:", data?.length, "meters", data);
      return data || [];
    },
    enabled: !!month,
  });
};
