import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
import { adjustmentItemSchema, type AdjustmentItem } from './invoiceAdjustmentEditor';

/**
 * Dòng giữ nguyên và lý do chặn của form Điều chỉnh hoá đơn lấy từ hàm dùng chung `public.invoice_adjustment_build_v1` (Hermes Đợt 3
 * Hoá đơn Mốc 5, docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 6.3) — cùng một hàm với trợ lý Hermes, nên luật "dòng không đụng đi
 * vào adjust_invoice_v2 nguyên xi" (thành tiền đã lưu lệch đơn giá × SL × hệ số ⇒ đơn giá = thành tiền, SL 1, hệ số 1) và luật chặn
 * (hoá đơn thanh lý, nợ cũ lệch nguồn đối chiếu) nằm ở database, không chép ở client. Form vẫn tự dựng dòng người dùng sửa.
 */
export type AdjustmentBuildRpcName = 'invoice_adjustment_build_v1';
export interface AdjustmentBuildRpcError { code?: string; message?: string }
export type AdjustmentBuildInvoker = (name: AdjustmentBuildRpcName, args: Record<string, Json>) => PromiseLike<{ data: unknown; error: AdjustmentBuildRpcError | null }>;

const uuid = z.string().uuid();
// Cùng khuôn dòng gửi lên adjust_invoice_v2 (id bắt buộc: đây là dòng đang có của hoá đơn).
const itemSchema = adjustmentItemSchema.extend({ id: uuid });
const buildSchema = z.object({
  invoiceId: uuid, kind: z.string().optional(), blockers: z.array(z.string()),
  before: z.object({ items: z.array(itemSchema), previousDebt: z.number().finite(), sourcedDebt: z.number().finite() }).passthrough().optional(),
}).passthrough();
export type AdjustmentBuild = z.infer<typeof buildSchema>;

export class AdjustmentBuildError extends Error {
  constructor() {
    super('Chưa tải được dữ liệu điều chỉnh từ máy chủ. Tải lại hoá đơn rồi thử lại.');
    this.name = 'AdjustmentBuildError';
  }
}

export async function fetchAdjustmentBuild(invoke: AdjustmentBuildInvoker, invoiceId: string): Promise<AdjustmentBuild> {
  const { data, error } = await invoke('invoice_adjustment_build_v1', { p_invoice_id: uuid.parse(invoiceId), p_ops: {} });
  if (error) throw new AdjustmentBuildError();
  const parsed = buildSchema.safeParse(data);
  if (!parsed.success || parsed.data.invoiceId !== invoiceId) throw new AdjustmentBuildError();
  return parsed.data;
}

/** Dòng hiện có của hoá đơn ở dạng gửi được cho adjust_invoice_v2 (luật dòng giữ nguyên của máy chủ), theo id. */
export function keptItemsById(build: AdjustmentBuild): ReadonlyMap<string, AdjustmentItem> {
  return new Map((build.before?.items ?? []).map(item => [item.id, item]));
}

const fmt = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))} đ`;
/** Câu chặn cho người dùng (cùng câu với bản tính ở trình duyệt trước Mốc 5), hoặc null khi điều chỉnh được. */
export function adjustmentBlockerMessage(build: AdjustmentBuild): string | null {
  const debt = build.before?.previousDebt ?? 0, sourced = build.before?.sourcedDebt ?? 0;
  if (build.blockers.includes('settlement')) {
    return 'Hoá đơn thanh lý chưa hỗ trợ điều chỉnh: dòng hoàn trả (cọc, tiền phòng thừa) mang dấu trừ mà máy chủ điều chỉnh đang cộng dương. Cần vá máy chủ trước.';
  }
  if (build.blockers.includes('debt_source_invalid')) {
    return `Nợ cũ ${fmt(debt)} có nguồn không hợp lệ nên máy chủ không đối soát được cơ cấu hoá đơn — cần kế toán sửa nguồn nợ trước khi điều chỉnh.`;
  }
  if (build.blockers.includes('debt_source_mismatch')) {
    return `Nợ cũ ${fmt(debt)} không khớp nguồn đối chiếu (${fmt(sourced)}) — máy chủ sẽ từ chối điều chỉnh hoá đơn này cho tới khi kế toán đối soát nợ cũ.`;
  }
  if (build.blockers.includes('not_issued')) return 'Hoá đơn chưa phát hành hoặc đã huỷ nên không điều chỉnh được.';
  if (build.blockers.includes('not_found')) return 'Không tìm thấy hoá đơn này trong phạm vi quyền của bạn. Tải lại trang.';
  return null;
}
