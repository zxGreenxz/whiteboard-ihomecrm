// =============================================================================
// landlordSettlement — quyết toán toà VẬN HÀNH CHO CHỦ NHÀ (chủ chốt 21/10/2026).
//
// Công thức nằm DUY NHẤT ở database (app_private.landlord_settlement_compute_v1).
// File này chỉ đọc gói RPC (zod — sai hình thì ném, không đoán số) và đổi mã thành
// chữ hiển thị. Không cộng trừ tiền ở đây: số nào cũng lấy nguyên từ server.
// =============================================================================

import { z } from 'zod';
import { friendlyError } from '@/lib/friendlyError';

const money = z.number().finite();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

export const settlementVoucherSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().nullable(),
  voucher_date: isoDate,
  type: z.enum(['INCOME', 'EXPENSE']),
  name: z.string().nullable(),
  account_name: z.string().nullable(),
  side: z.enum(['LANDLORD', 'MANAGER']),
  group: z.enum(['PNL', 'DEPOSIT']),
  status: z.enum(['APPROVED', 'UNAPPROVED']),
  amount: money,
});
export type SettlementVoucher = z.infer<typeof settlementVoucherSchema>;

export const settlementStatementSchema = z.object({
  period_month: isoDate,
  manager_percent: money,
  totals: z.object({
    landlord_collected: money,
    manager_collected: money,
    revenue: money,
    landlord_paid: money,
    manager_paid: money,
    expense: money,
    profit: money,
    manager_share: money,
    landlord_share: money,
    landlord_owes_manager: money,
  }),
  deposits: z.object({ received: money, paid_out: money }),
  pending: z.object({ voucher_count: z.number().int().nonnegative(), income: money, expense: money }),
  vouchers: z.array(settlementVoucherSchema),
  source_hash: z.string().min(1),
});
export type SettlementStatement = z.infer<typeof settlementStatementSchema>;

export const CLOSE_BLOCKERS = ['MONTH_NOT_ENDED', 'PENDING_VOUCHERS', 'INACTIVE'] as const;
export type CloseBlocker = typeof CLOSE_BLOCKERS[number];

export const settlementMonthSchema = z.object({
  building_name: z.string(),
  landlord_name: z.string(),
  period_month: isoDate,
  status: z.enum(['NOT_APPLICABLE', 'OPEN', 'CLOSED']),
  effective_from: isoDate,
  is_current_month: z.boolean(),
  statement: settlementStatementSchema.nullable(),
  live_hash: z.string().nullable().optional(),
  is_stale: z.boolean(),
  closed: z.object({
    revision: z.number().int().positive(),
    closed_at: z.string(),
    note: z.string().nullable(),
    closed_by_name: z.string().nullable(),
  }).nullable(),
  can_close: z.boolean(),
  close_blockers: z.array(z.enum(CLOSE_BLOCKERS)),
});
export type SettlementMonth = z.infer<typeof settlementMonthSchema>;

export const PAYMENT_DIRECTIONS = ['LANDLORD_TO_MANAGER', 'MANAGER_TO_LANDLORD'] as const;
export type PaymentDirection = typeof PAYMENT_DIRECTIONS[number];

export const settlementPaymentSchema = z.object({
  id: z.string().uuid().optional(),
  paid_on: isoDate,
  direction: z.enum(PAYMENT_DIRECTIONS),
  amount: money,
  note: z.string().nullable(),
  created_at: z.string().optional(),
  voided: z.boolean().optional(),
  void_reason: z.string().nullable().optional(),
});
export type SettlementPayment = z.infer<typeof settlementPaymentSchema>;

export const settlementOverviewSchema = z.object({
  building_name: z.string(),
  landlord_name: z.string(),
  manager_percent: money,
  effective_from: isoDate,
  is_active: z.boolean(),
  current_month: isoDate,
  months: z.array(z.object({
    period_month: isoDate,
    status: z.enum(['OPEN', 'CLOSED']),
    is_stale: z.boolean(),
    is_current_month: z.boolean(),
    revenue: money,
    expense: money,
    profit: money,
    manager_share: money,
    landlord_owes_manager: money,
    pending_count: z.number().int().nonnegative(),
  })),
  payments: z.array(settlementPaymentSchema),
  totals: z.object({
    closed_net: money,
    open_net: money,
    paid_by_landlord: money,
    paid_by_manager: money,
    balance_closed: money,
    balance_with_open: money,
  }),
});
export type SettlementOverview = z.infer<typeof settlementOverviewSchema>;

export const settlementPublicSchema = z.object({
  overview: settlementOverviewSchema,
  month: settlementMonthSchema,
});
export type SettlementPublic = z.infer<typeof settlementPublicSchema>;

export const landlordOperationsListSchema = z.object({
  can_manage: z.boolean(),
  operations: z.array(z.object({
    building_id: z.string().uuid(),
    building_name: z.string(),
    organization_id: z.string().uuid(),
    landlord_name: z.string(),
    manager_percent: money,
    effective_from: isoDate,
    is_active: z.boolean(),
  })),
  candidate_buildings: z.array(z.object({
    building_id: z.string().uuid(),
    building_name: z.string(),
    organization_id: z.string().uuid(),
    configured: z.boolean(),
  })),
});
export type LandlordOperationsList = z.infer<typeof landlordOperationsListSchema>;
export type LandlordOperation = LandlordOperationsList['operations'][number];

export const landlordOperationOptionsSchema = z.object({
  current: z.object({
    landlord_name: z.string(),
    manager_percent: money,
    effective_from: isoDate,
    landlord_account_ids: z.array(z.string().uuid()),
    note: z.string().nullable(),
    is_active: z.boolean(),
    updated_at: z.string(),
  }).nullable(),
  accounts: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    code: z.string().nullable(),
    is_virtual: z.boolean(),
    income_count_120d: z.number().int().nonnegative(),
  })),
  history: z.array(z.object({
    created_at: z.string(),
    actor_name: z.string().nullable(),
    before: z.record(z.unknown()).nullable(),
    after: z.record(z.unknown()),
  })),
});
export type LandlordOperationOptions = z.infer<typeof landlordOperationOptionsSchema>;

export const shareLinksSchema = z.array(z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/),
  label: z.string().nullable(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
}));
export type ShareLink = z.infer<typeof shareLinksSchema>[number];

// Biên nhận của các RPC ghi — thiếu trường là coi như CHƯA XÁC NHẬN, không báo thành công.
export const upsertReceiptSchema = z.object({ building_id: z.string().uuid(), created: z.boolean() });
export const closeReceiptSchema = z.object({
  status: z.enum(['CLOSED', 'ALREADY_CLOSED']),
  revision: z.number().int().positive(),
});
export const reopenReceiptSchema = z.object({
  status: z.enum(['REOPENED', 'ALREADY_OPEN']),
  revision: z.number().int().positive().optional(),
});
export const paymentReceiptSchema = z.object({ id: z.string().uuid(), status: z.enum(['CREATED', 'REPLAYED']) });
export const voidReceiptSchema = z.object({ id: z.string().uuid(), status: z.enum(['VOIDED', 'ALREADY_VOIDED']) });
export const linkCreateReceiptSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/) });
export const linkRevokeReceiptSchema = z.object({ status: z.enum(['REVOKED', 'ALREADY_REVOKED']) });

// ─────────────────────────────── nhãn hiển thị ───────────────────────────────

export const CLOSE_BLOCKER_LABEL: Record<CloseBlocker, string> = {
  MONTH_NOT_ENDED: 'Tháng chưa kết thúc — chỉ chốt được tháng đã qua',
  PENDING_VOUCHERS: 'Còn phiếu chờ duyệt trong tháng — duyệt hoặc huỷ trước khi chốt',
  INACTIVE: 'Toà đang ngừng áp dụng vận hành cho chủ nhà',
};

export const PAYMENT_DIRECTION_LABEL: Record<PaymentDirection, string> = {
  LANDLORD_TO_MANAGER: 'Chủ nhà trả quản lý',
  MANAGER_TO_LANDLORD: 'Quản lý trả chủ nhà',
};

export type NetDirection = 'LANDLORD_PAYS' | 'MANAGER_PAYS' | 'EVEN';

/** Số quyết toán có dấu (dương: chủ nhà trả quản lý) → chiều + độ lớn để hiển thị. */
export function describeNet(net: number): { direction: NetDirection; amount: number } {
  if (!Number.isFinite(net)) throw new TypeError('Số quyết toán không hợp lệ');
  const rounded = Math.round(net);
  if (rounded > 0) return { direction: 'LANDLORD_PAYS', amount: rounded };
  if (rounded < 0) return { direction: 'MANAGER_PAYS', amount: -rounded };
  return { direction: 'EVEN', amount: 0 };
}

export const NET_DIRECTION_LABEL: Record<NetDirection, string> = {
  LANDLORD_PAYS: 'Chủ nhà trả quản lý',
  MANAGER_PAYS: 'Quản lý trả lại chủ nhà',
  EVEN: 'Hai bên không còn phải trả nhau',
};

// ─────────────────────────────── tháng ───────────────────────────────

/** 'YYYY-MM-DD' | 'YYYY-MM' → 'YYYY-MM'. */
export function monthKey(value: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(value);
  if (!m) throw new TypeError(`Tháng không hợp lệ: ${value}`);
  return `${m[1]}-${m[2]}`;
}

/** 'YYYY-MM' → 'YYYY-MM-01' (RPC nhận date). */
export const monthToDate = (key: string) => `${monthKey(key)}-01`;

/** 'YYYY-MM…' → 'Tháng 10/2026'. */
export function monthLabel(value: string): string {
  const [y, m] = monthKey(value).split('-');
  return `Tháng ${Number(m)}/${y}`;
}

/** Danh sách tháng 'YYYY-MM' từ `from` tới `to` (gồm hai đầu), mới nhất trước. */
export function monthsDescending(from: string, to: string): string[] {
  const start = monthKey(from);
  const end = monthKey(to);
  if (start > end) return [];
  const out: string[] = [];
  let [y, m] = end.split('-').map(Number);
  for (let guard = 0; guard < 600; guard += 1) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key === start) break;
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

/** Đường link chủ nhà mở trên điện thoại. */
export const landlordShareUrl = (origin: string, token: string) => `${origin.replace(/\/+$/, '')}/qt/${token}`;

// ─────────────────────────────── lỗi ───────────────────────────────

/** Mã lỗi mà RPC quyết toán RAISE kèm câu tiếng Việt viết cho người dùng. */
const MA_LOI_CO_CAU = new Set(['22023', '55000', '42501', '40001', 'P0002', '23505']);
const CO_DAU_TIENG_VIET = /[À-ỹ]/;

/**
 * Câu báo lỗi cho hộp thoại: lỗi do RPC quyết toán tự RAISE (mã đã biết, câu có dấu
 * tiếng Việt) thì hiện nguyên câu đó — nó nói đúng việc phải làm. Còn lại đi qua
 * friendlyError như mọi màn khác (vd "permission denied" thô của Postgres).
 */
export function landlordErrorMessage(error: unknown, fallbackTitle: string): string {
  if (error && typeof error === 'object') {
    const r = error as { code?: unknown; message?: unknown };
    if (typeof r.code === 'string' && MA_LOI_CO_CAU.has(r.code)
        && typeof r.message === 'string' && CO_DAU_TIENG_VIET.test(r.message)) {
      return r.message.trim();
    }
  }
  return friendlyError(error, fallbackTitle).description;
}
