// =============================================================================
// landlordSettlement — quyết toán toà VẬN HÀNH CHO CHỦ NHÀ (chủ chốt 21/10/2026).
//
// Công thức nằm DUY NHẤT ở database (app_private.landlord_settlement_compute_v1).
// File này chỉ đọc gói RPC (zod — sai hình thì ném, không đoán số) và đổi mã thành
// chữ hiển thị. Không cộng trừ tiền ở đây: số nào cũng lấy nguyên từ server.
// =============================================================================

import { z } from 'zod';
import { friendlyError } from '@/lib/friendlyError';
import { invoiceAmountPartsSchema } from '@/lib/invoiceAmountParts';
import type { InvoiceTitleParts } from '@/lib/invoiceUtils';
import { voucherDisplayName } from '@/lib/voucherDisplayName';

const money = z.number().finite();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

/**
 * Người giữ cọc của khách (chủ chốt 23/10/2026, hợp đồng dữ liệu v3): bên giữ cọc là bên hoàn cọc khi khách
 * trả phòng. Cọc nằm ở sổ bên kia thì bên đó bàn giao lại trong quyết toán (`deposit_adjustment`).
 */
export const DEPOSIT_HOLDERS = ['MANAGER', 'LANDLORD'] as const;
export type DepositHolder = typeof DEPOSIT_HOLDERS[number];
/** Gói/ảnh chốt trước v3 không có trường ⇒ luật cũ: quản lý giữ cọc. */
const depositHolderOrManager = z.enum(DEPOSIT_HOLDERS).nullish().transform((v): DepositHolder => v ?? 'MANAGER');
/** Trường số MỚI của v3 — ảnh chốt cũ không có ⇒ null (UI ẩn / hiện "—"), không đoán số. */
const newMoney = money.nullish().transform((v) => v ?? null);
const newText = z.string().nullish().transform((v) => v ?? null);

/**
 * Các phần dựng tên hoá đơn của phiếu (server CHÉP luật invoiceTitlePartsOf — link chủ nhà chạy bằng anon
 * nên không đọc được bảng invoices). Không có notes.
 */
export const settlementVoucherInvoiceSchema = z.object({
  kind: z.string().nullable(),
  billing_month: z.string().nullable(),
  issue_date: isoDate.nullable(),
  has_rent: z.boolean(),
  has_service: z.boolean(),
  is_first_month: z.boolean(),
  is_liquidation: z.boolean(),
  is_extra: z.boolean(),
});

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
  /** NO_CATEGORY: dòng lãi lỗ mà hạng mục không còn tồn tại — KQKD (Báo cáo LN) bỏ qua, ở đây vẫn liệt kê. */
  excluded_reason: z.enum(['NOT_KQKD', 'INTERNAL', 'NO_CATEGORY']).nullable(),
  status: z.enum(['APPROVED', 'UNAPPROVED']),
  amount: money,
  /**
   * Tên phòng + phần hoá đơn để dựng TÊN HIỂN THỊ (src/lib/voucherDisplayName.ts, chủ nhắn 23/10/2026).
   * Ảnh chốt trước ngày đó không có; link chủ nhà bỏ cả hai ở phiếu hạn chế.
   */
  room_name: z.string().nullable().optional(),
  invoice: settlementVoucherInvoiceSchema.nullable().optional(),
  /**
   * Chỉ dòng lãi lỗ (group PNL): phần tiền của KỲ tháng này theo hạng mục, server gộp theo tên, xếp giảm dần.
   * Ảnh chốt trước v3 không có; link chủ nhà: phiếu hạn chế ⇒ null.
   */
  lines: z.array(z.object({ category: z.string(), amount: money })).nullish().transform((v) => v ?? null),
  /**
   * Phiếu thu lãi lỗ theo hoá đơn: phần KỲ tháng này chia theo dòng hoá đơn (phòng / điện / nước / PDV / khác —
   * chủ chốt 25/10/2026). Phiếu khác, phiếu hạn chế, ảnh chốt trước ngày đó ⇒ null.
   */
  parts: invoiceAmountPartsSchema.nullish().transform((v) => v ?? null),
});
export type SettlementVoucher = z.infer<typeof settlementVoucherSchema>;

/** Một hạng mục lãi lỗ ĐÃ DUYỆT trong tháng — amount = landlord_amount + manager_amount do server cộng. */
export const settlementCategorySchema = z.object({
  name: z.string(),
  amount: money,
  landlord_amount: money,
  manager_amount: money,
});
export type SettlementCategory = z.infer<typeof settlementCategorySchema>;

/** Phần hoá đơn server trả → InvoiceTitleParts (đổi tên trường, không suy thêm). */
export function invoicePartsOfSettlement(inv: z.infer<typeof settlementVoucherInvoiceSchema>): InvoiceTitleParts {
  return {
    isLiquidation: inv.is_liquidation,
    isExtra: inv.is_extra,
    isFirstMonth: inv.is_first_month,
    hasRent: inv.has_rent,
    hasService: inv.has_service,
    billingMonth: inv.billing_month,
    issueDate: inv.issue_date,
  };
}

/**
 * Tên hiển thị của phiếu trong "Phiếu trong tháng": tên hoá đơn thay "Thu tiền theo HĐ INV-…", bỏ mã hợp
 * đồng ở tên thanh lý / bỏ cọc; danh sách không có cột phòng ⇒ chèn tên phòng. Link chủ nhà: phiếu hạn chế
 * giữ đúng tên đã bị server che.
 */
export function settlementVoucherName(v: SettlementVoucher, mode: 'admin' | 'public'): string {
  if (v.restricted && mode === 'public') return v.name || '(không tên)';
  const shown = voucherDisplayName(
    { name: v.name, roomName: v.room_name ?? null, invoice: v.invoice ? invoicePartsOfSettlement(v.invoice) : null },
    { includeRoom: true },
  );
  return shown || '(không tên)';
}

export const settlementStatementSchema = z.object({
  period_month: isoDate,
  manager_percent: money,
  /**
   * Tiền quản lý nhận cố định mỗi tháng (đồng) của điều khoản đang áp — chủ chốt 23/10/2026. Ảnh chốt
   * trước ngày đó không có trường này: thoả thuận lúc đó chỉ có % ⇒ 0.
   */
  manager_fixed_amount: money.optional().default(0),
  /** Tháng bắt đầu của điều khoản (% + tiền cố định + sổ chủ nhà) đang áp cho tháng này. */
  terms_from: isoDate,
  /** Người giữ cọc của điều khoản đang áp. Ảnh chốt trước v3 ⇒ "MANAGER" (luật cũ). */
  deposit_holder: depositHolderOrManager,
  totals: z.object({
    landlord_collected: money,
    manager_collected: money,
    revenue: money,
    landlord_paid: money,
    manager_paid: money,
    expense: money,
    profit: money,
    /** Phần cố định — nhận đủ cả tháng lỗ. Ảnh chốt cũ không có ⇒ 0. */
    manager_fixed_share: money.optional(),
    /** Phần % lợi nhuận — LN ≤ 0 thì 0. Ảnh chốt cũ không có ⇒ toàn bộ phần quản lý là phần %. */
    manager_percent_share: money.optional(),
    /** Phần quản lý = phần cố định + phần %. */
    manager_share: money,
    /** = lợi nhuận − phần quản lý; âm khi LN không đủ trả phần cố định (chủ nhà bù). */
    landlord_share: money,
    /** Cọc/tiền khách trả thừa vào sổ chủ nhà − chi ra từ sổ chủ nhà (chủ nhà giữ hộ quản lý). */
    landlord_held_deposits: money,
    /** Tiền thối rơi vào sổ chủ nhà (tiền của khách, chủ nhà giữ hộ). Làm tròn không tính. */
    landlord_extra_cash: money,
    landlord_owes_manager: money,
    /** v3: cọc/trả thừa ở SỔ QUẢN LÝ trong tháng (thu − hoàn/cấn), đã duyệt. Ảnh cũ ⇒ null ("—"). */
    manager_held_deposits: money.nullish(),
    /**
     * v3: phần cọc đã cộng vào landlord_owes_manager, CÓ DẤU — quản lý giữ: = landlord_held_deposits;
     * chủ nhà giữ: = −manager_held_deposits. Ảnh cũ ⇒ chép landlord_held_deposits (không tính).
     */
    deposit_adjustment: money.nullish(),
    /** v3: mỗi sổ đang giữ từ thu chi lãi lỗ trong tháng (thu − chi; âm = ứng tiền chi hộ). Ảnh cũ ⇒ null. */
    landlord_net_held: money.nullish(),
    manager_net_held: money.nullish(),
  }).transform((t) => ({
    ...t,
    // không cộng trừ: ảnh chốt cũ (chỉ có %) thì phần % chính là toàn bộ phần quản lý server đã tính
    manager_fixed_share: t.manager_fixed_share ?? 0,
    manager_percent_share: t.manager_percent_share ?? t.manager_share,
    manager_held_deposits: t.manager_held_deposits ?? null,
    landlord_net_held: t.landlord_net_held ?? null,
    manager_net_held: t.manager_net_held ?? null,
    deposit_adjustment: t.deposit_adjustment ?? t.landlord_held_deposits,
  })),
  reversed_voucher_count: z.number().int().nonnegative(),
  unposted_voucher_count: z.number().int().nonnegative(),
  foreign_account_voucher_count: z.number().int().nonnegative(),
  deposits: z.object({
    received: money,
    paid_out: money,
    landlord_received: money,
    landlord_paid_out: money,
    /** v3: cọc/trả thừa vào / ra ở sổ quản lý. Ảnh cũ ⇒ null. */
    manager_received: newMoney,
    manager_paid_out: newMoney,
  }),
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
    /** v3: cọc/trả thừa CHỜ DUYỆT ở bên sổ có tính vào quyết toán (theo deposit_holder), có dấu. */
    deposit: money.nullish(),
  }).transform((p) => ({ ...p, deposit: p.deposit ?? p.landlord_deposit })),
  excluded: z.object({ voucher_count: z.number().int().nonnegative(), income: money, expense: money }),
  vouchers: z.array(settlementVoucherSchema),
  /** v3: lãi lỗ ĐÃ DUYỆT theo hạng mục. Ảnh cũ ⇒ null (ẩn khối "Theo hạng mục"). */
  categories: z.object({
    income: z.array(settlementCategorySchema),
    expense: z.array(settlementCategorySchema),
  }).nullish().transform((v) => v ?? null),
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
  /** Khoản lãi lỗ có KỲ trước tháng áp dụng mà phiếu lập sau (chỉ ở tháng đầu tiên) — không tính, không chặn. */
  pre_start_period: countedVouchersSchema.extend({ income: money, expense: money }).nullable().optional(),
});
export type SettlementWarnings = z.infer<typeof settlementWarningsSchema>;

/**
 * Quyết toán xếp dòng lãi lỗ theo đúng luật kỳ của KQKD nên bình thường khớp từng đồng. Còn lệch chỉ do
 * phiếu đổi sau khi chốt, hoặc luật kỳ của KQKD đã đổi mà quyết toán chưa đổi theo (lỗi kỹ thuật).
 */
export const BRIDGE_REASONS = ['CHANGED_AFTER_CLOSE', 'FORMULA_DRIFT'] as const;
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

/**
 * Dữ liệu THÔ cho ghi chú phòng (phòng chưa đóng / trống / HĐ chưa thanh lý) của toà × tháng — server chép bộ
 * lọc của useVacantRoomNotes, id thay bằng mã tạm trong gói; luật ở src/lib/vacantRoomNotes.ts. Sống (không vào
 * ảnh chốt); server cũ / tháng chưa áp dụng ⇒ null.
 */
const amountLike = z.union([z.number(), z.string()]).nullable();
export const settlementRoomDataSchema = z.object({
  rooms: z.array(z.object({ id: z.string(), name: z.string().nullable(), status: z.string().nullable() })),
  contracts: z.array(z.object({
    id: z.string(),
    room_id: z.string().nullable(),
    status: z.string(),
    start_date: z.string().nullable(),
    start_billing_date: z.string().nullable(),
    end_date: z.string().nullable(),
    actual_end_date: z.string().nullable(),
    /** Link chủ nhà: null. */
    contract_number: z.string().nullable(),
  })),
  invoices: z.array(z.object({
    id: z.string(),
    contract_id: z.string(),
    status: z.string(),
    kind: z.string().nullable(),
    total_amount: amountLike,
    paid_amount: amountLike,
    remaining_amount: amountLike,
    is_overdue: z.boolean().nullable(),
  })),
  terminations: z.array(z.object({
    contract_id: z.string(),
    termination_type: z.string().nullable(),
    termination_date: z.string().nullable(),
    actual_move_out_date: z.string().nullable(),
    status: z.string().nullable(),
  })),
  transfers: z.array(z.object({
    old_room_id: z.string().nullable(),
    transfer_type: z.string().nullable(),
    transfer_date: z.string().nullable(),
    status: z.string().nullable(),
  })),
});
export type SettlementRoomData = z.infer<typeof settlementRoomDataSchema>;

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
    /** Ghi chú bàn giao MỚI NHẤT của lần chốt này (v3: sửa được sau khi chốt). */
    note: z.string().nullable(),
    closed_by_name: z.string().nullable(),
    /** v3: lúc sửa ghi chú bàn giao sau khi chốt; chưa sửa / ảnh cũ ⇒ null. */
    note_updated_at: newText,
  }).nullable(),
  can_close: z.boolean(),
  close_blockers: z.array(z.enum(CLOSE_BLOCKERS)),
  warnings: settlementWarningsSchema.nullable(),
  kqkd_bridge: kqkdBridgeSchema.nullable(),
  /**
   * v3: chủ nhà xác nhận đã xem số liệu cho ĐÚNG lần chốt hiện tại (closed.revision). Mở chốt / chốt lại /
   * tháng OPEN / server cũ ⇒ null = CHƯA xác nhận.
   */
  confirmation: z.object({
    confirmed_at: z.string(),
    note: newText,
    /** Tên người xem đã xác nhận qua link tên miền (PIN); link /qt cũ / server cũ ⇒ null. */
    by: newText,
  }).nullish().transform((v) => v ?? null),
  room_data: settlementRoomDataSchema.nullish().transform((v) => v ?? null),
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
  /** Tiền cố định/tháng của điều khoản mới nhất. */
  manager_fixed_amount: money.optional().default(0),
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
    /** Server đã đổi ảnh chốt cũ (không có trường) thành 0. */
    manager_fixed_amount: money.optional().default(0),
    revenue: money,
    expense: money,
    profit: money,
    manager_share: money,
    landlord_owes_manager: money,
    pending_count: z.number().int().nonnegative(),
    // v3 — "Cách tính" từng tháng ở tab Thống kê. Thiếu ⇒ null: UI ẩn dòng đó, không tự tính.
    manager_fixed_share: newMoney,
    manager_percent_share: newMoney,
    /** Quản lý đã chi hộ. */
    manager_paid: newMoney,
    /** Quản lý đã thu hộ. */
    manager_collected: newMoney,
    deposit_holder: z.enum(DEPOSIT_HOLDERS).nullish().transform((v) => v ?? null),
    /** Có dấu như statement.totals.deposit_adjustment. */
    deposit_adjustment: newMoney,
    /** landlord_extra_cash của tháng. */
    extra_cash: newMoney,
    close_revision: z.number().int().positive().nullish().transform((v) => v ?? null),
    /** Chủ nhà xác nhận lần chốt hiện tại; chưa / server cũ ⇒ null. */
    confirmed_at: newText,
  })),
  /** v3: người giữ cọc của điều khoản MỚI NHẤT; server cũ ⇒ null. */
  deposit_holder: z.enum(DEPOSIT_HOLDERS).nullish().transform((v) => v ?? null),
  /** Ký hiệu sổ của toà (24/10/2026); chưa đặt / server cũ ⇒ null = CN / QL. */
  landlord_book_code: newText,
  manager_book_code: newText,
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
    manager_fixed_amount: money.optional().default(0),
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
    /** %, tiền cố định và sổ chủ nhà của điều khoản MỚI NHẤT (từ terms_from). */
    manager_percent: money,
    manager_fixed_amount: money.optional().default(0),
    landlord_account_ids: z.array(z.string().uuid()),
    /**
     * v3: người giữ cọc của TOÀ (áp mọi tháng từ tháng bắt đầu; chỉ đổi được khi chưa chốt tháng nào —
     * chủ chốt 23/10/2026); thiếu ⇒ "MANAGER".
     */
    deposit_holder: depositHolderOrManager,
    /** Ký hiệu sổ của toà; chưa đặt / server cũ ⇒ null. */
    landlord_book_code: newText,
    manager_book_code: newText,
    terms_from: isoDate,
    effective_from: isoDate,
    note: z.string().nullable(),
    is_active: z.boolean(),
    opening_balance: money,
    opening_confirmed_at: z.string().nullable(),
    /** Xác nhận cũ hết hiệu lực: đã dời tháng áp dụng hoặc cọc trước kỳ đã đổi. */
    opening_confirmation_stale: z.boolean(),
    /** Gợi ý cọc trước kỳ (cùng cách tính bên dưới) lúc xác nhận. */
    opening_confirmed_pre_start: money.nullable(),
    /**
     * Gợi ý số dư đầu kỳ từ cọc/trả thừa nằm TRƯỚC tháng áp dụng ở sổ của bên KHÔNG giữ cọc, có dấu: quản lý
     * giữ cọc ⇒ + cọc ở sổ chủ nhà (chủ nhà bàn giao); chủ nhà giữ cọc ⇒ − cọc ở sổ quản lý (quản lý bàn giao).
     */
    pre_start_landlord_deposits: money,
    first_closed_month: isoDate.nullable(),
    last_closed_month: isoDate.nullable(),
    /** Tháng mặc định cho tỷ lệ / sổ mới: ngay sau tháng chốt gần nhất. */
    next_terms_month: isoDate,
    terms: z.array(z.object({
      valid_from: isoDate,
      manager_percent: money,
      manager_fixed_amount: money.optional().default(0),
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
/** landlord_settlement_note_update_v1 — sửa ghi chú bàn giao của lần chốt `revision`. */
export const noteUpdateReceiptSchema = z.object({
  status: z.enum(['UPDATED', 'UNCHANGED']),
  revision: z.number().int().positive(),
  updated_at: z.string(),
});
/** landlord_settlement_confirm_v1 (link chủ nhà) — xác nhận đã xem số liệu lần chốt đó. */
export const confirmReceiptSchema = z.object({
  status: z.enum(['CONFIRMED', 'ALREADY_CONFIRMED']),
  confirmed_at: z.string(),
});
export type ConfirmReceipt = z.infer<typeof confirmReceiptSchema>;
/** landlord_operation_book_codes_v1 — đặt ký hiệu sổ của toà (đã chuẩn hoá; null = mặc định). */
export const bookCodesReceiptSchema = z.object({
  status: z.enum(['UPDATED', 'UNCHANGED']),
  landlord_book_code: z.string().nullable(),
  manager_book_code: z.string().nullable(),
});

/**
 * Ký hiệu sổ (chủ nhắn 24/10/2026: 950NK sổ chủ nhà "CG", sổ quản lý "ET") — hiện ở ô đầu dòng Khoản chi và
 * nút lọc theo sổ. Chưa đặt ⇒ CN / QL. Server chuẩn hoá y như normalizeBookCode.
 */
export const DEFAULT_BOOK_CODE = { LANDLORD: 'CN', MANAGER: 'QL' } as const;
export type BookCodes = Record<DepositHolder, string>;
export const BOOK_CODE_MAX = 4;
export const normalizeBookCode = (s: string | null | undefined): string | null => {
  const v = (s ?? '').trim().toUpperCase();
  return v === '' ? null : v;
};
export const bookCodesOf = (src: { landlord_book_code?: string | null; manager_book_code?: string | null } | null | undefined): BookCodes => ({
  LANDLORD: src?.landlord_book_code || DEFAULT_BOOK_CODE.LANDLORD,
  MANAGER: src?.manager_book_code || DEFAULT_BOOK_CODE.MANAGER,
});
/** Lỗi nhập ký hiệu (null = hợp lệ) — cùng luật server (22023). */
export function bookCodesError(landlord: string | null, manager: string | null): string | null {
  for (const c of [landlord, manager]) {
    if (c !== null && (c.length > BOOK_CODE_MAX || /\s/.test(c))) return `Ký hiệu sổ tối đa ${BOOK_CODE_MAX} ký tự, không có khoảng trắng.`;
  }
  const shown = bookCodesOf({ landlord_book_code: landlord, manager_book_code: manager });
  return shown.LANDLORD === shown.MANAGER ? 'Ký hiệu sổ chủ nhà và sổ quản lý phải khác nhau.' : null;
}

/** Giới hạn server (22023 khi vượt). */
export const HANDOVER_NOTE_MAX = 1000;
export const LANDLORD_CONFIRM_NOTE_MAX = 500;

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

/** Nhãn ngắn cho chip "Chưa chốt được: …" ở đầu trang (câu đầy đủ ở CLOSE_BLOCKER_LABEL). */
export const CLOSE_BLOCKER_SHORT: Record<CloseBlocker, string> = {
  MONTH_NOT_ENDED: 'tháng chưa kết thúc',
  PENDING_VOUCHERS: 'còn phiếu chờ duyệt',
  REVERSED_POSTINGS: 'có bút toán sổ quỹ bị đảo',
  UNPOSTED_POSTINGS: 'có phiếu chưa ghi sổ quỹ',
  FOREIGN_LANDLORD_ACCOUNT: 'có phiếu dùng sổ chủ nhà toà khác',
  LANDLORD_ACCOUNT_ELSEWHERE: 'có phiếu toà khác vào sổ chủ nhà',
  PRE_START_PENDING: 'còn phiếu chờ duyệt trước tháng áp dụng',
  OPENING_UNCONFIRMED: 'chưa đối chiếu số dư đầu kỳ',
  INACTIVE: 'toà đang ngừng áp dụng',
};

export const DEPOSIT_HOLDER_LABEL: Record<DepositHolder, string> = { MANAGER: 'Quản lý', LANDLORD: 'Chủ nhà' };

/**
 * Dòng cọc trong "Cách tính" theo người giữ cọc và dấu của deposit_adjustment (server tính). Chỉ đổi mã ⇒
 * chữ; số hiện là trị tuyệt đối, dấu nằm ở chữ "+ / −".
 */
export function depositAdjustmentLine(holder: DepositHolder, adjustment: number): { label: string; sub: string; amount: number } {
  const amount = Math.abs(adjustment);
  if (holder === 'MANAGER') {
    if (adjustment < 0) return { label: '− Cọc chủ nhà đã chi trả khách thay quản lý', sub: 'quản lý giữ cọc', amount };
    return {
      label: '+ Cọc của khách ở sổ chủ nhà',
      sub: adjustment > 0 ? 'quản lý giữ cọc → chủ nhà bàn giao cho quản lý' : 'quản lý giữ cọc · tháng này sổ chủ nhà không có cọc',
      amount,
    };
  }
  if (adjustment > 0) return { label: '+ Cọc quản lý đã chi trả khách thay chủ nhà', sub: 'chủ nhà giữ cọc', amount };
  return {
    label: '− Cọc của khách ở sổ quản lý',
    sub: adjustment < 0 ? 'chủ nhà giữ cọc → quản lý bàn giao cho chủ nhà' : 'chủ nhà giữ cọc · tháng này sổ quản lý không có cọc',
    amount,
  };
}

/** Tiền thối (landlord_extra_cash) — chỉ hiện khi khác 0. */
export function extraCashLabel(extra: number): string {
  return extra > 0 ? '+ Tiền thối của khách nằm ở sổ chủ nhà' : '− Tiền thối chủ nhà đã chi';
}

/** Tỷ lệ phần / tổng (0–100) CHỈ để vẽ thanh — kẹp biên, tổng ≤ 0 ⇒ 0. Không dùng để ra số tiền. */
export function barPercent(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, (part / total) * 100));
}

/** Chữ tỷ trọng "57%" · "8,5%" (dưới 10% giữ một chữ số lẻ); tổng ≤ 0 ⇒ null (không hiện). */
export function shareText(part: number, total: number): string | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  const p = (part / total) * 100;
  return Math.abs(p) >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1).replace('.', ',')}%`;
}

const VN_TZ = 'Asia/Ho_Chi_Minh';
const vnParts = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: VN_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: `${get('day')}/${get('month')}/${get('year')}`, time: `${get('hour')}:${get('minute')}` };
};
/** Thời điểm (timestamptz) → "08:30 · 01/11/2026" giờ Việt Nam. */
export function vnDateTime(iso: string): string {
  const p = vnParts(iso);
  return p ? `${p.time} · ${p.day}` : iso;
}
/** Thời điểm (timestamptz) → "01/11/2026" giờ Việt Nam. */
export function vnDate(iso: string): string {
  return vnParts(iso)?.day ?? iso;
}

/**
 * Các năm có trong danh sách tháng, mới nhất trước. Trường để tuỳ chọn vì tsconfig.app (không strict) suy
 * kiểu zod thành tuỳ chọn (như ManagerTerms).
 */
export function settlementYears(months: readonly { period_month?: string }[]): string[] {
  const years = months.flatMap((m) => (m.period_month ? [monthKey(m.period_month).slice(0, 4)] : []));
  return [...new Set(years)].sort((a, b) => b.localeCompare(a));
}

export type MonthConfirmState =
  | { kind: 'CONFIRMED'; at: string }
  | { kind: 'WAITING'; text: 'Chờ xác nhận' | 'Chưa xác nhận' }
  | { kind: 'OPEN'; text: 'Đang chạy' | 'Tạm tính' };

/** Cột "Chủ nhà" ở tab Thống kê: đã xác nhận lần chốt hiện tại / chưa / tháng chưa chốt. */
export function monthConfirmState(
  // tuỳ chọn: xem settlementYears
  m: { status?: 'OPEN' | 'CLOSED'; is_current_month?: boolean; confirmed_at?: string | null },
  viewing: boolean,
): MonthConfirmState {
  if (m.status === 'OPEN') return { kind: 'OPEN', text: m.is_current_month ? 'Đang chạy' : 'Tạm tính' };
  if (m.confirmed_at) return { kind: 'CONFIRMED', at: m.confirmed_at };
  return { kind: 'WAITING', text: viewing ? 'Chờ xác nhận' : 'Chưa xác nhận' };
}

/** Ô chữ viết tắt cho dòng không có phòng: "Tiền điện" → "TĐ", "Internet" → "IN". */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  if (words.length === 1) return words[0].slice(0, 2).toLocaleUpperCase('vi-VN');
  return `${words[0][0]}${words[1][0]}`.toLocaleUpperCase('vi-VN');
}

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
  NO_CATEGORY: 'dòng phiếu có hạng mục đã mất — Báo cáo LN cũng bỏ qua',
};

export const BRIDGE_REASON_LABEL: Record<typeof BRIDGE_REASONS[number], string> = {
  CHANGED_AFTER_CLOSE: 'Phiếu đổi sau khi chốt (số chốt khác số hiện tại)',
  FORMULA_DRIFT: 'Lệch công thức chia kỳ với Báo cáo LN — lỗi kỹ thuật, báo người làm phần mềm',
};

/** Phần chủ nhà theo toà × tháng cho dòng "Lợi nhuận của iHome" trên Báo cáo LN (chủ chốt 22/10). */
export const landlordIhomeProfitSchema = z.array(z.object({
  building_id: z.string().uuid(),
  period_month: isoDate,
  /** CLOSED: số đã chốt · OPEN: số tạm tính (theo kỳ, phiếu đã duyệt). */
  status: z.enum(['OPEN', 'CLOSED']),
  profit: money,
  manager_share: money,
  landlord_share: money,
}));
export type LandlordIhomeProfitRow = z.infer<typeof landlordIhomeProfitSchema>[number];

/**
 * Lợi nhuận của iHome = tổng lợi nhuận đang xem − phần chủ nhà của các toà vận hành có trong phạm vi
 * (toà đang lọc × tháng đang xem). Phần chủ nhà vẫn tính nhưng không hiện thành dòng riêng.
 */
export function ihomeProfitOf(
  totalProfit: number,
  rows: readonly LandlordIhomeProfitRow[],
  scope: { months: readonly string[]; buildingIds: readonly string[] | null },
): { profit: number; landlordShare: number; operatedCount: number; provisional: boolean } {
  const months = new Set(scope.months.map(monthKey));
  const buildings = scope.buildingIds ? new Set(scope.buildingIds) : null;
  const hit = rows.filter((r) => months.has(monthKey(r.period_month)) && (!buildings || buildings.has(r.building_id)));
  const landlordShare = hit.reduce((s, r) => s + r.landlord_share, 0);
  return {
    profit: totalProfit - landlordShare,
    landlordShare,
    operatedCount: new Set(hit.map((r) => r.building_id)).size,
    provisional: hit.some((r) => r.status === 'OPEN'),
  };
}

/** Dòng "Lợi nhuận của iHome" trên Báo cáo LN khi đã có dữ liệu phần chủ nhà. */
export type IhomeLineDecision =
  | { kind: 'hidden' }
  /** Có toà vận hành trong phạm vi nhưng trang đang xem cơ sở khác (theo ngày phiếu / gồm cọc). */
  | { kind: 'other-basis'; operatedCount: number }
  | { kind: 'ready'; profit: number; operatedCount: number; provisional: boolean };

/**
 * Quyết định dòng iHome. Phần chủ nhà (server) tính theo kỳ trên phiếu ĐÃ DUYỆT, chỉ KQKD ⇒ chỉ trừ vào
 * tổng cùng cơ sở (`sameBasis`); toà vận hành trong phạm vi còn phiếu CHỜ DUYỆT nằm trong tổng ⇒ phần chủ
 * nhà của các phiếu đó chưa trừ ⇒ "tạm tính", như tháng chưa chốt quyết toán.
 */
export function ihomeLineOf(
  rows: readonly LandlordIhomeProfitRow[],
  input: {
    ym: string;
    buildingIds: readonly string[];
    totalProfit: number;
    sameBasis: boolean;
    pendingBuildingIds: ReadonlySet<string>;
  },
): IhomeLineDecision {
  const scope = { months: [input.ym], buildingIds: input.buildingIds.length > 0 ? input.buildingIds : null };
  const r = ihomeProfitOf(input.totalProfit, rows, scope);
  // không có toà vận hành nào trong phạm vi: tổng chính là lợi nhuận của iHome — không cần dòng riêng
  if (r.operatedCount === 0) return { kind: 'hidden' };
  if (!input.sameBasis) return { kind: 'other-basis', operatedCount: r.operatedCount };
  const inScope = scope.buildingIds ? new Set(scope.buildingIds) : null;
  const pendingOperated = rows.some((row) => monthKey(row.period_month) === monthKey(input.ym)
    && (!inScope || inScope.has(row.building_id))
    && input.pendingBuildingIds.has(row.building_id));
  return { kind: 'ready', profit: r.profit, operatedCount: r.operatedCount, provisional: r.provisional || pendingOperated };
}

/** Toà có phiếu chờ duyệt trong các dòng báo cáo đang xem (để đánh dấu "tạm tính"). */
export function pendingBuildingIdsOf(
  rows: readonly { buildingId: string | null; approvalStatus: 'APPROVED' | 'UNAPPROVED' }[] | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const r of rows ?? []) if (r.approvalStatus === 'UNAPPROVED' && r.buildingId) out.add(r.buildingId);
  return out;
}

/** Chữ giải thích dòng iHome (tooltip) — desktop và mobile dùng chung. */
export function ihomeLineTitle(line: { operatedCount: number; provisional: boolean }): string {
  return `Tổng lợi nhuận trừ phần của chủ nhà ở ${line.operatedCount} toà vận hành cho chủ nhà (theo kỳ, phiếu đã duyệt)`
    + (line.provisional ? ' — tạm tính: còn tháng chưa chốt quyết toán hoặc phiếu chờ duyệt ở toà vận hành' : '');
}

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

/**
 * Phần quản lý theo thoả thuận (chủ chốt 23/10/2026): tiền cố định/tháng và/hoặc % lợi nhuận tháng.
 * Trường để tuỳ chọn vì tsconfig.app (không strict) suy kiểu zod thành tuỳ chọn; thiếu = 0.
 */
export interface ManagerTerms { manager_percent?: number; manager_fixed_amount?: number }

const pctText = (p: number) => `${p.toLocaleString('vi-VN')}%`;

/** "5.000.000 đ/tháng + 30% lợi nhuận" · "5.000.000 đ/tháng cố định" · "30% lợi nhuận". */
export function managerTermsLabel(t: ManagerTerms, formatMoney: (n: number) => string): string {
  const pct = t.manager_percent ?? 0;
  const fixed = t.manager_fixed_amount ?? 0;
  if (fixed > 0 && pct > 0) return `${formatMoney(fixed)}/tháng + ${pctText(pct)} lợi nhuận`;
  if (fixed > 0) return `${formatMoney(fixed)}/tháng cố định`;
  return `${pctText(pct)} lợi nhuận`;
}

/** Nhãn ngắn trong bảng tháng: "30%" · "cố định" · "cố định + 30%". */
export function managerTermsShort(t: ManagerTerms): string {
  const pct = t.manager_percent ?? 0;
  const fixed = t.manager_fixed_amount ?? 0;
  if (fixed > 0 && pct > 0) return `cố định + ${pctText(pct)}`;
  if (fixed > 0) return 'cố định';
  return pctText(pct);
}

/**
 * Tháng mà lợi nhuận không đủ trả phần cố định (lỗ, hoặc lãi ít hơn phần quản lý): phần chủ nhà âm —
 * chủ nhà bù đúng số này. Không có phần cố định thì phần chủ nhà âm chỉ là lỗ của tháng (luật cũ) ⇒ null.
 */
export function landlordShortfallOf(t: { manager_fixed_share?: number; landlord_share?: number }): number | null {
  const fixed = t.manager_fixed_share ?? 0;
  const landlord = t.landlord_share ?? 0;
  return fixed > 0 && landlord < 0 ? -landlord : null;
}

export const NET_DIRECTION_LABEL: Record<NetDirection, string> = {
  LANDLORD_PAYS: 'Chủ nhà trả quản lý',
  MANAGER_PAYS: 'Quản lý trả lại chủ nhà',
  EVEN: 'Hai bên không còn phải trả nhau',
};

// ─────────────────────────────── dòng phiếu & "Cách tính" (hiển thị) ───────────────────────────────

/** Nhóm phiếu của danh sách "Phiếu trong tháng" / "Khoản khác". */
export type VoucherGroupKey =
  | 'landlord_in' | 'manager_in' | 'landlord_out' | 'manager_out'
  | 'termination' | 'deposit' | 'pending' | 'excluded';

/** Ghi chú phụ của một dòng phiếu (kỳ khác, thanh lý, không tính, sổ quỹ…) — dạng " · a · b" hoặc "". */
export function voucherRowNote(
  v: SettlementVoucher, key: VoucherGroupKey, mode: 'admin' | 'public', periodMonth: string,
  opts: { skipPeriod?: boolean } = {},
): string {
  const parts: string[] = [];
  // dòng lãi lỗ xếp tháng THEO KỲ trên hạng mục: phiếu lập tháng khác vẫn có thể thuộc tháng này (vd thu
  // trước tiền phòng tháng sau). Số tiền là phần của kỳ tháng này. Thẻ Khoản thu không còn ghi ngày phiếu nên
  // bỏ ghi chú này (chủ nhắn 26/10/2026).
  if (!opts.skipPeriod && v.group === 'PNL' && v.voucher_date.slice(0, 7) !== periodMonth.slice(0, 7)) {
    parts.push(`tính theo kỳ tháng ${periodMonth.slice(5, 7)}/${periodMonth.slice(0, 4)}`);
  }
  if (v.source) parts.push(VOUCHER_SOURCE_LABEL[v.source]);
  if (key === 'termination' || key === 'deposit' || key === 'pending' || key === 'excluded') {
    if (v.group === 'DEPOSIT') parts.push(v.type === 'INCOME' ? 'thu cọc/trả thừa' : 'hoàn/cấn cọc');
    else if (v.group === 'PNL') parts.push(v.type === 'INCOME' ? 'doanh thu' : 'chi phí');
    // link chủ nhà: tên sổ đã là nhãn bên giữ tiền thì không nhắc lại
    if (mode === 'admin' || !v.account_name) parts.push(v.side === 'LANDLORD' ? 'sổ chủ nhà' : 'sổ quản lý');
  }
  if (v.excluded_reason) parts.push(`không tính: ${EXCLUDED_REASON_LABEL[v.excluded_reason]}`);
  if (v.cash_reversed) parts.push('bút toán sổ quỹ đã bị đảo');
  if (v.cash_unposted) parts.push('chưa ghi sổ quỹ');
  if (v.foreign_landlord_account) parts.push('sổ chủ nhà của toà khác — chặn chốt');
  if (v.status === 'UNAPPROVED') parts.push('chờ duyệt');
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

export interface CalcLine {
  key: string;
  label: string;
  sub?: string | null;
  amount: number;
  /** Số 0 / không áp dụng — chữ nhạt. */
  muted?: boolean;
}

/**
 * Dòng "Cách tính" (tab Quyết toán và "Cách tính · Tháng X" ở tab Thống kê). Trường null = gói không có
 * (ảnh chốt / server cũ) ⇒ ẩn dòng đó, không tự tính bù. Chữ "+ / −" mang dấu; số là số server trả.
 */
export interface CalcInput {
  managerPercent: number;
  /** Tiền cố định/tháng của điều khoản (để biết có phần cố định khi chưa có số tách). */
  managerFixedAmount: number;
  managerShare: number;
  fixedShare: number | null;
  percentShare: number | null;
  profit: number;
  managerPaid: number | null;
  managerCollected: number | null;
  paidSub?: string;
  collectedSub?: string;
  depositHolder: DepositHolder | null;
  depositAdjustment: number | null;
  extraCash: number | null;
}

export function calcLines(c: CalcInput, formatMoney: (n: number) => string): CalcLine[] {
  const pct = c.managerPercent.toLocaleString('vi-VN');
  const phanTramSub = c.profit > 0 ? `${pct}% × lợi nhuận ${formatMoney(c.profit)}` : 'lỗ hoặc hoà — không tính';
  const out: CalcLine[] = [];
  if (c.fixedShare !== null && c.fixedShare > 0) {
    out.push({ key: 'fixed', label: 'Phí quản lý cố định', sub: 'nhận đủ cả tháng lỗ', amount: c.fixedShare });
    if (c.managerPercent > 0 && c.percentShare !== null) {
      out.push({ key: 'percent', label: `+ Phần quản lý ${pct}% lợi nhuận`, sub: phanTramSub, amount: c.percentShare, muted: c.percentShare === 0 });
    }
  } else {
    const sub = c.fixedShare === null && c.managerFixedAmount > 0
      ? managerTermsLabel({ manager_percent: c.managerPercent, manager_fixed_amount: c.managerFixedAmount }, formatMoney)
      : c.managerPercent > 0 ? phanTramSub : null;
    out.push({ key: 'share', label: 'Phần quản lý', sub, amount: c.managerShare, muted: c.managerShare === 0 });
  }
  if (c.managerPaid !== null) {
    out.push({ key: 'paid', label: '+ Quản lý đã chi hộ', sub: c.paidSub ?? 'các khoản chi từ sổ quản lý', amount: c.managerPaid, muted: c.managerPaid === 0 });
  }
  if (c.managerCollected !== null) {
    out.push({
      key: 'collected', label: '− Quản lý đã thu hộ', sub: c.collectedSub ?? 'tiền khách trả vào sổ quản lý',
      amount: c.managerCollected, muted: c.managerCollected === 0,
    });
  }
  if (c.depositHolder !== null && c.depositAdjustment !== null) {
    const d = depositAdjustmentLine(c.depositHolder, c.depositAdjustment);
    out.push({ key: 'deposit', label: d.label, sub: d.sub, amount: d.amount, muted: d.amount === 0 });
  }
  if (c.extraCash !== null && c.extraCash !== 0) {
    out.push({ key: 'extra', label: extraCashLabel(c.extraCash), sub: 'làm tròn không tính', amount: Math.abs(c.extraCash) });
  }
  return out;
}

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

const termsText = (v: unknown, formatMoney: (n: number) => string): string => {
  if (!Array.isArray(v) || v.length === 0) return '—';
  return v.map((t) => {
    const r = (t ?? {}) as {
      valid_from?: unknown; manager_percent?: unknown; manager_fixed_amount?: unknown; landlord_account_ids?: unknown;
    };
    const from = typeof r.valid_from === 'string' ? monthShort(r.valid_from) : '?';
    const n = Array.isArray(r.landlord_account_ids) ? r.landlord_account_ids.length : 0;
    // ảnh trước 23/10/2026 không có tiền cố định (thoả thuận chỉ có %)
    const coDinh = Number(r.manager_fixed_amount ?? 0);
    const tien = Number.isFinite(coDinh) && coDinh > 0 ? ` + ${formatMoney(coDinh)}/tháng` : '';
    return `từ ${from}: ${String(r.manager_percent)}%${tien} · ${n} sổ chủ nhà`;
  }).join('; ');
};

const holderOf = (v: unknown): DepositHolder | null => (v === 'MANAGER' || v === 'LANDLORD' ? v : null);

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
  if (diff('terms')) {
    out.push(`Phần quản lý / sổ chủ nhà: ${termsText(before.terms, formatMoney)} → ${termsText(after.terms, formatMoney)}`);
  }
  // người giữ cọc là cài đặt của toà (ảnh trước v3 không có trường — không nói gì thay vì đoán)
  const giuCocTruoc = holderOf(before.deposit_holder);
  const giuCocSau = holderOf(after.deposit_holder);
  if (giuCocTruoc && giuCocSau && giuCocTruoc !== giuCocSau) {
    out.push(`Người giữ cọc: ${DEPOSIT_HOLDER_LABEL[giuCocTruoc]} → ${DEPOSIT_HOLDER_LABEL[giuCocSau]}`);
  }
  // ký hiệu sổ: dòng nhật ký trước 24/10/2026 không có hai trường (không nói gì); từ đó mọi ảnh đều có
  // (landlord_operation_state_v1 chụp cả dòng) — chỉ báo khi giá trị đổi
  if ('landlord_book_code' in after && (diff('landlord_book_code') || diff('manager_book_code'))) {
    const kh = (x: Record<string, unknown>) => {
      const c = bookCodesOf({
        landlord_book_code: typeof x.landlord_book_code === 'string' ? x.landlord_book_code : null,
        manager_book_code: typeof x.manager_book_code === 'string' ? x.manager_book_code : null,
      });
      return `${c.LANDLORD}/${c.MANAGER}`;
    };
    out.push(`Ký hiệu sổ (chủ nhà/quản lý): ${kh(before)} → ${kh(after)}`);
  }
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
