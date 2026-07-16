import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type MeterType = Database["public"]["Enums"]["meter_type"];

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Re-exports from helpers (pure functions, testable without Supabase)
// ============================================================================

export {
  applyMeterReadingFilters,
  paginateList,
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
export type {
  MeterReadingForStats,
  ComputedStats,
  MeterReadingForInvoice,
} from "./useMeterReadingsHelpers";

// ============================================================================
// Mutation input types
// ============================================================================

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

// ============================================================================
// Internal: invalidate all meter-reading related queries
// ============================================================================

function invalidateMeterReadingQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["meter-readings"] });
  queryClient.invalidateQueries({ queryKey: ["meter-reading-stats"] });
  queryClient.invalidateQueries({ queryKey: ["unrecorded-meters"] });
}

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Query danh sách chỉ số từ view meter_readings_detailed.
 * Hỗ trợ filter building_id, room_id, meter_type, settlement_month, status.
 * Hỗ trợ phân trang via .range().
 * Trả về { data, totalCount }.
 * Requirements: 6.1, 6.2, 6.3
 */
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
      filters.room_ids,
      filters.meter_type,
      filters.month,
      filters.status,
      pagination.page,
      pagination.pageSize,
    ],
    queryFn: async () => {
      let query = supabase
        .from("meter_readings_detailed" as any)
        .select("*", { count: "exact", head: false });

      if (filters.building_id) {
        query = query.eq("building_id", filters.building_id);
      }
      if (filters.room_ids?.length) {
        query = query.in("room_id", filters.room_ids);
      } else if (filters.room_id) {
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

      // Order by reading_date desc
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

/**
 * Gọi RPC get_meter_reading_stats.
 * Trả về thống kê: total_readings, approved_count, unapproved_count,
 * electricity_consumption, water_consumption, gas_consumption.
 * Requirements: 7.1
 */
export const useMeterReadingStats = (
  buildingId?: string,
  month?: string
) => {
  return useQuery({
    queryKey: ["meter-reading-stats", buildingId, month],
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

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * Mutation INSERT vào meter_readings với user_id = auth.uid(), status='UNAPPROVED'.
 * Invalidate queries, toast thành công.
 * Requirements: 2.4
 */
export const useCreateMeterReading = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateMeterReadingInput) => {
      // Canonical writer (T5): RPC server-derive org/building + exact permission.
      const { data, error } = await supabase.rpc("create_meter_reading_v1", {
        p_meter_id: input.meter_id,
        p_reading_date: input.reading_date,
        p_current_reading: input.current_reading,
        p_notes: input.notes ?? null,
        p_meter_image_url: input.meter_image_url ?? null,
      });

      if (error) {
        toast.error(error.message ?? "Không thể tạo chỉ số");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      invalidateMeterReadingQueries(queryClient);
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error) => {
      console.error("Error creating meter reading:", error);
    },
  });
};

/**
 * Mutation INSERT nhiều rows vào meter_readings.
 * Invalidate queries, toast thành công.
 * Requirements: 3.4
 */
export const useBulkCreateMeterReadings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (inputs: BulkCreateMeterReadingInput[]) => {
      // Canonical writer (T5): RPC server-derive org/building + exact permission,
      // per-item atomic. Thay đường insert-thẳng-bảng cũ (client tự set status/approved_by).
      const { data, error } = await supabase.rpc("bulk_create_meter_readings_v1", {
        p_readings: inputs.map((i) => ({
          meter_id: i.meter_id,
          reading_date: i.reading_date,
          current_reading: i.current_reading,
          notes: i.notes ?? null,
          meter_image_url: i.meter_image_url ?? null,
        })) as unknown as Database["public"]["Functions"]["bulk_create_meter_readings_v1"]["Args"]["p_readings"],
      });

      if (error) {
        toast.error("Không thể tạo chỉ số hàng loạt");
        throw error;
      }

      const results = (data ?? []) as Array<{ success: boolean; error_message: string | null }>;
      const failed = results.filter((r) => !r.success);
      if (failed.length > 0 && failed.length === results.length) {
        toast.error(failed[0]?.error_message ?? "Không thể tạo chỉ số hàng loạt");
        throw new Error(failed[0]?.error_message ?? "bulk create failed");
      }
      return results;
    },
    onSuccess: (data) => {
      invalidateMeterReadingQueries(queryClient);
      const successCount = Array.isArray(data) ? data.filter((r) => r.success).length : 0;
      const failCount = Array.isArray(data) ? data.filter((r) => !r.success).length : 0;
      if (failCount === 0) {
        toast.success(`Đã tạo ${successCount} chỉ số thành công`);
      } else {
        toast.warning(`Tạo xong: ${successCount} thành công, ${failCount} lỗi`);
      }
    },
    onError: (error) => {
      console.error("Error bulk creating meter readings:", error);
    },
  });
};

/**
 * Mutation gọi RPC bulk_create_meter_readings với JSONB payload.
 * Invalidate queries, toast kết quả (số thành công/lỗi).
 * Requirements: 8.9
 */
export const useImportMeterReadings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ImportMeterReadingsInput) => {
      const user = await getSessionUser();

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

      return data as unknown as Array<{
        reading_id: string | null;
        reading_code: string | null;
        success: boolean;
        error_message: string | null;
      }>;
    },
    onSuccess: (data) => {
      invalidateMeterReadingQueries(queryClient);

      if (Array.isArray(data)) {
        const successCount = data.filter((r) => r.success).length;
        const errorCount = data.filter((r) => !r.success).length;

        if (errorCount === 0) {
          toast.success(`Đã nhập ${successCount} chỉ số thành công`);
        } else {
          toast.warning(
            `Nhập xong: ${successCount} thành công, ${errorCount} lỗi`
          );
        }
      } else {
        toast.success("Dữ liệu đã được TẠO thành công");
      }
    },
    onError: (error) => {
      console.error("Error importing meter readings:", error);
    },
  });
};

/**
 * Mutation UPDATE meter_readings (chỉ UNAPPROVED).
 * Invalidate queries, toast thành công.
 * Requirements: 5.1, 5.2
 */
export const useUpdateMeterReading = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateMeterReadingInput) => {
      // Canonical writer (T5): RPC exact permission + org check + CAS.
      const { data, error } = await supabase.rpc("update_meter_reading_v1", {
        p_id: input.id,
        p_current_reading: input.current_reading ?? null,
        p_reading_date: input.reading_date ?? null,
        p_notes: input.notes ?? null,
        p_meter_image_url: input.meter_image_url ?? null,
        p_expected_updated_at: null,
      });

      if (error) {
        toast.error(error.message ?? "Không thể cập nhật chỉ số");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      invalidateMeterReadingQueries(queryClient);
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error) => {
      console.error("Error updating meter reading:", error);
    },
  });
};

/**
 * Mutation soft-delete (UPDATE deleted_at).
 * Invalidate queries, toast thành công.
 * Requirements: 4.2
 */
export const useDeleteMeterReading = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // Canonical writer (T5): RPC exact permission + org check, idempotent.
      const { error } = await supabase.rpc("delete_meter_reading_v1", { p_id: id });

      if (error) {
        toast.error(error.message ?? "Không thể xoá chỉ số");
        throw error;
      }
    },
    onSuccess: () => {
      invalidateMeterReadingQueries(queryClient);
      toast.success("Dữ liệu đã được XOÁ thành công");
    },
    onError: (error) => {
      console.error("Error deleting meter reading:", error);
    },
  });
};

/**
 * Mutation soft-delete nhiều rows (chỉ UNAPPROVED).
 * Invalidate queries, toast kết quả.
 * Requirements: 5.5
 */
export const useBulkDeleteMeterReadings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (ids: string[]) => {
      // Canonical writer (T5): RPC per-item exact permission + org check.
      const { data, error } = await supabase.rpc("bulk_delete_meter_readings_v1", {
        p_ids: ids,
      });

      if (error) {
        toast.error("Không thể xoá chỉ số hàng loạt");
        throw error;
      }

      return (data ?? []) as Array<{ id: string; success: boolean; error_message?: string }>;
    },
    onSuccess: (data) => {
      invalidateMeterReadingQueries(queryClient);
      const deletedCount = Array.isArray(data) ? data.filter((r) => r.success).length : 0;
      const failCount = Array.isArray(data) ? data.filter((r) => !r.success).length : 0;
      if (failCount === 0) {
        toast.success(`Đã xoá ${deletedCount} chỉ số thành công`);
      } else {
        toast.warning(`Xoá xong: ${deletedCount} thành công, ${failCount} lỗi`);
      }
    },
    onError: (error) => {
      console.error("Error bulk deleting meter readings:", error);
    },
  });
};

/**
 * Mutation gọi RPC approve_meter_reading.
 * Invalidate queries, toast thành công.
 * Requirements: 4.2, 8.5
 */
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
      invalidateMeterReadingQueries(queryClient);
      toast.success("Chỉ số đã được duyệt thành công");
    },
    onError: (error) => {
      console.error("Error approving meter reading:", error);
    },
  });
};

/**
 * Mutation gọi RPC bulk_approve_meter_readings.
 * Invalidate queries, toast kết quả.
 * Requirements: 4.3, 8.6
 */
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
    onSuccess: (data) => {
      invalidateMeterReadingQueries(queryClient);
      const approvedCount = typeof data === "number" ? data : 0;
      toast.success(`Đã duyệt ${approvedCount} chỉ số thành công`);
    },
    onError: (error) => {
      console.error("Error bulk approving meter readings:", error);
    },
  });
};

/**
 * Mutation UPDATE status→UNAPPROVED, xoá approved_by/approved_at.
 * Invalidate queries, toast thành công.
 * Requirements: 4.4
 */
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
      invalidateMeterReadingQueries(queryClient);
      toast.success("Đã bỏ duyệt chỉ số thành công");
    },
    onError: (error) => {
      console.error("Error unapproving meter reading:", error);
    },
  });
};
