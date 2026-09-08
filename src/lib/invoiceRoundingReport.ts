import { z } from 'zod';

const money = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = money;
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const nullableId = z.string().uuid().nullable();
const roundingRow = z.object({
  payment_id: nullableId,
  collection_id: nullableId,
  invoice_id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  building_id: z.string().uuid(),
  building_name: z.string().nullable(),
  room_name: z.string().nullable(),
  billing_month: month,
  collection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  collector_id: nullableId,
  collector_name: z.string().nullable(),
  gross_amount: money.nullable(),
  change_amount: money.nullable(),
  applied_amount: money,
  rounding_amount: money,
  reason: z.enum(['UNDERPAYMENT', 'EXTRA_CHANGE', 'LEGACY']),
}).strict();

const collectorSummary = z.object({
  collector_id: nullableId,
  collector_name: z.string().nullable(),
  total_amount: money,
  invoice_count: count,
  total_count: count,
}).strict();

const reportSchema = z.object({
  rows: z.array(roundingRow),
  total_count: count,
  total_amount: money,
  invoice_count: count,
  // SQL returns every collector in period/building scope for a stable selector.
  by_collector: z.array(collectorSummary),
}).strict();

export type InvoiceRoundingReport = z.infer<typeof reportSchema>;
export type InvoiceRoundingRow = z.infer<typeof roundingRow>;
export type InvoiceRoundingReason = InvoiceRoundingRow['reason'];
export type RoundingReportErrorKind = 'permission' | 'validation' | 'contract' | 'unavailable';

export class RoundingReportError extends Error {
  constructor(public readonly kind: RoundingReportErrorKind) {
    super({
      permission: 'Bạn không có quyền xem báo cáo khoản bỏ qua trong phạm vi này.',
      validation: 'Bộ lọc báo cáo chưa hợp lệ. Vui lòng chọn lại kỳ, người thu hoặc tòa.',
      contract: 'Dữ liệu báo cáo chưa hợp lệ. Vui lòng thử lại hoặc báo quản trị viên.',
      unavailable: 'Chưa tải được báo cáo khoản bỏ qua. Vui lòng thử lại.',
    }[kind]);
    this.name = 'RoundingReportError';
  }
}

export function parseInvoiceRoundingReport(value: unknown): InvoiceRoundingReport {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) throw new RoundingReportError('contract');
  return parsed.data;
}

export interface InvoiceRoundingFilters {
  billingMonth: string;
  collectorId?: string | null;
  buildingId?: string | null;
  offset?: number;
  limit?: number;
}

const argsSchema = z.object({
  p_billing_month: month,
  p_collector_id: nullableId,
  p_building_id: nullableId,
  p_offset: count,
  p_limit: z.number().int().min(1).max(100),
}).strict();

export interface InvoiceRoundingReportArgs {
  p_billing_month: string;
  p_collector_id: string | null;
  p_building_id: string | null;
  p_offset: number;
  p_limit: number;
}
export type InvoiceRoundingReportInvoker = (args: InvoiceRoundingReportArgs) => PromiseLike<{
  data: unknown;
  error: null | { code?: string; message?: string };
}>;

export async function fetchInvoiceRoundingReport(
  filters: InvoiceRoundingFilters,
  invoke: InvoiceRoundingReportInvoker,
): Promise<InvoiceRoundingReport> {
  const args = argsSchema.safeParse({
    p_billing_month: filters.billingMonth,
    p_collector_id: filters.collectorId || null,
    p_building_id: filters.buildingId || null,
    p_offset: filters.offset ?? 0,
    p_limit: filters.limit ?? 50,
  });
  if (!args.success) throw new RoundingReportError('validation');
  const { data, error } = await invoke({
    p_billing_month: args.data.p_billing_month,
    p_collector_id: args.data.p_collector_id,
    p_building_id: args.data.p_building_id,
    p_offset: args.data.p_offset,
    p_limit: args.data.p_limit,
  });
  if (error) {
    if (error.code === '42501' || error.code === 'PGRST301') throw new RoundingReportError('permission');
    if (error.code === '22023' || error.code === '22P02') throw new RoundingReportError('validation');
    throw new RoundingReportError('unavailable');
  }
  return parseInvoiceRoundingReport(data);
}

export const ROUNDING_REASON_LABELS: Record<InvoiceRoundingReason, string> = {
  UNDERPAYMENT: 'Khách đóng thiếu', EXTRA_CHANGE: 'Thối thêm', LEGACY: 'Dữ liệu cũ',
};
