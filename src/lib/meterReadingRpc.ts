import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';

/**
 * Ghi chỉ số công tơ tháng qua hàm dùng chung `public.record_meter_readings_v2` (Hermes Đợt 3 Hoá đơn Mốc 4,
 * docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 6.2) — cùng một hàm với trợ lý Hermes, nên luật chống trùng tháng,
 * chỉ số đầu và quyền nằm ở database, không chép ở client.
 *
 * Hàm ghi từ chối CẢ LÔ khi có dòng không ghi được: lỗi 22023 `meter_readings_rejected`, `details` = JSON các dòng lỗi
 * (`n` đánh số theo thứ tự `rows` gửi lên, từ 1). Lỗi đó là từ chối đã xác nhận (chưa ghi gì) ⇒ `outcome: 'failure'`.
 */
export interface MeterReadingWriteRow { meterId: string; value: number; notes?: string | null; imageUrl?: string | null }
export interface RecordMeterReadingsInput { buildingId: string; readingDate: string; rows: MeterReadingWriteRow[]; replace?: boolean; idempotencyKey: string }
export type MeterReadingRpcName = 'record_meter_readings_v2';
export interface MeterReadingRpcError { code?: string; message?: string; details?: string | null; hint?: string | null }
export type MeterReadingInvoker = (name: MeterReadingRpcName, args: Record<string, Json>) => PromiseLike<{ data: unknown; error: MeterReadingRpcError | null }>;

export type MeterRowStatus = 'duplicate_month' | 'lower_than_previous' | 'used_by_invoice' | 'has_later_reading' | 'meter_not_found'
  | 'meter_ambiguous' | 'duplicate_in_batch' | 'invalid_value' | 'invalid_row' | 'building_not_found';
export const METER_ROW_STATUS_TEXT: Record<MeterRowStatus, string> = {
  duplicate_month: 'đã có chỉ số tháng này',
  lower_than_previous: 'nhỏ hơn chỉ số kỳ trước',
  used_by_invoice: 'chỉ số tháng này đã lên hoá đơn',
  has_later_reading: 'đã có chỉ số ngày sau ngày chốt',
  meter_not_found: 'không tìm thấy công tơ',
  meter_ambiguous: 'phòng có nhiều công tơ cùng loại',
  duplicate_in_batch: 'công tơ bị lặp trong lô',
  invalid_value: 'chỉ số không hợp lệ',
  invalid_row: 'dòng không hợp lệ',
  building_not_found: 'không tìm thấy toà nhà',
};

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rejectedRowSchema = z.object({
  n: z.number().int().positive().optional(), status: z.string(), roomName: z.string().optional(), meterCode: z.string().optional(),
  previous: z.number().optional(), existingValue: z.number().optional(), laterReadingDate: z.string().optional(),
}).passthrough();
export type MeterReadingRejectedRow = z.infer<typeof rejectedRowSchema>;

const fmt = (value: number) => value.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
export function meterRejectedRowText(row: MeterReadingRejectedRow): string {
  const who = `${row.roomName ?? (row.n ? `Dòng ${row.n}` : 'Một dòng')}${row.meterCode ? ` (${row.meterCode})` : ''}`;
  const base = METER_ROW_STATUS_TEXT[row.status as MeterRowStatus] ?? 'không ghi được';
  const extra = row.status === 'duplicate_month' && row.existingValue !== undefined ? ` (${fmt(row.existingValue)}); mở dòng đó để sửa`
    : row.status === 'lower_than_previous' && row.previous !== undefined ? ` (${fmt(row.previous)})`
    : row.status === 'used_by_invoice' ? '; sửa bằng điều chỉnh hoá đơn'
    : '';
  return `${who}: ${base}${extra}`;
}

/** Từ chối đã xác nhận của hàm ghi (chưa ghi dòng nào), kèm từng dòng lỗi để form đánh dấu. */
export class MeterReadingsRejectedError extends FinancialWorkflowError {
  constructor(readonly rows: readonly MeterReadingRejectedRow[]) {
    super(`Chưa lưu chỉ số nào: ${rows.map(meterRejectedRowText).join('; ')}.`, 'failure', []);
  }
}

export function parseMeterReadingsRejection(error: unknown): MeterReadingsRejectedError | null {
  if (!error || typeof error !== 'object') return null;
  const { code, message, details } = error as MeterReadingRpcError;
  if (code !== '22023' || message !== 'meter_readings_rejected' || typeof details !== 'string') return null;
  let parsed: unknown = null;
  try { parsed = JSON.parse(details); }
  catch { /* DETAIL không phải JSON ⇒ không phải từ chối từng dòng của hàm ghi; safeParse dưới trả null để lỗi gốc đi tiếp nguyên vẹn. */ }
  const rows = z.array(rejectedRowSchema).min(1).safeParse(parsed);
  return rows.success ? new MeterReadingsRejectedError(rows.data) : null;
}

export function buildRecordMeterReadingsArgs(input: RecordMeterReadingsInput): Record<string, Json> {
  const value = z.object({
    buildingId: uuid, readingDate: isoDate, replace: z.boolean().optional(),
    idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/),
    rows: z.array(z.object({ meterId: uuid, value: z.number().finite().nonnegative(), notes: z.string().nullable().optional(),
      imageUrl: z.string().nullable().optional() }).strict()).min(1).max(500),
  }).strict().parse(input);
  return {
    p_building_id: value.buildingId, p_reading_date: value.readingDate, p_replace: value.replace ?? false, p_idempotency_key: value.idempotencyKey,
    p_rows: value.rows.map(row => ({ meterId: row.meterId, value: row.value,
      ...(row.notes?.trim() ? { notes: row.notes.trim() } : {}), ...(row.imageUrl?.trim() ? { imageUrl: row.imageUrl.trim() } : {}) })),
  };
}

const writtenSchema = z.object({ n: z.number().int().positive(), id: uuid, code: z.string().nullable().optional(), meterId: uuid,
  previous: z.number(), value: z.number(), consumption: z.number() }).passthrough();
const resultSchema = z.object({ buildingId: uuid, readingDate: z.string(), settlementMonth: z.string(), count: z.number().int().nonnegative(),
  created: z.array(writtenSchema), replaced: z.array(writtenSchema) }).passthrough();
export type RecordMeterReadingsResult = z.infer<typeof resultSchema>;

export async function recordMeterReadings(invoke: MeterReadingInvoker, input: RecordMeterReadingsInput): Promise<RecordMeterReadingsResult> {
  const { data, error } = await invoke('record_meter_readings_v2', buildRecordMeterReadingsArgs(input));
  if (error) throw parseMeterReadingsRejection(error) ?? error;
  return resultSchema.parse(data);
}
