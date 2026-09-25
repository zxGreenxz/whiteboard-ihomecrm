// =============================================
// useCollectionTenders — đọc các DÒNG THU (invoice_payment_tenders) của khoản thu
// hoá đơn kiểu mới (từ 28/07/2026), cho hộp "Đổi hình thức thu" và cảnh báo thu
// trùng (đợt 1 sửa phiếu, 25/09/2026).
//
// Một lần thu (invoice_payment_collections) gồm 1..3 dòng TM/TK/TT, mỗi dòng có
// phiếu thu riêng (voucher_id). Người đã thu là collections.actor_id — KHÔNG phải
// income_expenses.user_id (thu kiểu mới ghi user_id = tài khoản chủ). Tên người
// thu đọc từ creator_name của phiếu thu (máy chủ lấy từ JWT lúc thu).
//
// Chỉ ĐỌC, qua supabase.from (RLS: xem được toà của hoá đơn). Mọi thao tác ghi đi
// qua RPC ở hooks/useReceivingCashbooks (đổi hình thức) và hooks/useDeletePayment
// (hoàn tác). Khoản thu kiểu cũ (payments không có collection) không có dòng nào ở đây.
// =============================================

import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { supabase } from '@/integrations/supabase/client';
import { DUPLICATE_COLLECTION_WINDOW_MS } from '@/lib/duplicateCollection';

// ── Kiểu dữ liệu ─────────────────────────────────────────────────────────────

/** Lần thu chứa dòng thu. */
export interface TenderCollection {
  id: string;
  invoice_id: string;
  /** ACTIVE | REVERSED */
  status: string;
  /** Người đã thu. */
  actor_id: string;
  created_at: string;
  collection_date: string;
}

/** Một dòng thu TM/TK/TT. */
export interface CollectionTender {
  id: string;
  collection_id: string;
  organization_id: string;
  line_index: number;
  payment_method: string;
  account_id: string | null;
  /** Tên sổ nhận (null khi người xem không đọc được sổ đó). */
  account_name: string | null;
  gross_amount: number;
  change_amount: number;
  rounding_amount: number;
  /** null ⇔ dòng không sinh phiếu thu (vd thối lại toàn bộ). */
  voucher_id: string | null;
  collector_name: string | null;
  collection: TenderCollection | null;
}

/** Dòng thu của MỘT phiếu thu, kèm toà của hoá đơn (màn Thu chi). */
export interface VoucherCollectionTender extends CollectionTender {
  building_id: string | null;
  building_name: string | null;
}

/** Lần thu gần đây của hoá đơn — dùng để cảnh báo thu trùng. */
export interface RecentInvoiceCollection {
  id: string;
  invoice_id: string;
  status: string;
  actor_id: string;
  gross_amount: number;
  created_at: string;
  collector_name: string | null;
}

/** Dòng thu đưa vào hộp "Đổi hình thức thu" (props cố định của ChangeCollectionMethodDialog). */
export interface ChangeCollectionMethodTender {
  id: string;
  paymentMethod: string;
  accountId: string | null;
  accountName: string | null;
  amount: number;
  changeAmount?: number | null;
  roundingAmount?: number | null;
  collectorUserId: string | null;
  buildingId: string;
  buildingName?: string | null;
}

// ── Đọc ──────────────────────────────────────────────────────────────────────

const tien = z.coerce.number();
const collectionSchema = z.object({
  id: z.string(),
  invoice_id: z.string(),
  status: z.string(),
  actor_id: z.string(),
  created_at: z.string(),
  collection_date: z.string(),
});
const tenderRowSchema = z.object({
  id: z.string(),
  collection_id: z.string(),
  organization_id: z.string(),
  line_index: z.coerce.number(),
  payment_method: z.string(),
  account_id: z.string().nullable(),
  gross_amount: tien,
  change_amount: tien,
  rounding_amount: tien,
  voucher_id: z.string().nullable(),
  account: z.object({ name: z.string().nullable() }).nullable().optional(),
  voucher: z.object({ creator_name: z.string().nullable() }).nullable().optional(),
});
const voucherTenderRowSchema = tenderRowSchema.extend({
  collection: collectionSchema
    .extend({
      invoice: z
        .object({
          id: z.string(),
          building_id: z.string().nullable(),
          building: z.object({ id: z.string(), name: z.string().nullable() }).nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
const recentCollectionSchema = z.object({
  id: z.string(),
  invoice_id: z.string(),
  status: z.string(),
  actor_id: z.string(),
  gross_amount: tien,
  created_at: z.string(),
  tenders: z
    .array(z.object({ voucher: z.object({ creator_name: z.string().nullable() }).nullable().optional() }))
    .nullable()
    .optional(),
});

type TenderRow = z.infer<typeof tenderRowSchema>;

// Chép TƯỜNG MINH từng trường: tsconfig.app.json tắt strictNullChecks nên kiểu zod
// suy ra có mọi trường là tuỳ chọn, không gán thẳng sang kiểu bắt buộc được.
const toCollection = (c: z.infer<typeof collectionSchema>): TenderCollection => ({
  id: c.id,
  invoice_id: c.invoice_id,
  status: c.status,
  actor_id: c.actor_id,
  created_at: c.created_at,
  collection_date: c.collection_date,
});

const toTender = (row: TenderRow, collection: TenderCollection | null): CollectionTender => ({
  id: row.id,
  collection_id: row.collection_id,
  organization_id: row.organization_id,
  line_index: row.line_index,
  payment_method: row.payment_method,
  account_id: row.account_id,
  account_name: row.account?.name ?? null,
  gross_amount: row.gross_amount,
  change_amount: row.change_amount,
  rounding_amount: row.rounding_amount,
  voucher_id: row.voucher_id,
  collector_name: row.voucher?.creator_name?.trim() || null,
  collection,
});

/** Mọi dòng thu (kể cả của lần thu đã hoàn tác) của một hoá đơn, theo thứ tự thu. */
export async function fetchInvoiceTenders(invoiceId: string): Promise<CollectionTender[]> {
  const { data: collectionData, error: collectionError } = await supabase
    .from('invoice_payment_collections')
    .select('id, invoice_id, status, actor_id, created_at, collection_date')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: true });
  if (collectionError) throw collectionError;
  const collections = z.array(collectionSchema).parse(collectionData ?? []).map(toCollection);
  if (collections.length === 0) return [];

  const { data: tenderData, error: tenderError } = await supabase
    .from('invoice_payment_tenders')
    .select(
      'id, collection_id, organization_id, line_index, payment_method, account_id, gross_amount, change_amount, rounding_amount, voucher_id, account:accounts!invoice_payment_tenders_account_id_fkey(name), voucher:income_expenses!invoice_payment_tenders_voucher_id_fkey(creator_name)',
    )
    .in('collection_id', collections.map((c) => c.id));
  if (tenderError) throw tenderError;

  const byId = new Map(collections.map((c) => [c.id, c]));
  const order = new Map(collections.map((c, i) => [c.id, i]));
  return z
    .array(tenderRowSchema)
    .parse(tenderData ?? [])
    .map((row) => toTender(row, byId.get(row.collection_id) ?? null))
    .sort(
      (a, b) =>
        (order.get(a.collection_id) ?? 0) - (order.get(b.collection_id) ?? 0) || a.line_index - b.line_index,
    );
}

/** Dòng thu sinh ra một phiếu thu (null khi phiếu không phải phiếu thu hoá đơn kiểu mới). */
export async function fetchTenderForVoucher(voucherId: string): Promise<VoucherCollectionTender | null> {
  const { data, error } = await supabase
    .from('invoice_payment_tenders')
    .select(
      'id, collection_id, organization_id, line_index, payment_method, account_id, gross_amount, change_amount, rounding_amount, voucher_id, account:accounts!invoice_payment_tenders_account_id_fkey(name), voucher:income_expenses!invoice_payment_tenders_voucher_id_fkey(creator_name), collection:invoice_payment_collections!invoice_payment_tenders_collection_id_fkey(id, invoice_id, status, actor_id, created_at, collection_date, invoice:invoices!invoice_payment_collections_invoice_id_fkey(id, building_id, building:buildings!invoices_building_id_fkey(id, name)))',
    )
    .eq('voucher_id', voucherId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = z.array(voucherTenderRowSchema).parse(data ?? [])[0];
  if (!row) return null;
  const c = row.collection ?? null;
  const collection = c ? toCollection(c) : null;
  return {
    ...toTender(row, collection),
    building_id: c?.invoice?.building_id ?? null,
    building_name: c?.invoice?.building?.name ?? null,
  };
}

/** Số hoá đơn mỗi lần hỏi — giữ URL `in.(…)` ngắn. */
const CHUNK = 100;
/** Lùi thêm khi lọc ở máy chủ để đồng hồ máy người dùng chạy nhanh vẫn không sót. */
const LECH_DONG_HO_MS = 10 * 60 * 1000;

/**
 * Lần thu CÒN HIỆU LỰC của các hoá đơn, ghi trong khoảng `windowMs` (+ biên lệch
 * đồng hồ) trước `now`. Luật "cùng số tiền, trong 30 phút" nằm ở
 * lib/duplicateCollection — hàm này chỉ đọc.
 */
export async function fetchRecentInvoiceCollections(
  invoiceIds: readonly string[],
  now: number = Date.now(),
  windowMs: number = DUPLICATE_COLLECTION_WINDOW_MS,
): Promise<RecentInvoiceCollection[]> {
  const ids = [...new Set(invoiceIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const since = new Date(now - windowMs - LECH_DONG_HO_MS).toISOString();
  const out: RecentInvoiceCollection[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('invoice_payment_collections')
      .select(
        'id, invoice_id, status, actor_id, gross_amount, created_at, tenders:invoice_payment_tenders!invoice_payment_tenders_collection_id_fkey(voucher:income_expenses!invoice_payment_tenders_voucher_id_fkey(creator_name))',
      )
      .in('invoice_id', ids.slice(i, i + CHUNK))
      .eq('status', 'ACTIVE')
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error) throw error;
    for (const row of z.array(recentCollectionSchema).parse(data ?? [])) {
      out.push({
        id: row.id,
        invoice_id: row.invoice_id,
        status: row.status,
        actor_id: row.actor_id,
        gross_amount: row.gross_amount,
        created_at: row.created_at,
        collector_name:
          (row.tenders ?? []).map((t) => t.voucher?.creator_name?.trim()).find((n) => !!n) || null,
      });
    }
  }
  return out;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

// Gốc 'invoice-payments-summary' để mọi mutation thu / hoàn tác hiện có (vốn đã
// invalidate gốc này) tự làm mới các dòng thu mà không phải sửa từng nơi.
export const invoiceTendersQueryKey = (invoiceId: string | null | undefined) =>
  ['invoice-payments-summary', 'tenders', invoiceId ?? null] as const;
export const voucherTenderQueryKey = (voucherId: string | null | undefined) =>
  ['invoice-payments-summary', 'tender-of-voucher', voucherId ?? null] as const;

export const useInvoiceTenders = (invoiceId: string | null | undefined, opts?: { enabled?: boolean }) =>
  useQuery({
    queryKey: invoiceTendersQueryKey(invoiceId),
    enabled: !!invoiceId && (opts?.enabled ?? true),
    queryFn: () => fetchInvoiceTenders(invoiceId as string),
  });

export const useTenderForVoucher = (voucherId: string | null | undefined, opts?: { enabled?: boolean }) =>
  useQuery({
    queryKey: voucherTenderQueryKey(voucherId),
    enabled: !!voucherId && (opts?.enabled ?? true),
    queryFn: () => fetchTenderForVoucher(voucherId as string),
  });

// ── Chuyển sang props của hộp "Đổi hình thức thu" ────────────────────────────

/** Dòng thu (+ toà của hoá đơn) → props `tender` của ChangeCollectionMethodDialog. */
export function toChangeMethodTender(
  t: CollectionTender,
  building: { id: string; name?: string | null },
): ChangeCollectionMethodTender {
  return {
    id: t.id,
    paymentMethod: t.payment_method,
    accountId: t.account_id,
    accountName: t.account_name,
    amount: t.gross_amount,
    changeAmount: t.change_amount,
    roundingAmount: t.rounding_amount,
    collectorUserId: t.collection?.actor_id ?? null,
    buildingId: building.id,
    buildingName: building.name ?? null,
  };
}

/** Như trên cho dòng thu đọc theo phiếu; null khi không biết toà của hoá đơn. */
export function changeMethodTenderOfVoucher(t: VoucherCollectionTender): ChangeCollectionMethodTender | null {
  if (!t.building_id) return null;
  return toChangeMethodTender(t, { id: t.building_id, name: t.building_name });
}

const HINH_THUC_DOI_DUOC = ['TM', 'TK', 'TT'];

/**
 * Vì sao dòng thu này KHÔNG đổi được hình thức (null = đổi được, còn tuỳ quyền).
 * Cùng điều kiện với change_collection_tender_method_v1; máy chủ vẫn là nơi chặn.
 */
export function tenderMethodChangeBlock(t: {
  paymentMethod: string;
  changeAmount?: number | null;
  roundingAmount?: number | null;
}): string | null {
  if (!HINH_THUC_DOI_DUOC.includes(t.paymentMethod)) {
    return 'Chỉ đổi được hình thức của khoản thu Tiền mặt, Chuyển khoản hoặc Thanh toán.';
  }
  if (Math.abs(Number(t.changeAmount) || 0) > 0) return 'Khoản thu có tiền thối nên không đổi hình thức được.';
  if (Math.abs(Number(t.roundingAmount) || 0) > 0) return 'Khoản thu có làm tròn nên không đổi hình thức được.';
  return null;
}
