import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialAlreadyRecordedError,FinancialWorkflowError,isConfirmedFinancialRejection} from '@/lib/financialWorkflow';
import type {FinancialPendingRecord} from '@/lib/financialPending';
import {confirmedRecordId,recordWriteMessage,repeatableWrite,settleZeroRowDelete} from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";
import type { MeterReadingImportRowResult } from '@/lib/meterReadingImportResult';
import { friendlyError } from '@/lib/friendlyError';
import { MeterReadingsRejectedError, meterRejectedRowText, recordMeterReadings, type MeterReadingInvoker, type RecordMeterReadingsResult } from '@/lib/meterReadingRpc';

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
  /** Toà của cả lô: hàm ghi nhận một toà, một ngày chốt mỗi lần. */
  building_id: string;
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

// ── Đợt 9: ghi chỉ số hàng loạt và nhập chỉ số từ Excel qua `record_meter_readings_v2` (cách B) ────────────────────────
// Thân hàm production đã đọc (26/11/2026, chỉ đọc): record_meter_readings_v2 md5 3904b0d1 — kiểm quyền, KHOÁ TOÀ bằng khoá tư
// vấn (`meter_readings.v2:<toà>`) rồi mới claim mã chống trùng ở canonical_write_operations (khoá chính: công ty, thao tác,
// toà, người, mã) cùng băm nội dung (toà, ngày, dòng, thay thế). Cùng mã cùng nội dung ⇒ trả kết quả đã chốt; cùng mã khác
// nội dung ⇒ 23505 «idempotency_key đã dùng với nội dung khác». Claim, chỉ số và ghi nhận kết quả nằm CÙNG giao dịch, nên
// 23505 chỉ có khi lần gửi trước với mã đó ĐÃ ghi. Kế hoạch meter_readings_plan_v1 (874d4d10) từ chối CẢ LÔ khi một dòng
// không ghi được (tháng đã có chỉ số…), lỗi 22023 kèm từng dòng; claim lùi theo. Vì khoá toà trước khi tra mã, gửi lại cùng
// mã ngay (kể cả khi lệnh cũ còn chạy) không ghi hai lần ⇒ khai `serverDedupesRequestKey`.
/** 23505 của record_meter_readings_v2 khi cùng mã chống trùng mà nội dung khác: lần gửi trước với mã đó ĐÃ ghi. */
function meterKeyReused(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown } | null;
  return record?.code === '23505' && /idempotency_key đã dùng với nội dung khác/.test(String(record.message ?? ''));
}
/** Lệch giờ trình duyệt ↔ máy chủ khi tìm chỉ số «ghi sau giờ kẹt» để nêu mã. */
const METER_CLOCK_SKEW_MS = 60 * 60_000;

/** Ghi hàng loạt: lần bấm trước (cùng mã) đã ghi toà này với số liệu khác. Mã chỉ số chỉ để nêu trong câu báo. */
async function bulkAlreadyRecorded(buildingId: string, prior: FinancialPendingRecord | undefined): Promise<FinancialAlreadyRecordedError> {
  let codes: string[] = [];
  if (prior) {
    try {
      const since = new Date(Date.parse(prior.startedAt) - METER_CLOCK_SKEW_MS).toISOString();
      const { data, error } = await supabase.from('meter_readings').select('id, reading_code').eq('building_id', buildingId)
        .eq('user_id', prior.userId).gte('created_at', since).is('deleted_at', null).order('created_at', { ascending: false }).limit(50);
      if (!error && Array.isArray(data)) codes = (data as { id: string; reading_code: string | null }[]).map(row => row.reading_code || row.id);
    } catch { /* 23505 đã chứng minh lần trước đã ghi; đọc hỏng chỉ làm câu báo thiếu mã chỉ số. */ }
  }
  return new FinancialAlreadyRecordedError(`Chỉ số của toà này đã được ghi ở lần bấm trước${codes.length ? ` (mã ${codes.join(', ')})` : ''}, với số liệu khác số đang nhập. Không ghi thêm; mở danh sách chỉ số để kiểm tra và sửa nếu cần.`, codes);
}

/**
 * Ghi nhiều chỉ số MỘT toà, MỘT ngày chốt qua hàm dùng chung `record_meter_readings_v2` (cùng hàm với trợ lý Hermes):
 * chống trùng (công tơ, tháng) trong database — tháng đã có chỉ số thì cả lô bị từ chối, form nêu từng dòng — thay cho
 * INSERT thẳng (trước đây ghi được dòng thứ hai cùng tháng). Khoá idempotency = requestKey của workflow: tải lại trang rồi
 * gửi lại đúng nội dung thì hàm ghi trả lại kết quả cũ, không ghi lần hai.
 * Đợt 9 (cách B): còn dấu của lần trước ⇒ gửi lại NGAY cùng khoá (không chờ 2 phút, không khoá form). Mã đã dùng với nội dung
 * khác ⇒ lần trước đã ghi: báo mã chỉ số, gỡ dấu. Lần gửi lại gặp từ chối rõ ⇒ lần trước chưa ghi gì (claim lùi theo): báo
 * từng dòng, gỡ dấu.
 * Requirements: 3.4
 */
export const useBulkCreateMeterReadings = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async (inputs: BulkCreateMeterReadingInput[]) => {
      if(!inputs.length)throw new FinancialWorkflowError('Chọn ít nhất một chỉ số để ghi.','failure',[]);
      inputs.forEach(input=>validateReadingWrite(input.current_reading,input.reading_date));
      const [{ building_id: buildingId, reading_date: readingDate }] = inputs;
      if(!buildingId || inputs.some(input=>input.building_id!==buildingId || input.reading_date!==readingDate))
        throw new FinancialWorkflowError('Mỗi lần ghi một toà và một ngày chốt.','failure',[]);
      const rows = inputs.map(input => ({ meterId: input.meter_id, value: input.current_reading, notes: input.notes ?? null, imageUrl: input.meter_image_url ?? null }));
      const invoke: MeterReadingInvoker = (_name, args) => supabase.rpc('record_meter_readings_v2' as never, args as never) as never;
      // Dấu của lần gửi trước (nếu có): giờ kẹt để tìm mã chỉ số khi máy chủ báo mã đã dùng với nội dung khác.
      let prior: FinancialPendingRecord | undefined;
      const write = async (idempotencyKey: string) => {
        let result: RecordMeterReadingsResult;
        try { result = await recordMeterReadings(invoke, { buildingId, readingDate, rows, idempotencyKey }); }
        catch (error) {
          if (meterKeyReused(error)) throw await bulkAlreadyRecorded(buildingId, prior);
          if (error instanceof FinancialWorkflowError || isConfirmedFinancialRejection(error)) throw error;
          throw new FinancialWorkflowError(`Chưa xác nhận được kết quả ghi ${inputs.length} chỉ số. Bấm Lưu lại với đúng số liệu này: hệ thống gửi lại cùng mã chống trùng nên máy chủ trả lại kết quả đã ghi, không ghi hai lần.`, 'unknown', [], error);
        }
        const confirmedIds = result.created.map(row => row.id);
        if (result.count !== inputs.length || confirmedIds.length !== inputs.length || new Set(confirmedIds).size !== inputs.length)
          throw new MeterReadingBatchPartialError(confirmedIds, inputs.length, 'tạo');
        return result.created;
      };
      return persistentFinancialWorkflow('useBulkCreateMeterReadings').run('batch','tạo chỉ số hàng loạt',
        progress => write(progress.requestKey),
        // Còn dấu của lần trước: gửi lại ĐÚNG khoá ngay. Hàm ghi khoá toà rồi mới tra khoá: lần trước đã ghi cùng nội dung ⇒
        // trả kết quả đã chốt; chưa ghi ⇒ ghi lần đầu; đã ghi nội dung khác ⇒ 23505 (task báo «đã ghi ở lần trước»).
        async pending => { prior = pending; return { outcome: 'not-written', serverDedupesRequestKey: true }; },
        selectedOrganizationId);
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

/** Dấu nhập chỉ số mang mã chống trùng của hàm ghi v2 (theo nhóm toà + ngày chốt). Dấu bản trước (hàm cũ) không mang. */
const METER_IMPORT_KEYED = 'v2-nhom';
/** Hàm ghi v2 nhận 1–500 dòng mỗi lần. */
const METER_IMPORT_MAX_ROWS = 500;

/** Nhập chỉ số: còn nhóm chưa rõ kết quả. Giữ dấu (cùng mã yêu cầu): bấm lại gửi lại đúng mã của từng nhóm. */
export class MeterReadingImportUnconfirmedError extends FinancialWorkflowError {
  constructor(readonly confirmedIds: readonly string[], unconfirmedRows: number) {
    super(`Chưa xác nhận được kết quả nhập chỉ số của ${unconfirmedRows} dòng. Bấm «Nhập dữ liệu» lại với đúng tệp này: hệ thống gửi lại cùng mã chống trùng nên máy chủ trả lại phần đã ghi, không ghi hai lần.`,
      confirmedIds.length ? 'partial' : 'unknown', [...new Set(confirmedIds)].map(id => ({ id, label: 'Chỉ số đã nhận mã' })));
  }
}

/** Mã công tơ → (mã, toà), đúng như hàm cũ bulk_create_meter_readings: công tơ của CHÍNH người nhập, chưa xoá. */
async function readImportMeters(userId: string, codes: string[]): Promise<Map<string, { id: string; buildingId: string | null }>> {
  const unique = [...new Set(codes.filter(code => typeof code === 'string' && code))];
  const meters = new Map<string, { id: string; buildingId: string | null }>();
  for (let start = 0; start < unique.length; start += 200) {
    const { data, error } = await supabase.from('meters').select('id, code, building_id').eq('user_id', userId)
      .in('code', unique.slice(start, start + 200)).is('deleted_at', null);
    if (error) throw error;
    if (!Array.isArray(data)) throw new TypeError('Chưa đọc được danh sách công tơ để nhập chỉ số.');
    for (const meter of data as { id: string; code: string | null; building_id: string | null }[]) {
      if (meter.code) meters.set(meter.code, { id: meter.id, buildingId: meter.building_id });
    }
  }
  return meters;
}

const importRow = (success: boolean, error_message: string | null, reading_id: string | null = null, reading_code: string | null = null): MeterReadingImportRowResult =>
  ({ reading_id, reading_code, success, error_message });

/**
 * Nhập chỉ số từ Excel. Đợt 9: chuyển từ bulk_create_meter_readings (không mã chống trùng, chưa duyệt) sang hàm ghi dùng chung
 * `record_meter_readings_v2` (cách B, xem đầu khối). Mã công tơ đọc TRƯỚC khi ghi dấu; dòng được nhóm theo toà + ngày chốt,
 * mỗi nhóm một lần ghi với mã chống trùng `<mã yêu cầu>:<toà>:<ngày>`. Một nhóm bị từ chối thì cả nhóm chưa ghi (nêu đúng dòng
 * lỗi), nhóm khác vẫn ghi. Còn nhóm chưa rõ ⇒ giữ dấu; lần bấm sau gửi lại NGAY đúng các mã đó (không khoá hộp nhập).
 * Requirements: 8.9
 */
export const useImportMeterReadings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ImportMeterReadingsInput): Promise<MeterReadingImportRowResult[]> => {
      if(!input.readings.length)throw new FinancialWorkflowError('Chọn ít nhất một dòng để nhập.','failure',[]);
      input.readings.forEach(row=>validateReadingWrite(row.current_reading,row.reading_date));
      const user = await getSessionUser();
      if (!user) throw new Error("User not authenticated");
      const meters = await readImportMeters(user.id, input.readings.map(row => row.meter_code));
      const prepared: (MeterReadingImportRowResult | null)[] = input.readings.map(() => null);
      const groups = new Map<string, { buildingId: string; readingDate: string; indexes: number[] }>();
      input.readings.forEach((reading, index) => {
        const meter = meters.get(reading.meter_code);
        if (!meter) { prepared[index] = importRow(false, `Không tìm thấy công tơ với mã: ${reading.meter_code || '(trống)'}`); return; }
        if (!meter.buildingId) { prepared[index] = importRow(false, `Công tơ ${reading.meter_code} chưa gắn toà nên chưa nhập được chỉ số.`); return; }
        const key = `${meter.buildingId}|${reading.reading_date}`;
        const group = groups.get(key) ?? { buildingId: meter.buildingId, readingDate: reading.reading_date, indexes: [] };
        group.indexes.push(index); groups.set(key, group);
      });
      const batches = [...groups.values()].flatMap(group => Array.from({ length: Math.ceil(group.indexes.length / METER_IMPORT_MAX_ROWS) },
        (_, part) => ({ ...group, part, indexes: group.indexes.slice(part * METER_IMPORT_MAX_ROWS, (part + 1) * METER_IMPORT_MAX_ROWS) })));
      if (!batches.length) return prepared as MeterReadingImportRowResult[];
      const invoke: MeterReadingInvoker = (_name, args) => supabase.rpc('record_meter_readings_v2' as never, args as never) as never;
      return persistentFinancialWorkflow('useImportMeterReadings',{scope:'actor'}).run('import','nhập chỉ số',async progress=>{
        const results = [...prepared];
        const confirmedIds: string[] = [];
        let unconfirmed = 0;
        for (const batch of batches) {
          const idempotencyKey = `${progress.requestKey}:${batch.buildingId}:${batch.readingDate}${batch.part ? `:${batch.part}` : ''}`;
          const rows = batch.indexes.map(index => ({ meterId: meters.get(input.readings[index].meter_code)!.id,
            value: input.readings[index].current_reading, notes: input.readings[index].notes ?? null }));
          try {
            const written = await recordMeterReadings(invoke, { buildingId: batch.buildingId, readingDate: batch.readingDate, rows, idempotencyKey });
            // Biên nhận phải khớp đúng từng dòng đã gửi (số thứ tự, công tơ, mã không trùng); lệch ⇒ chưa rõ, không tin.
            const matches = written.count === rows.length && written.replaced.length === 0 && written.created.length === rows.length
              && new Set(written.created.map(row => row.id)).size === rows.length
              && written.created.every(row => row.n >= 1 && row.n <= rows.length && rows[row.n - 1].meterId === row.meterId)
              && new Set(written.created.map(row => row.n)).size === rows.length;
            if (!matches) throw new TypeError('Biên nhận ghi chỉ số không khớp các dòng đã gửi.');
            for (const row of written.created) {
              results[batch.indexes[row.n - 1]] = importRow(true, null, row.id, row.code ?? null);
              confirmedIds.push(row.id);
            }
          } catch (error) {
            if (error instanceof MeterReadingsRejectedError) {
              // Cả nhóm chưa ghi dòng nào (claim lùi theo): nêu đúng dòng lỗi, dòng còn lại của nhóm báo chưa ghi.
              const general = error.rows.find(row => !row.n);
              batch.indexes.forEach((index, position) => {
                const own = error.rows.find(row => row.n === position + 1);
                results[index] = importRow(false, own ? meterRejectedRowText(own) : general ? meterRejectedRowText(general)
                  : 'Chưa ghi: cùng toà và ngày chốt với dòng bị từ chối nên cả nhóm chưa được ghi. Sửa dòng lỗi rồi nhập lại.');
              });
            } else if (meterKeyReused(error)) {
              // Mã chống trùng gồm toà + ngày: lần gửi trước đã ghi đúng toà, ngày này với số liệu khác. Mã chỉ số để nêu.
              const codes = new Map<string, string>();
              try {
                const { data, error: readError } = await supabase.from('meter_readings').select('id, reading_code, meter_id').eq('user_id', user.id)
                  .eq('reading_date', batch.readingDate).in('meter_id', rows.map(row => row.meterId)).is('deleted_at', null);
                if (!readError && Array.isArray(data)) for (const row of data as { id: string; reading_code: string | null; meter_id: string }[]) codes.set(row.meter_id, row.reading_code || row.id);
              } catch { /* 23505 đã chứng minh lần trước đã ghi; đọc hỏng chỉ làm câu báo thiếu mã chỉ số. */ }
              batch.indexes.forEach((index, position) => {
                const code = codes.get(rows[position].meterId) ?? null;
                results[index] = importRow(false, `Đã ghi ở lần nhập trước với số liệu khác${code ? ` (mã ${code})` : ''}; không ghi thêm. Mở dòng đó để sửa nếu cần.`, null, code);
              });
            } else if (isConfirmedFinancialRejection(error)) {
              const feedback = friendlyError(error, 'Chưa ghi được chỉ số', { operation: 'nhập chỉ số công tơ' });
              batch.indexes.forEach(index => { results[index] = importRow(false, `Chưa ghi: ${feedback.description}`); });
            } else {
              unconfirmed += batch.indexes.length;
              batch.indexes.forEach(index => { results[index] = importRow(false, 'Chưa xác nhận được kết quả của dòng này. Bấm «Nhập dữ liệu» lại với đúng tệp này để đối chiếu.'); });
            }
          }
        }
        if (unconfirmed) throw new MeterReadingImportUnconfirmedError(confirmedIds, unconfirmed);
        return results as MeterReadingImportRowResult[];
      },
      // Dấu mang mã v2: gửi lại ngay đúng các mã đó. Dấu bản trước (hàm cũ không có mã): gửi khi lần trước chắc chắn đã kết
      // thúc (lõi chờ 2 phút); hàm v2 từ chối tháng đã có chỉ số nên không ghi trùng phần lần trước đã ghi.
      async pending => pending.meta?.dedupe === METER_IMPORT_KEYED ? { outcome: 'not-written', serverDedupesRequestKey: true } : { outcome: 'not-written' },
      undefined, { meta: { dedupe: METER_IMPORT_KEYED } });
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
      if(error instanceof FinancialWorkflowError){toast.error(error.outcome==='failure'?'Chưa nhập được chỉ số':'Chưa xác nhận nhập chỉ số',{description:recordWriteMessage(error,'nhập chỉ số')});return;}
      const feedback = friendlyError(error, 'Không thể nhập chỉ số', { operation: 'nhập chỉ số công tơ' });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

/**
 * Mutation UPDATE meter_readings (chỉ UNAPPROVED).
 * Invalidate queries, toast thành công.
 * Requirements: 5.1, 5.2
 *
 * Đợt 8 (luật 5, cách A): sửa theo mã và ĐẶT giá trị tuyệt đối (chỉ số, ngày chốt, ghi chú, ảnh). Trên meter_readings chỉ
 * có trigger BEFORE (giờ sửa, khoá công ty, chặn chỉ số có bằng chứng QR bằng 55000); không trigger nào cộng dồn hay đẩy
 * số sang hoá đơn, hoá đơn chỉ đọc chỉ số lúc lập. Ghi lại bao nhiêu lần cũng cùng kết quả nên không giữ dấu «chờ đối
 * chiếu»: rớt mạng thì báo rõ và cho bấm lại. Dấu bản trước của đúng chỉ số này được gỡ sau lần sửa thành công.
 */
export const useUpdateMeterReading = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateMeterReadingInput) => {
      const {id,...updates}=input;validateReadingWrite(input.current_reading,input.reading_date);
      const data = await repeatableWrite('cập nhật chỉ số', async () => {
        const { data, error } = await (supabase
          .from("meter_readings")
          .update(updates as any)
          .eq("id", id)
          .select()
          .single() as any);

        // Khớp 0 dòng (chỉ số không còn, hoặc tài khoản không được sửa): PostgREST lùi giao dịch, chưa ghi gì.
        if (error?.code === 'PGRST116') throw new FinancialWorkflowError('Không tìm thấy chỉ số này hoặc tài khoản chưa có quyền sửa. Tải lại danh sách để kiểm tra.', 'failure', [], error);
        if (error) throw error;
        confirmedRecordId(data,'cập nhật chỉ số',id);
        return data;
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'useUpdateMeterReading', businessKey: id }, { organizationId: 'actor-scope' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần sửa sau gỡ lại. */ }
      return data;
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
 *
 * Đợt 8 (luật 5): xoá mềm theo mã, lặp lại được, không giữ dấu. Chỉ đóng dấu dòng CÒN SỐNG nên gửi lại sau một lần đã xoá
 * không đè giờ xoá cũ; khớp 0 dòng thì đọc lại đúng chỉ số đó (đã xoá ⇒ thành công, còn nguyên ⇒ không có quyền xoá).
 */
export const useDeleteMeterReading = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const result = await repeatableWrite('xoá chỉ số', async () => {
        const { data, error } = await supabase
          .from("meter_readings")
          .update({ deleted_at: new Date().toISOString() } as any)
          .eq("id", id)
          .is("deleted_at", null)
          .select('id');

        if (error) throw error;
        if (!Array.isArray(data) || data.length > 1) throw new FinancialWorkflowError('Chưa xác nhận được kết quả xoá chỉ số.', 'unknown', [{ id, label: 'Chỉ số cần đối chiếu' }]);
        if (data.length === 1) { confirmedRecordId(data[0], 'xoá chỉ số', id); return { id, alreadyDeleted: false }; }
        await settleZeroRowDelete('xoá chỉ số', () => supabase.from('meter_readings').select('id,deleted_at').eq('id', id).maybeSingle());
        return { id, alreadyDeleted: true };
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'useDeleteMeterReading', businessKey: id }, { organizationId: 'actor-scope' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần xoá sau gỡ lại. */ }
      return result;
    },
    onSuccess: (result) => {
      invalidateMeterReadingQueries(queryClient);
      toast.success(result.alreadyDeleted ? "Chỉ số công tơ này đã được xoá trước đó" : "Đã xóa chỉ số công tơ");
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
 *
 * Đợt 8 (luật 5): như xoá một chỉ số, cho cả lựa chọn. Dòng đã xoá từ trước (lần gửi trước, người khác) không còn khớp và
 * không tính là lệch: các mã không trả về được đọc lại, đã xoá ⇒ đủ, còn nguyên ⇒ không có quyền xoá. Biên nhận mang mã
 * lạ hoặc trùng thì vẫn không tin (chưa rõ, bấm lại được).
 */
export const useBulkDeleteMeterReadings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (ids: string[]) => {
      if(!ids.length || new Set(ids).size!==ids.length)throw new FinancialWorkflowError('Chọn các chỉ số có mã khác nhau trước khi tiếp tục.','failure',[]);
      const operation = 'xoá chỉ số hàng loạt';
      const result = await repeatableWrite(operation, async () => {
        const { data, error } = await (supabase
          .from("meter_readings")
          .update({ deleted_at: new Date().toISOString() } as any)
          .in("id", ids)
          .is("deleted_at", null)
          .select("id") as any);

        if (error) throw error;
        if (!Array.isArray(data)) throw new MeterReadingBatchPartialError([], ids.length, 'xóa');
        const rows: unknown[] = data;
        const confirmedIds = rows.map(row => row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined).filter((id): id is string => typeof id === 'string' && !!id);
        if (confirmedIds.length !== rows.length || new Set(confirmedIds).size !== confirmedIds.length || confirmedIds.some(id => !ids.includes(id))) throw new MeterReadingBatchPartialError(confirmedIds.filter(id => ids.includes(id)), ids.length, 'xóa');
        const missing = ids.filter(id => !confirmedIds.includes(id));
        if (missing.length) {
          try { await settleZeroRowDelete(operation, () => supabase.from('meter_readings').select('id,deleted_at').in('id', missing)); }
          catch (failure) {
            if (confirmedIds.length && failure instanceof FinancialWorkflowError && failure.outcome === 'failure') throw new FinancialWorkflowError(`Đã xoá ${confirmedIds.length}/${ids.length} chỉ số; các chỉ số còn lại vẫn còn nhưng máy chủ không xoá. Tài khoản có thể chưa có quyền xoá các chỉ số đó.`, 'failure', [], failure);
            throw failure;
          }
        }
        return ids.map(id => ({ id }));
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'useBulkDeleteMeterReadings', businessKey: [...ids].sort().join(',') }, { organizationId: 'actor-scope' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần xoá sau gỡ lại. */ }
      return result;
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
