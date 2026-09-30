import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {confirmedRecordId,recordWriteMessage} from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg, withOrgAll } from "@/lib/orgPayload";
import { MeterReadingImportUnknownError, parseMeterReadingImportResult } from '@/lib/meterReadingImportResult';
import { friendlyError } from '@/lib/friendlyError';

export class MeterReadingBatchPartialError extends FinancialWorkflowError {
  constructor(readonly confirmedIds: readonly string[], readonly requestedCount: number, action: string) {
    super(confirmedIds.length
      ? `Đã xác nhận ${action} ${confirmedIds.length}/${requestedCount} chỉ số; chưa xác nhận được các dòng còn lại. Tải lại danh sách và đối chiếu ID: ${confirmedIds.join(', ')}.`
      : `Chưa xác nhận được kết quả ${action} ${requestedCount} chỉ số. Tải lại danh sách và đối chiếu từng dòng trước khi thao tác lại.`,confirmedIds.length?'partial':'unknown',[...new Set(confirmedIds)].map(id=>({id,label:'Chỉ số đã nhận mã'})));
  }
}

function meterReadingFailure(error: unknown, action: string) {
  if (error instanceof MeterReadingBatchPartialError) {
    toast.error(`Chưa hoàn tất ${action}`, { description: error.message });
    return;
  }
  if(error instanceof FinancialWorkflowError){toast.error(`Chưa hoàn tất ${action}`,{description:recordWriteMessage(error,`${action} chỉ số`)});return;}
  const feedback = friendlyError(error, `Chưa ${action} được chỉ số`, { operation: `${action} chỉ số` });
  toast.error(feedback.title, { description: feedback.description });
}

function validateReadingWrite(value:number|undefined,date?:string){
 if(value!==undefined && (!Number.isFinite(value) || value<0))throw new FinancialWorkflowError('Nhập chỉ số hợp lệ, lớn hơn hoặc bằng 0.','failure',[]);
 if(date!==undefined){const parsed=new Date(`${date}T00:00:00Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10)!==date)throw new FinancialWorkflowError('Chọn ngày chốt hợp lệ.','failure',[]);}
}
type MeterType = Database["public"]["Enums"]["meter_type"];

// ============================================================================
// Types
// ============================================================================

/**
 * CÓ HAI interface tên `MeterReadingFilters` trong repo, và chúng đã lệch nhau.
 *
 *   src/components/meter-readings/MeterReadingFilters.tsx  ← bản UI khai, CÓ room_ids
 *   src/hooks/useMeterReadings.ts (đây)                    ← thiếu room_ids tới 11/08/2026
 *
 * Thân hàm bên dưới ĐÃ cài đặt lọc nhiều phòng (`filters.room_ids?.length` ⇒
 * `.in("room_id", …)`), nên tính năng chạy đúng ở runtime — chỉ có kiểu là không
 * mô tả nổi nó, và ts-baseline đã nuốt cả ba lỗi thành nợ đã biết.
 *
 * Không gộp một mối trong lát này: bản UI dùng `| null` bắt buộc còn bản này dùng
 * `?` tuỳ chọn, hợp nhất sẽ đụng mọi consumer. Thay vào đó
 * `__tests__/meterReadingFilters.contract.test.ts` khẳng định hai bản còn tương
 * thích, nên lần lệch sau sẽ đỏ ngay thay vì chờ ai đó đọc ra.
 */
export interface MeterReadingFilters {
  building_id?: string;
  room_id?: string;
  /** Lọc nhiều phòng cùng tên (gộp mọi toà). ƯU TIÊN hơn `room_id`. */
  room_ids?: string[] | null;
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

      // Order by reading_date desc; tiebreaker created_at giữ phân trang ổn
      // định sau khi view meter_readings_detailed bỏ ORDER BY nội tại
      // (migration 20260726130000).
      query = query
        .order("reading_date", { ascending: false })
        .order("created_at", { ascending: false });

      const { data, error, count } = await query;

      if (error) {
        console.error("useMeterReadingsList error:", error);
        throw error;
      }
      if (!Array.isArray(data) || typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new Error('Chưa xác nhận được danh sách và tổng số chỉ số. Tải lại để kiểm tra.');

      return {
        data: data as unknown as MeterReadingDetailed[],
        totalCount: count,
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
        throw error;
      }

      // RPC returns a single-row table result
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== 'object' || ['total_readings', 'unapproved_count', 'approved_count'].some(key =>
        typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0)) throw new Error('Chưa xác nhận được thống kê chỉ số. Tải lại để kiểm tra.');
      for (const key of ['electricity_consumption', 'water_consumption', 'gas_consumption']) {
        if (row[key] != null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]))) throw new Error('Chưa xác nhận được thống kê chỉ số. Tải lại để kiểm tra.');
      }
      return row as MeterReadingStats;
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
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async (input: CreateMeterReadingInput) => {
      validateReadingWrite(input.current_reading,input.reading_date);
      return persistentFinancialWorkflow('useCreateMeterReading').run('create','tạo chỉ số',async()=>{
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("meter_readings")
        .insert(withOrg({
          user_id: user.id,
          meter_id: input.meter_id,
          reading_date: input.reading_date,
          current_reading: input.current_reading,
          notes: input.notes ?? null,
          meter_image_url: input.meter_image_url ?? null,
          status: "APPROVED",
          approved_by: user.id,
          approved_at: new Date().toISOString(),
        } as any, selectedOrganizationId))
        .select()
        .single();

      if (error) throw error;
      confirmedRecordId(data,'tạo chỉ số');
      return data;
      },undefined,selectedOrganizationId);
    },
    onSuccess: () => {
      invalidateMeterReadingQueries(queryClient);
      toast.success("Đã ghi chỉ số công tơ");
    },
    onError: (error) => {
      console.error("Error creating meter reading:", error);
      invalidateMeterReadingQueries(queryClient);
      meterReadingFailure(error, 'tạo');
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
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async (inputs: BulkCreateMeterReadingInput[]) => {
      if(!inputs.length)throw new FinancialWorkflowError('Chọn ít nhất một chỉ số để ghi.','failure',[]);
      inputs.forEach(input=>validateReadingWrite(input.current_reading,input.reading_date));
      return persistentFinancialWorkflow('useBulkCreateMeterReadings').run('batch','tạo chỉ số hàng loạt',async()=>{
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const approvedAt = new Date().toISOString();
      const readingsToInsert = inputs.map((input) => ({
        user_id: user.id,
        meter_id: input.meter_id,
        reading_date: input.reading_date,
        current_reading: input.current_reading,
        notes: input.notes ?? null,
        meter_image_url: input.meter_image_url ?? null,
        status: "APPROVED",
        approved_by: user.id,
        approved_at: approvedAt,
      }));

      const { data, error } = await supabase
        .from("meter_readings")
        .insert(withOrgAll(readingsToInsert, selectedOrganizationId) as any)
        .select();

      if (error) throw error;
      if (!Array.isArray(data)) throw new MeterReadingBatchPartialError([], inputs.length, 'tạo');
      const confirmedIds = data.map(row => row?.id).filter((id): id is string => typeof id === 'string' && !!id);
      if (confirmedIds.length !== inputs.length || new Set(confirmedIds).size !== inputs.length) throw new MeterReadingBatchPartialError(confirmedIds, inputs.length, 'tạo');
      return data;
      },undefined,selectedOrganizationId);
    },
    onSuccess: (data) => {
      invalidateMeterReadingQueries(queryClient);
      toast.success(`Đã tạo ${data?.length ?? 0} chỉ số thành công`);
    },
    onError: (error) => {
      console.error("Error bulk creating meter readings:", error);
      invalidateMeterReadingQueries(queryClient);
      meterReadingFailure(error, 'tạo hàng loạt');
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
      if(!input.readings.length)throw new FinancialWorkflowError('Chọn ít nhất một dòng để nhập.','failure',[]);
      input.readings.forEach(row=>validateReadingWrite(row.current_reading,row.reading_date));
      return persistentFinancialWorkflow('useImportMeterReadings',{scope:'actor'}).run('import','nhập chỉ số',async()=>{
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      // FIX (2026-07-18): hàm prod là bulk_create_meter_readings(p_readings jsonb)
      // — tự resolve meter_code→meter_id + dùng auth.uid() nội bộ. Trước đây gọi
      // kèm p_user_id (thừa) + JSON.stringify (biến array thành jsonb-string vô
      // dụng) → PostgREST PGRST202 không resolve được → import Excel HỎNG.
      // Sửa: truyền thẳng array, bỏ p_user_id. (user vẫn dùng làm auth pre-guard.)
      void user;
      const { data, error } = await supabase.rpc(
        "bulk_create_meter_readings" as any,
        { p_readings: input.readings }
      );

      if (error) throw error;
      return parseMeterReadingImportResult(data, input.readings.length);
      });
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
      }
    },
    onError: (error) => {
      console.error("Error importing meter readings:", error);
      invalidateMeterReadingQueries(queryClient);
      if(error instanceof FinancialWorkflowError && !(error instanceof MeterReadingImportUnknownError)){toast.error('Chưa xác nhận nhập chỉ số',{description:recordWriteMessage(error,'nhập chỉ số')});return;}
      if (error instanceof MeterReadingImportUnknownError) {
        toast.error('Chưa xác nhận được kết quả nhập chỉ số', { description: `${error.message}${error.confirmedIds.length ? ` ID đã xác nhận: ${error.confirmedIds.join(', ')}.` : ''}` });
      } else {
        const feedback = friendlyError(error, 'Không thể nhập chỉ số', { operation: 'nhập chỉ số công tơ' });
        toast.error(feedback.title, { description: feedback.description });
      }
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
      const {id,...updates}=input;validateReadingWrite(input.current_reading,input.reading_date);
      return persistentFinancialWorkflow('useUpdateMeterReading',{scope:'actor'}).run(id,'cập nhật chỉ số',async()=>{


      const { data, error } = await (supabase
        .from("meter_readings")
        .update(updates as any)
        .eq("id", id)
        .select()
        .single() as any);

      if (error) throw error;
      confirmedRecordId(data,'cập nhật chỉ số',id);
      return data;
      });
    },
    onSuccess: () => {
      invalidateMeterReadingQueries(queryClient);
      toast.success("Đã cập nhật chỉ số công tơ");
    },
    onError: (error) => {
      console.error("Error updating meter reading:", error);
      invalidateMeterReadingQueries(queryClient);
      meterReadingFailure(error, 'cập nhật');
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
      return persistentFinancialWorkflow('useDeleteMeterReading',{scope:'actor'}).run(id,'xoá chỉ số',async()=>{
      const { data, error } = await supabase
        .from("meter_readings")
        .update({ deleted_at: new Date().toISOString() } as any)
        .eq("id", id)
        .select('id')
        .single();

      if (error) throw error;
      confirmedRecordId(data,'xoá chỉ số',id);return data;
      });
    },
    onSuccess: () => {
      invalidateMeterReadingQueries(queryClient);
      toast.success("Đã xóa chỉ số công tơ");
    },
    onError: (error) => {
      console.error("Error deleting meter reading:", error);
      invalidateMeterReadingQueries(queryClient);
      meterReadingFailure(error, 'xóa');
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
      if(!ids.length || new Set(ids).size!==ids.length)throw new FinancialWorkflowError('Chọn các chỉ số có mã khác nhau trước khi tiếp tục.','failure',[]);
      return persistentFinancialWorkflow('useBulkDeleteMeterReadings',{scope:'actor'}).run([...ids].sort().join(','),'xoá chỉ số hàng loạt',async()=>{
      const { data, error } = await (supabase
        .from("meter_readings")
        .update({ deleted_at: new Date().toISOString() } as any)
        .in("id", ids)
        .select("id") as any);

      if (error) throw error;
      if (!Array.isArray(data)) throw new MeterReadingBatchPartialError([], ids.length, 'xóa');
      const confirmedIds = data.map(row => row?.id).filter((id): id is string => typeof id === 'string' && !!id);
      if (confirmedIds.length !== ids.length || new Set(confirmedIds).size !== ids.length || confirmedIds.some(id => !ids.includes(id))) throw new MeterReadingBatchPartialError(confirmedIds, ids.length, 'xóa');
      return data as { id: string }[];
      });
    },
    onSuccess: (data) => {
      invalidateMeterReadingQueries(queryClient);
      const deletedCount = data?.length ?? 0;
      toast.success(`Đã xoá ${deletedCount} chỉ số thành công`);
    },
    onError: (error) => {
      console.error("Error bulk deleting meter readings:", error);
      invalidateMeterReadingQueries(queryClient);
      meterReadingFailure(error, 'xóa hàng loạt');
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
      return persistentFinancialWorkflow('useApproveMeterReading',{scope:'actor'}).run(id,'duyệt chỉ số',async()=>{
      // Canonical approve_meter_reading_v1 (permission-checked qua building).
      // KHÔNG còn fallback sang legacy approve_meter_reading: từ migration
      // 20260902082002 _v1 nằm trong migration thật (hết drift PS04) và bản
      // legacy không authz đã bị REVOKE anon — rơi về nó khi PGRST202 chính là
      // "tự bỏ authz khi thiếu writer" (PMETER-C01, re-anchor 02/09/2026).
      const res = await supabase.rpc("approve_meter_reading_v1" as any, { p_id: id });
      if (res.error) throw res.error;
      if (!res.data || typeof res.data !== 'object' || res.data.id !== id || res.data.status !== 'APPROVED') throw new FinancialWorkflowError('Chưa xác nhận được chỉ số đã duyệt. Tải lại danh sách trước khi thao tác tiếp.','unknown',[]);
      return res.data;
      });
    },
    onSuccess: () => {
      invalidateMeterReadingQueries(queryClient);
      toast.success("Chỉ số đã được duyệt thành công");
    },
    onError: (error) => {
      console.error("Error approving meter reading:", error);
      invalidateMeterReadingQueries(queryClient);
      meterReadingFailure(error, 'duyệt');
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
      if(!ids.length || new Set(ids).size!==ids.length)throw new FinancialWorkflowError('Chọn các chỉ số có mã khác nhau trước khi tiếp tục.','failure',[]);
      return persistentFinancialWorkflow('useBulkApproveMeterReadings',{scope:'actor'}).run([...ids].sort().join(','),'duyệt chỉ số hàng loạt',async()=>{
      // Canonical bulk_approve_meter_readings_v1 (per-item permission), trả
      // integer số chỉ số đã duyệt. KHÔNG còn fallback legacy — xem ghi chú ở
      // useApproveMeterReading (PMETER-C01, migration 20260902082002).
      const res = await supabase.rpc("bulk_approve_meter_readings_v1" as any, { p_ids: ids });
      if (res.error) throw res.error;
      if (typeof res.data !== 'number' || !Number.isInteger(res.data) || res.data < 0 || res.data > ids.length) throw new FinancialWorkflowError('Chưa xác nhận được số chỉ số đã duyệt. Tải lại danh sách để đối chiếu.','unknown',[]);
      return res.data;
      });
    },
    onSuccess: (data, ids) => {
      invalidateMeterReadingQueries(queryClient);
      if (data === ids.length) toast.success(`Đã duyệt ${data} chỉ số thành công`);
      else toast.warning(`Đã duyệt ${data}/${ids.length} chỉ số. Tải lại danh sách để kiểm tra các dòng chưa được duyệt.`);
    },
    onError: (error) => {
      console.error("Error bulk approving meter readings:", error);
      invalidateMeterReadingQueries(queryClient);
      meterReadingFailure(error, 'duyệt hàng loạt');
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
      return persistentFinancialWorkflow('useUnapproveMeterReading',{scope:'actor'}).run(id,'bỏ duyệt chỉ số',async()=>{
      // Canonical unapprove_meter_reading_v1 (permission-checked theo toà). KHÔNG
      // còn fallback UPDATE thẳng meter_readings: từ migration 20260902084240 _v1
      // nằm trong migration thật — thiếu writer là lỗi phải lộ ra, không phải
      // cửa hậu bỏ kiểm quyền (PMETER-C01, re-anchor 02/09/2026).
      const res = await supabase.rpc("unapprove_meter_reading_v1" as any, { p_id: id });
      if (res.error) throw res.error;
      if (!res.data || typeof res.data !== 'object' || res.data.id !== id || res.data.status !== 'UNAPPROVED') throw new FinancialWorkflowError('Chưa xác nhận được chỉ số đã bỏ duyệt. Tải lại danh sách trước khi thao tác tiếp.','unknown',[]);
      return res.data;
      });
    },
    onSuccess: () => {
      invalidateMeterReadingQueries(queryClient);
      toast.success("Đã bỏ duyệt chỉ số thành công");
    },
    onError: (error) => {
      console.error("Error unapproving meter reading:", error);
      invalidateMeterReadingQueries(queryClient);
      meterReadingFailure(error, 'bỏ duyệt');
    },
  });
};
