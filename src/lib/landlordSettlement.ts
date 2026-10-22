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
  /** PNL: tính lợi nhuận · DEPOSIT: cọc/tiền khách trả thừa · EXCLUDED: không tính (vẫn liệt kê). */
  group: z.enum(['PNL', 'DEPOSIT', 'EXCLUDED']),
  /** Phiếu do thanh lý hợp đồng sinh ra (system_source termination.*). */
  source: z.enum(['TERMINATION_REVENUE', 'FORFEIT_REVENUE', 'TERMINATION_REFUND', 'DEPOSIT_OFFSET', 'EXTRA_RECEIPT', 'RENT_REFUND_INTERNAL']).nullable(),
  /** Đã duyệt nhưng bút toán sổ quỹ đã bị đảo — tiền không còn ở sổ nào. */
  cash_reversed: z.boolean(),
  /** Đã duyệt nhưng chưa ghi sổ quỹ (UNPOSTED) — tiền chưa thực vào/ra. */
  cash_unposted: z.boolean(),
  /** Phiếu dùng sổ chủ nhà của toà vận hành khác (chặn chốt). Link chủ nhà không có trường này. */
  foreign_landlord_account: z.boolean().optional(),
  /** Phiếu có hạng mục hạn chế — link chủ nhà che tên phiếu. */
  restricted: z.boolean(),
  excluded_reason: z.enum(['NOT_KQKD', 'INTERNAL']).nullable(),
  status: z.enum(['APPROVED', 'UNAPPROVED']),
  amount: money,
});
export type SettlementVoucher = z.infer<typeof settlementVoucherSchema>;

export const settlementStatementSchema = z.object({
  period_month: isoDate,
  manager_percent: money,
  /** Tháng bắt đầu của điều khoản (% + sổ chủ nhà) đang áp cho tháng này. */
  terms_from: isoDate,
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
    /** Cọc/tiền khách trả thừa vào sổ chủ nhà − chi ra từ sổ chủ nhà (chủ nhà giữ hộ quản lý). */
    landlord_held_deposits: money,
    /** Tiền thối rơi vào sổ chủ nhà (tiền của khách, chủ nhà giữ hộ). Làm tròn không tính. */
    landlord_extra_cash: money,
    landlord_owes_manager: money,
  }),
  reversed_voucher_count: z.number().int().nonnegative(),
  unposted_voucher_count: z.number().int().nonnegative(),
  foreign_account_voucher_count: z.number().int().nonnegative(),
  deposits: z.object({ received: money, paid_out: money, landlord_received: money, landlord_paid_out: money }),
  termination: z.object({
    revenue_from_deposit: money,
    forfeit_revenue: money,
    extra_receipt: money,
    refund_beyond_deposit: money,
    deposit_refunded: money,
    deposit_offset: money,
    pending_refund: money,
  }),
  pending: z.object({
    voucher_count: z.number().int().nonnegative(),
    income: money,
    expense: money,
    /** Cọc/trả thừa chờ duyệt ở sổ chủ nhà (vào dương, ra âm). */
    landlord_deposit: money,
  }),
  excluded: z.object({ voucher_count: z.number().int().nonnegative(), income: money, expense: money }),
  vouchers: z.array(settlementVoucherSchema),
  source_hash: z.string().min(1),
});
export type SettlementStatement = z.infer<typeof settlementStatementSchema>;

export const CLOSE_BLOCKERS = [
  'MONTH_NOT_ENDED', 'PENDING_VOUCHERS', 'REVERSED_POSTINGS', 'UNPOSTED_POSTINGS', 'FOREIGN_LANDLORD_ACCOUNT',
  'LANDLORD_ACCOUNT_ELSEWHERE', 'PRE_START_PENDING', 'OPENING_UNCONFIRMED', 'INACTIVE',
] as const;
export type CloseBlocker = typeof CLOSE_BLOCKERS[number];

const countedVouchersSchema = z.object({
  voucher_count: z.number().int().nonnegative(),
  vouchers: z.array(z.object({
    code: z.string().nullable(),
    voucher_date: isoDate,
    type: z.enum(['INCOME', 'EXPENSE']),
    name: z.string().nullable(),
    amount: money,
    building_name: z.string().nullable().optional(),
    status: z.string().optional(),
  })),
});

/** Cảnh báo quanh quyết toán (chỉ màn quản trị) — không đổi số, chỉ làm lộ chỗ có thể sai. */
export const settlementWarningsSchema = z.object({
  /** Khoản chi cố định đã khai ở Phí cố định theo toà mà tháng này chưa có phiếu chi. */
  missing_fixed_expenses: z.array(z.string()),
  /** Phiếu ở toà khác / toà ảo có nhắc mã toà này. */
  related_elsewhere: countedVouchersSchema,
  /** Phiếu của toà khác ghi vào sổ chủ nhà của toà này (chặn chốt). */
  landlord_account_elsewhere: countedVouchersSchema,
  /** Phiếu chờ duyệt ghi ngày trước tháng áp dụng (chỉ ở tháng đầu tiên). */
  pre_start_pending: countedVouchersSchema.extend({ income: money, expense: money }).nullable(),
});
export type SettlementWarnings = z.infer<typeof settlementWarningsSchema>;

export const BRIDGE_REASONS = [
  'VOUCHER_OTHER_MONTH', 'INVOICE_PERIOD', 'INVALID_PERIOD', 'SERVICE_PERIOD', 'SERVICE_OTHER_MONTH',
  'NO_CATEGORY', 'CHANGED_AFTER_CLOSE', 'OTHER',
] as const;
/** Đối chiếu với KQKD toà (theo kỳ) — từng phiếu làm hai con số lợi nhuận khác nhau. */
export const kqkdBridgeSchema = z.object({
  kqkd_profit: money,
  settlement_profit: money,
  rows: z.array(z.object({
    code: z.string().nullable(),
    voucher_date: isoDate,
    type: z.enum(['INCOME', 'EXPENSE']),
    name: z.string().nullable(),
    /** Có dấu: thu dương, chi âm. */
    settlement_amount: money,
    kqkd_amount: money,
    reason: z.enum(BRIDGE_REASONS),
  })),
});
export type KqkdBridge = z.infer<typeof kqkdBridgeSchema>;

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
  warnings: settlementWarningsSchema.nullable(),
  kqkd_bridge: kqkdBridgeSchema.nullable(),
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
  /** Số dư đầu kỳ đã được đối chiếu với chủ nhà. */
  opening_confirmed: z.boolean(),
  current_month: isoDate,
  months: z.array(z.object({
    period_month: isoDate,
    status: z.enum(['OPEN', 'CLOSED']),
    is_stale: z.boolean(),
    is_current_month: z.boolean(),
    manager_percent: money,
    revenue: money,
    expense: money,
    profit: money,
    manager_share: money,
    landlord_owes_manager: money,
    pending_count: z.number().int().nonnegative(),
  })),
  payments: z.array(settlementPaymentSchema),
  totals: z.object({
    opening_balance: money,
    closed_month_count: z.number().int().nonnegative(),
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
    /** % và sổ chủ nhà của điều khoản MỚI NHẤT (từ terms_from). */
    manager_percent: money,
    landlord_account_ids: z.array(z.string().uuid()),
    terms_from: isoDate,
    effective_from: isoDate,
    note: z.string().nullable(),
    is_active: z.boolean(),
    opening_balance: money,
    opening_confirmed_at: z.string().nullable(),
    /** Xác nhận cũ hết hiệu lực: đã dời tháng áp dụng hoặc cọc trước kỳ đã đổi. */
    opening_confirmation_stale: z.boolean(),
    /** Cọc trước kỳ ở sổ chủ nhà lúc xác nhận. */
    opening_confirmed_pre_start: money.nullable(),
    /** Gợi ý: cọc/trả thừa đã nằm ở sổ chủ nhà trước tháng áp dụng. */
    pre_start_landlord_deposits: money,
    first_closed_month: isoDate.nullable(),
    last_closed_month: isoDate.nullable(),
    /** Tháng mặc định cho tỷ lệ / sổ mới: ngay sau tháng chốt gần nhất. */
    next_terms_month: isoDate,
    terms: z.array(z.object({
      valid_from: isoDate,
      manager_percent: money,
      landlord_account_ids: z.array(z.string().uuid()),
    })),
    updated_at: z.string(),
  }).nullable(),
  accounts: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    code: z.string().nullable(),
    is_virtual: z.boolean(),
    /** Sổ đã xoá nhưng còn trong danh sách sổ chủ nhà — hiện ra để bỏ chọn. */
    is_deleted: z.boolean(),
    income_count_120d: z.number().int().nonnegative(),
    /** Số toà KHÁC có phiếu trên sổ này trong 120 ngày (sổ dùng chung ⇒ không phải sổ riêng của chủ nhà). */
    other_building_count_120d: z.number().int().nonnegative(),
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
export const upsertReceiptSchema = z.object({
  building_id: z.string().uuid(),
  created: z.boolean(),
  /** Tháng bắt đầu của điều khoản mới (null: % và sổ không đổi). */
  terms_from: isoDate.nullable(),
  /** Có tick đối chiếu nhưng cơ sở (tháng / sổ đầu / cọc trước kỳ) vừa đổi ⇒ chưa ghi xác nhận, phải mở lại đối chiếu. */
  opening_needs_reconfirm: z.boolean(),
  /** Sau lần lưu vẫn còn phải đối chiếu số dư đầu kỳ thì mới chốt được tháng. */
  opening_needs_confirm: z.boolean(),
});
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
  REVERSED_POSTINGS: 'Có phiếu đã duyệt nhưng bút toán sổ quỹ đã bị đảo (tiền không ở sổ nào) — xử lý phiếu trước khi chốt',
  UNPOSTED_POSTINGS: 'Có phiếu đã duyệt nhưng chưa ghi sổ quỹ (tiền chưa thực vào/ra) — ghi sổ hoặc huỷ trước khi chốt',
  FOREIGN_LANDLORD_ACCOUNT: 'Có phiếu dùng sổ chủ nhà của toà vận hành khác — chuyển phiếu về đúng sổ, hoặc thêm sổ đó vào sổ chủ nhà của toà này',
  LANDLORD_ACCOUNT_ELSEWHERE: 'Có phiếu của toà khác ghi vào sổ chủ nhà của toà này — chuyển phiếu về đúng sổ trước khi chốt',
  PRE_START_PENDING: 'Còn phiếu chờ duyệt ghi ngày trước tháng áp dụng — duyệt hoặc huỷ trước khi chốt tháng đầu tiên',
  OPENING_UNCONFIRMED: 'Chưa xác nhận số dư đầu kỳ với chủ nhà (hoặc xác nhận cũ hết hiệu lực vì đã dời tháng áp dụng / cọc trước kỳ đổi) — mở Cài đặt toà, đối chiếu rồi đánh dấu đã xác nhận',
  INACTIVE: 'Toà đang ngừng áp dụng vận hành cho chủ nhà',
};

export const VOUCHER_SOURCE_LABEL: Record<NonNullable<SettlementVoucher['source']>, string> = {
  TERMINATION_REVENUE: 'Thanh lý: cấn cọc vào khoản khách phải trả',
  FORFEIT_REVENUE: 'Thanh lý: khách bỏ cọc',
  TERMINATION_REFUND: 'Thanh lý: trả lại khách',
  DEPOSIT_OFFSET: 'Thanh lý: cấn trừ cọc',
  EXTRA_RECEIPT: 'Thanh lý: khách trả thêm phần vượt cọc',
  RENT_REFUND_INTERNAL: 'Thanh lý: bù trừ nội bộ tiền phòng (tự triệt tiêu)',
};

export const EXCLUDED_REASON_LABEL: Record<NonNullable<SettlementVoucher['excluded_reason']>, string> = {
  NOT_KQKD: 'phiếu tắt tính KQKD',
  INTERNAL: 'khoản nội bộ',
};

export const BRIDGE_REASON_LABEL: Record<typeof BRIDGE_REASONS[number], string> = {
  VOUCHER_OTHER_MONTH: 'Ngày phiếu ở tháng khác, KQKD tính vào tháng này',
  INVOICE_PERIOD: 'Hoá đơn của kỳ khác — KQKD tính theo tháng hoá đơn',
  INVALID_PERIOD: 'Kỳ dịch vụ trên phiếu bị ngược (ngày kết thúc trước ngày bắt đầu)',
  SERVICE_PERIOD: 'Khoản chia theo kỳ dịch vụ nhiều tháng',
  SERVICE_OTHER_MONTH: 'Kỳ dịch vụ là tháng khác (trả trước / trả sau)',
  NO_CATEGORY: 'Dòng phiếu chưa có hạng mục — KQKD bỏ qua dòng này',
  CHANGED_AFTER_CLOSE: 'Phiếu đổi sau khi chốt (số chốt khác số hiện tại)',
  OTHER: 'Khác — mở phiếu để xem',
};

const FIXED_FEE_LABEL: Record<string, string> = {
  tien_nha: 'Tiền nhà', dien: 'Điện', nuoc: 'Nước', internet: 'Internet', quan_ly: 'Phí quản lý',
  ve_sinh: 'Vệ sinh', cong_an: 'Công an', rac: 'Rác', thang_may: 'Thang máy',
};
/** Khoá khoản chi cố định (Phí cố định theo toà) → chữ. */
export const fixedFeeLabel = (key: string): string => FIXED_FEE_LABEL[key] ?? key;

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

/** 'YYYY-MM…' → '10/2026'. */
export function monthShort(value: string): string {
  const [y, m] = monthKey(value).split('-');
  return `${m}/${y}`;
}

/**
 * Điều khoản đang áp ở tháng 'YYYY-MM': bản có valid_from lớn nhất ≤ tháng (sớm hơn bản đầu thì lấy
 * bản đầu — server luôn giữ bản đầu trùng tháng áp dụng). Danh sách đã xếp tăng theo valid_from.
 */
export function termsAt<T extends { valid_from?: string }>(terms: readonly T[], month: string): T | null {
  let hit: T | null = terms[0] ?? null;
  for (const t of terms) if (t.valid_from && monthKey(t.valid_from) <= month) hit = t;
  return hit;
}

/** Hai danh sách id cùng phần tử (không kể thứ tự / trùng). */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

const termsText = (v: unknown): string => {
  if (!Array.isArray(v) || v.length === 0) return '—';
  return v.map((t) => {
    const r = (t ?? {}) as { valid_from?: unknown; manager_percent?: unknown; landlord_account_ids?: unknown };
    const from = typeof r.valid_from === 'string' ? monthShort(r.valid_from) : '?';
    const n = Array.isArray(r.landlord_account_ids) ? r.landlord_account_ids.length : 0;
    return `từ ${from}: ${String(r.manager_percent)}% · ${n} sổ chủ nhà`;
  }).join('; ');
};

/**
 * Một dòng sổ thay đổi cấu hình (ảnh trước/sau do server ghi) → các câu ngắn cho người đọc.
 * Không suy luận gì thêm: trường nào khác nhau thì nói trường đó.
 */
export function describeOperationChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  formatMoney: (n: number) => string,
): string[] {
  if (!before) return ['Tạo cài đặt'];
  const out: string[] = [];
  const diff = (k: string) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null);
  if (diff('landlord_name')) out.push(`Tên chủ nhà: ${String(before.landlord_name)} → ${String(after.landlord_name)}`);
  if (diff('effective_from') && typeof before.effective_from === 'string' && typeof after.effective_from === 'string') {
    out.push(`Áp dụng từ: ${monthShort(before.effective_from)} → ${monthShort(after.effective_from)}`);
  }
  if (diff('terms')) out.push(`Tỷ lệ / sổ chủ nhà: ${termsText(before.terms)} → ${termsText(after.terms)}`);
  if (diff('opening_balance')) {
    out.push(`Số dư đầu kỳ: ${formatMoney(Number(before.opening_balance ?? 0))} → ${formatMoney(Number(after.opening_balance ?? 0))}`);
  }
  if (diff('opening_confirmed_at')) {
    out.push(after.opening_confirmed_at == null ? 'Bỏ xác nhận số dư đầu kỳ'
      : before.opening_confirmed_at == null ? 'Xác nhận số dư đầu kỳ với chủ nhà' : 'Xác nhận lại số dư đầu kỳ');
  }
  if (diff('is_active')) out.push(after.is_active === false ? 'Ngừng áp dụng' : 'Áp dụng lại');
  if (diff('note')) out.push('Sửa ghi chú thoả thuận');
  return out.length > 0 ? out : ['Lưu lại, không đổi nội dung'];
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
