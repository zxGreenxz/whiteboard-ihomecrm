import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type MeterType = Database["public"]["Enums"]["meter_type"];

// --- Types ---

export interface MeterReadingFilters {
  building_id?: string;
  room_id?: string;
  meter_type?: MeterType;
  month?: string;
  status?: "UNAPPROVED" | "APPROVED";
}

export interface MeterReadingDetailed {
  id: string;
  user_id: string;
  reading_code: string;
  meter_id: string;
  meter_code: string;
  meter_name: string;
  contract_id: string | null;
  service_id: string | null;
  service_name: string | null;
  building_id: string;
  building_name: string;
  room_id: string;
  room_name: string;
  meter_type: MeterType;
  settlement_month: string;
  reading_date: string;
  previous_reading: number;
  current_reading: number;
  consumption: number;
  status: "UNAPPROVED" | "APPROVED";
  approved_by: string | null;
  approver_email: string | null;
  approved_at: string | null;
  recorded_by: string;
  recorder_email: string;
  notes: string | null;
  meter_image_url: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MeterReadingStats {
  total_readings: number;
  unapproved_count: number;
  approved_count: number;
  electricity_consumption: number | null;
  water_consumption: number | null;
  gas_consumption: number | null;
}

// --- Pure helpers re-exported from helpers file (avoids Supabase dependency in tests) ---
// The canonical implementations live in useMeterReadingsHelpers.ts

export {
  applyMeterReadingFilters as applyMeterReadingFiltersHelper,
  paginateList as paginateListHelper,
} from "./useMeterReadingsHelpers";

// Wrapper that uses the concrete MeterReadingDetailed type
export function applyMeterReadingFilters(
  readings: MeterReadingDetailed[],
  filters: MeterReadingFilters
): MeterReadingDetailed[] {
  return readings.filter((r) => {
    if (filters.building_id && r.building_id !== filters.building_id) return false;
    if (filters.room_id && r.room_id !== filters.room_id) return false;
    if (filters.meter_type && r.meter_type !== filters.meter_type) return false;
    if (filters.month && r.settlement_month !== filters.month) return false;
    if (filters.status && r.status !== filters.status) return false;
    return true;
  });
}

// --- Pure helper: paginate a list (extracted for testability) ---

export function paginateList<T>(
  items: T[],
  page: number,
  pageSize: number
): { data: T[]; totalCount: number } {
  const totalCount = items.length;
  const start = (page - 1) * pageSize;
  const data = items.slice(start, start + pageSize);
  return { data, totalCount };
}

// Re-export pure helpers from separate file (avoids Supabase dependency in tests)
export {
  createMeterReadingPayload,
  canEditReading,
  canDeleteReading,
  applyApproval,
  applyUnapproval,
  bulkDeleteUnapprovedOnly,
  computeStats,
  getApprovedReadingsForInvoice,
  calculateInvoiceAmount,
} from "./useMeterReadingsHelpers";
export type { MeterReadingForStats, ComputedStats, MeterReadingForInvoice } from "./useMeterReadingsHelpers";


// --- Query Hooks ---

export const useMeterReadingsList = (
  filters: MeterReadingFilters,
  pagination: { page: number; pageSize: number }
) => {
  return useQuery({
    queryKey: [
      "meter-readings",
      "list",
      filters.building_id,
      filters.room_id,
      filters.meter_type,
      filters.month,
      filters.status,
      pagination.page,
      pagination.pageSize,
    ],
    queryFn: async () => {
      // Query the meter_readings_detailed view via raw rpc/from
      // The view is not in generated types, so we cast the result
      let query = supabase
        .from("meter_readings_detailed" as any)
        .select("*", { count: "exact" });

      if (filters.building_id) {
        query = query.eq("building_id", filters.building_id);
      }
      if (filters.room_id) {
        query = query.eq("room_id", filters.room_id);
      }
      if (filters.meter_type) {
        query = query.eq("meter_type", filters.meter_type);
      }
      if (filters.month) {
        query = query.eq("settlement_month", filters.month);
      }
      if (filters.status) {
        query = query.eq("status", filters.status);
      }

      // Pagination
      const from = (pagination.page - 1) * pagination.pageSize;
      const to = from + pagination.pageSize - 1;
      query = query.range(from, to);

      // Order by reading_date desc (view already orders, but explicit for pagination)
      query = query.order("reading_date", { ascending: false });

      const { data, error, count } = await query;

      if (error) {
        console.error("useMeterReadingsList error:", error);
        return { data: [] as MeterReadingDetailed[], totalCount: 0 };
      }

      return {
        data: (data || []) as unknown as MeterReadingDetailed[],
        totalCount: count || 0,
      };
    },
  });
};

export const useMeterReadingStats = (
  buildingId?: string,
  month?: string
) => {
  return useQuery({
    queryKey: ["meter-readings", "stats", buildingId, month],
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "get_meter_reading_stats" as any,
        {
          p_building_id: buildingId ?? null,
          p_month: month ?? new Date().toISOString().slice(0, 7),
        }
      );

      if (error) {
        console.error("useMeterReadingStats error:", error);
        return {
          total_readings: 0,
          unapproved_count: 0,
          approved_count: 0,
          electricity_consumption: null,
          water_consumption: null,
          gas_consumption: null,
        } as MeterReadingStats;
      }

      // RPC returns a single-row table result
      const row = Array.isArray(data) ? data[0] : data;
      return (row || {
        total_readings: 0,
        unapproved_count: 0,
        approved_count: 0,
        electricity_consumption: null,
        water_consumption: null,
        gas_consumption: null,
      }) as MeterReadingStats;
    },
  });
};


// --- Mutation input types ---

export interface CreateMeterReadingInput {
  meter_id: string;
  reading_date: string;
  current_reading: number;
  notes?: string;
  meter_image_url?: string;
}

export interface BulkCreateMeterReadingInput {
  meter_id: string;
  reading_date: string;
  current_reading: number;
  notes?: string;
  meter_image_url?: string;
}

export interface ImportMeterReadingsInput {
  readings: {
    meter_code: string;
    reading_date: string;
    current_reading: number;
    notes?: string;
  }[];
}

export interface UpdateMeterReadingInput {
  id: string;
  current_reading?: number;
  reading_date?: string;
  notes?: string;
  meter_image_url?: string;
}

// --- Mutation Hooks ---

// Tạo chỉ số mới (đơn lẻ) - status mặc định UNAPPROVED
export const useCreateMeterReading = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateMeterReadingInput) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("meter_readings")
        .insert({
          user_id: user.id,
          meter_id: input.meter_id,
          reading_date: input.reading_date,
          current_reading: input.current_reading,
          notes: input.notes ?? null,
          meter_image_url: input.meter_image_url ?? null,
          status: "UNAPPROVED",
        } as any)
        .select()
        .single();

      if (error) {
        toast.error("Không thể tạo chỉ số");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating meter reading:", error);
    },
  });
};

// Tạo chỉ số hàng loạt (từ form ghi chỉ số nhiều công tơ cùng lúc)
export const useBulkCreateMeterReadings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (inputs: BulkCreateMeterReadingInput[]) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const readingsToInsert = inputs.map((input) => ({
        user_id: user.id,
        meter_id: input.meter_id,
        reading_date: input.reading_date,
        current_reading: input.current_reading,
        notes: input.notes ?? null,
        meter_image_url: input.meter_image_url ?? null,
        status: "UNAPPROVED",
      }));

      const { data, error } = await supabase
        .from("meter_readings")
        .insert(readingsToInsert as any)
        .select();

      if (error) {
        toast.error("Không thể tạo chỉ số hàng loạt");
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      toast.success(`Đã tạo ${data?.length ?? 0} chỉ số thành công`);
    },
    onError: (error) => {
      console.error("Error bulk creating meter readings:", error);
    },
  });
};

// Import chỉ số từ Excel (gọi RPC bulk_create_meter_readings)
export const useImportMeterReadings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ImportMeterReadingsInput) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase.rpc(
        "bulk_create_meter_readings" as any,
        {
          p_readings: JSON.stringify(input.readings),
          p_user_id: user.id,
        }
      );

      if (error) {
        toast.error("Không thể nhập dữ liệu từ Excel");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error importing meter readings:", error);
    },
  });
};

// Cập nhật chỉ số (chỉ khi UNAPPROVED)
export const useUpdateMeterReading = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateMeterReadingInput) => {
      const { id, ...updates } = input;

      const query = supabase
        .from("meter_readings")
        .update(updates as any)
        .eq("id", id) as any;

      const { data, error } = await query
        .eq("status", "UNAPPROVED")
        .select()
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          toast.error("Không thể cập nhật: chỉ số đã được duyệt hoặc không tồn tại");
        } else {
          toast.error("Không thể cập nhật chỉ số");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      toast.success("Chỉ số đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating meter reading:", error);
    },
  });
};

// Xoá chỉ số (soft delete, chỉ khi UNAPPROVED)
export const useDeleteMeterReading = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("meter_readings")
        .update({ deleted_at: new Date().toISOString() } as any)
        .eq("id", id)
        .eq("status" as any, "UNAPPROVED");

      if (error) {
        toast.error("Không thể xoá chỉ số");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      toast.success("Dữ liệu đã được XOÁ thành công");
    },
    onError: (error) => {
      console.error("Error deleting meter reading:", error);
    },
  });
};

// Xoá hàng loạt chỉ số chưa duyệt
export const useBulkDeleteMeterReadings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase
        .from("meter_readings")
        .update({ deleted_at: new Date().toISOString() } as any)
        .in("id", ids)
        .eq("status" as any, "UNAPPROVED");

      if (error) {
        toast.error("Không thể xoá chỉ số hàng loạt");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      toast.success("Đã xoá các chỉ số chưa duyệt thành công");
    },
    onError: (error) => {
      console.error("Error bulk deleting meter readings:", error);
    },
  });
};

// Duyệt đơn lẻ (gọi RPC approve_meter_reading)
export const useApproveMeterReading = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc(
        "approve_meter_reading" as any,
        { p_reading_id: id }
      );

      if (error) {
        toast.error("Không thể duyệt chỉ số");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      toast.success("Chỉ số đã được duyệt thành công");
    },
    onError: (error) => {
      console.error("Error approving meter reading:", error);
    },
  });
};

// Duyệt hàng loạt (gọi RPC bulk_approve_meter_readings)
export const useBulkApproveMeterReadings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { data, error } = await supabase.rpc(
        "bulk_approve_meter_readings" as any,
        { p_reading_ids: ids }
      );

      if (error) {
        toast.error("Không thể duyệt hàng loạt chỉ số");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      toast.success("Đã duyệt hàng loạt chỉ số thành công");
    },
    onError: (error) => {
      console.error("Error bulk approving meter readings:", error);
    },
  });
};

// Bỏ duyệt (cập nhật status=UNAPPROVED, xoá approved_by và approved_at)
export const useUnapproveMeterReading = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("meter_readings")
        .update({
          status: "UNAPPROVED",
          approved_by: null,
          approved_at: null,
        } as any)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể bỏ duyệt chỉ số");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
      toast.success("Đã bỏ duyệt chỉ số thành công");
    },
    onError: (error) => {
      console.error("Error unapproving meter reading:", error);
    },
  });
};
