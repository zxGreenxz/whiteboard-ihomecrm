/**
 * Invoice Helper Functions
 *
 * Provides utilities for invoice management including:
 * - Auto-generate invoice numbers based on settings
 * - Create auto-notifications for invoice events
 * - Calculate invoice amounts with services and late fees
 */

import { supabase } from '@/integrations/supabase/client';
import { generateInvoiceNumber } from './codeGenerator';
import type { PreviousDebtSource } from '@/types/invoice';

/**
 * Generate invoice number if auto-generation is enabled
 *
 * @param userId - User ID
 * @returns Generated invoice number or null if disabled
 */
export async function autoGenerateInvoiceNumber(
  userId: string
): Promise<string | null> {
  // Fetch invoice config settings
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'invoice_config')
    .maybeSingle();

  if (!settings?.value) return null;

  const config = settings.value as any;

  // Check if auto-generation is enabled
  if (!config.auto_generate_invoice_number) return null;

  // Generate number using configured format
  const prefix = config.invoice_number_prefix || 'INV';
  const format = config.invoice_number_format || '{prefix}{year}{month}{seq:4}';

  try {
    const invoiceNumber = await generateInvoiceNumber(prefix, format, userId, 'YEARLY');
    return invoiceNumber;
  } catch (error) {
    console.error('Error generating invoice number:', error);
    return null;
  }
}

/**
 * Create notification for new invoice
 *
 * @param invoiceId - Invoice ID
 * @param userId - User ID
 * @param tenantName - Tenant name
 * @param invoiceNumber - Invoice number
 * @param amount - Invoice amount
 * @param dueDate - Due date
 */
export async function createInvoiceNotification(
  invoiceId: string,
  userId: string,
  tenantName: string,
  invoiceNumber: string,
  amount: number,
  dueDate: string
): Promise<void> {
  // Check notification settings
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'notification_config')
    .maybeSingle();

  // Default: send notifications
  if (settings?.value && (settings.value as any).send_payment_confirmation === false) {
    return; // Don't send if disabled
  }

  // Create notification
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'NEW_INVOICE',
    channel: 'IN_APP',
    subject: 'Hóa đơn mới',
    content: `Hóa đơn ${invoiceNumber} đã được tạo cho ${tenantName}. Số tiền: ${amount.toLocaleString('vi-VN')}đ. Hạn thanh toán: ${new Date(dueDate).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}.`,
    invoice_id: invoiceId,
    status: 'PENDING',
  });
}

/**
 * Create payment reminder notification
 *
 * @param invoiceId - Invoice ID
 * @param userId - User ID
 * @param tenantName - Tenant name
 * @param invoiceNumber - Invoice number
 * @param amount - Remaining amount
 * @param dueDate - Due date
 */
export async function createPaymentReminderNotification(
  invoiceId: string,
  userId: string,
  tenantName: string,
  invoiceNumber: string,
  amount: number,
  dueDate: string
): Promise<void> {
  // Create reminder notification
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'PAYMENT_REMINDER',
    channel: 'IN_APP',
    subject: 'Nhắc nhở thanh toán',
    content: `Hóa đơn ${invoiceNumber} sẽ đến hạn vào ${new Date(dueDate).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}. Vui lòng thanh toán ${amount.toLocaleString('vi-VN')}đ.`,
    invoice_id: invoiceId,
    status: 'PENDING',
  });
}

/**
 * Create overdue invoice notification
 *
 * @param invoiceId - Invoice ID
 * @param userId - User ID
 * @param tenantName - Tenant name
 * @param invoiceNumber - Invoice number
 * @param amount - Remaining amount
 */
export async function createOverdueNotification(
  invoiceId: string,
  userId: string,
  tenantName: string,
  invoiceNumber: string,
  amount: number
): Promise<void> {
  // Create overdue notification
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'OVERDUE_INVOICE',
    channel: 'IN_APP',
    subject: 'Hóa đơn quá hạn',
    content: `Hóa đơn ${invoiceNumber} đã quá hạn thanh toán. Vui lòng liên hệ với ${tenantName} để thu hồi nợ. Số tiền: ${amount.toLocaleString('vi-VN')}đ.`,
    invoice_id: invoiceId,
    status: 'PENDING',
  });
}

/**
 * Create payment confirmation notification
 *
 * @param invoiceId - Invoice ID
 * @param userId - User ID
 * @param tenantName - Tenant name
 * @param invoiceNumber - Invoice number
 * @param amountPaid - Amount paid
 */
export async function createPaymentConfirmationNotification(
  invoiceId: string,
  userId: string,
  tenantName: string,
  invoiceNumber: string,
  amountPaid: number
): Promise<void> {
  // Check notification settings
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'notification_config')
    .maybeSingle();

  if (settings?.value && (settings.value as any).send_payment_confirmation === false) {
    return; // Don't send if disabled
  }

  // Create payment confirmation
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'CUSTOM',
    channel: 'IN_APP',
    subject: 'Xác nhận thanh toán',
    content: `Đã nhận thanh toán ${amountPaid.toLocaleString('vi-VN')}đ cho hóa đơn ${invoiceNumber} của ${tenantName}.`,
    invoice_id: invoiceId,
    status: 'PENDING',
  });
}

/**
 * Calculate late payment fee based on settings
 *
 * @param userId - User ID
 * @param originalAmount - Original invoice amount
 * @param daysOverdue - Number of days overdue
 * @returns Late fee amount
 */
export async function calculateLateFee(
  userId: string,
  originalAmount: number,
  daysOverdue: number
): Promise<number> {
  if (daysOverdue <= 0) return 0;

  // Fetch invoice config
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'invoice_config')
    .maybeSingle();

  if (!settings?.value) return 0;

  const config = settings.value as any;

  if (config.late_payment_fee_type === 'NONE') {
    return 0;
  }

  if (config.late_payment_fee_type === 'PERCENTAGE') {
    // Percentage per day
    const dailyRate = config.late_payment_fee_value || 0;
    return (originalAmount * dailyRate / 100) * daysOverdue;
  }

  if (config.late_payment_fee_type === 'FIXED') {
    // Fixed amount per day
    const dailyFee = config.late_payment_fee_value || 0;
    return dailyFee * daysOverdue;
  }

  return 0;
}

/**
 * Ngưỡng làm tròn: residual nhỏ hơn ngưỡng này thì coi như đã đủ, không tính
 * vào nợ cũ. Khớp với chức năng "Làm tròn tiền thiếu" trong useBulkRecordPayment.
 */
export const PREVIOUS_DEBT_ROUND_THRESHOLD = 10000;

/**
 * Phân bổ một lần thu hoá đơn (gộp cọc) thành phần DOANH THU và phần CỌC.
 * Quy ước: PHÒNG-TRƯỚC, CỌC-SAU — mỗi đồng thu phủ phần tiền phòng/dịch vụ
 * còn thiếu của hoá đơn trước, phần dư mới tính vào cọc. Thu đủ hoá đơn thì
 * kết quả đúng bằng phân bổ theo hạng mục hoá đơn (doanh thu = tổng − cọc).
 *
 * Bất biến (property): với mọi chuỗi thanh toán cộng dồn không vượt tổng HĐ,
 *  Σ revenuePortion = min(Σ thu, revenueTotal); Σ depositPortion = phần còn lại
 *  (revenueTotal = collectibleTotal − depositInInvoice).
 *
 * @param paymentAmount  số tiền của LẦN thu hiện tại (≥ 0)
 * @param depositInInvoice  tổng phần cọc gộp trong hoá đơn (≥ 0)
 * @param paidBefore  số đã thu của hoá đơn TRƯỚC lần này (= invoices.paid_amount, ≥ 0)
 * @param collectibleTotal  tổng phải thu của hoá đơn (= invoices.total_amount, ĐÃ gồm
 *   nợ cũ — KHÔNG cộng previous_debt lần nữa)
 * @param depositRecordedBefore  phần cọc ĐÃ ghi thành phiếu thu is_deposit cho HĐ này
 *   TRƯỚC lần thu hiện tại (mặc định 0). Cần để KHÔNG ghi cọc ĐÔI khi hoá đơn từng
 *   thu theo quy ước CŨ (cọc-trước): khi đó paidBefore đã gồm phần cọc này, phải trừ
 *   ra để suy đúng "doanh thu đã phủ". Bỏ trống (=0) → hành vi y hệt bản cũ.
 */
export function allocateDepositPortion(opts: {
  paymentAmount: number;
  depositInInvoice: number;
  paidBefore: number;
  collectibleTotal: number;
  depositRecordedBefore?: number;
}): { depositPortion: number; revenuePortion: number } {
  const paymentAmount = Math.max(0, opts.paymentAmount || 0);
  const depositInInvoice = Math.max(0, opts.depositInInvoice || 0);
  const paidBefore = Math.max(0, opts.paidBefore || 0);
  const collectibleTotal = Math.max(0, opts.collectibleTotal || 0);
  const revenueTotal = Math.max(0, collectibleTotal - depositInInvoice);
  // Cọc đã ghi trước đó (clamp [0, depositInInvoice]). paidBefore trừ phần cọc
  // này mới là "đã phủ doanh thu" — nếu không trừ, hoá đơn từng thu cọc-trước sẽ
  // bị tính lại cọc lần nữa (ghi đôi cọc, hụt doanh thu KQKD).
  const depositRecordedBefore = Math.min(
    Math.max(0, opts.depositRecordedBefore || 0),
    depositInInvoice,
  );
  const revenueCoveredBefore = Math.min(
    Math.max(0, paidBefore - depositRecordedBefore),
    revenueTotal,
  );
  const revenueRemaining = revenueTotal - revenueCoveredBefore;
  const revenuePortion = Math.min(paymentAmount, revenueRemaining);
  const depositPortion = paymentAmount - revenuePortion;
  return { depositPortion, revenuePortion };
}

export interface PreviousDebtBreakdown {
  total: number;
  sources: PreviousDebtSource[];
}

export interface ComputePreviousDebtOptions {
  /** Khi edit HĐ hiện có, loại trừ chính HĐ đó khỏi nguồn nợ. */
  excludeInvoiceId?: string;
}

/**
 * Tính nợ cũ cho một hợp đồng = Remaining của các HĐ APPROVED/PARTIAL_PAID/
 * OVERDUE (loại bỏ residual < ngưỡng).
 *
 * LƯU Ý: KHÔNG còn gộp "cọc còn thiếu" vào nợ cũ (đường rò rỉ cũ → cọc lọt
 * vào KQKD khi thu hoá đơn). Cọc thiếu theo dõi ở contracts.deposit_remaining.
 *
 * Trả về breakdown để UI hiển thị tooltip + lưu vào invoices.previous_debt_sources.
 */
export async function computePreviousDebt(
  contractId: string,
  opts: ComputePreviousDebtOptions = {},
): Promise<PreviousDebtBreakdown> {
  if (!contractId) return { total: 0, sources: [] };

  const sources: PreviousDebtSource[] = [];

  // 1) HĐ cũ chưa tất toán — fetch kèm items/room/building/notes/previous_debt_sources
  // để build title khớp + tránh double-count.
  const { getInvoiceTitle } = await import('./invoiceUtils');
  let invoicesQuery = (supabase
    .from('invoices') as any)
    .select(`
      id, invoice_number, billing_month, total_amount, paid_amount, status, notes,
      previous_debt, previous_debt_sources,
      room:rooms!invoices_room_id_fkey (id, name),
      building:buildings!invoices_building_id_fkey (id, name),
      invoice_items (id, type, description)
    `)
    .eq('contract_id', contractId)
    .is('deleted_at', null)
    .in('status', ['APPROVED', 'PARTIAL_PAID', 'OVERDUE']);
  if (opts.excludeInvoiceId) {
    invoicesQuery = invoicesQuery.neq('id', opts.excludeInvoiceId);
  }
  const { data: oldInvoices } = await invoicesQuery;

  // Build set "đã được HĐ khác carry-over" để không cộng đúp:
  //  - carriedInvoiceIds: HĐ X xuất hiện trong previous_debt_sources của HĐ Y
  //    (mở) → HĐ X không tính riêng nữa.
  //  - Fallback: nếu HĐ Y có previous_debt > 0 nhưng previous_debt_sources rỗng
  //    (legacy hoặc user chỉnh tay) → coi tất cả HĐ cũ hơn Y (billing_month < Y)
  //    đã bị carry bởi Y, tránh double-count.
  const carriedInvoiceIds = new Set<string>();
  const allInvs = (oldInvoices ?? []) as any[];
  for (const inv of allInvs) {
    const srcs = Array.isArray(inv.previous_debt_sources) ? inv.previous_debt_sources : [];
    for (const s of srcs) {
      if (s?.type === 'invoice' && s?.id) carriedInvoiceIds.add(String(s.id));
    }
  }
  // Fallback dedup: HĐ có previous_debt > 0 nhưng sources rỗng → suy luận
  // tất cả HĐ cùng contract có billing_month nhỏ hơn đã được carry.
  for (const inv of allInvs) {
    const prevDebt = Number(inv.previous_debt) || 0;
    const srcs = Array.isArray(inv.previous_debt_sources) ? inv.previous_debt_sources : [];
    if (prevDebt > 0 && srcs.length === 0) {
      for (const older of allInvs) {
        if (older.id !== inv.id && (older.billing_month ?? '') < (inv.billing_month ?? '')) {
          carriedInvoiceIds.add(String(older.id));
        }
      }
    }
  }

  for (const inv of allInvs) {
    if (carriedInvoiceIds.has(String(inv.id))) continue;
    const remaining = (Number(inv.total_amount) || 0) - (Number(inv.paid_amount) || 0);
    if (remaining < PREVIOUS_DEBT_ROUND_THRESHOLD) continue;
    const label = getInvoiceTitle(inv);
    sources.push({
      type: 'invoice',
      id: inv.id,
      amount: remaining,
      label,
    });
  }

  // 2) Cọc còn thiếu — KHÔNG còn đẩy vào "Nợ cũ" của hoá đơn doanh thu.
  // (Đường rò rỉ cũ: cọc gộp vào hoá đơn → khi thu bị tính nhầm vào KQKD.)
  // Cọc thiếu nay theo dõi ở contracts.deposit_remaining + trang /deposits;
  // thu cọc bằng phiếu thu cọc riêng (hạng mục "Tiền cọc", is_deposit).

  const total = sources.reduce((sum, s) => sum + (s.amount || 0), 0);
  return { total, sources };
}

/**
 * Get previous debt for a contract (legacy wrapper)
 *
 * @param _userId - User ID (deprecated, kept for backward compat)
 * @param contractId - Contract ID
 * @returns Previous debt amount
 */
export async function getPreviousDebt(
  _userId: string,
  contractId: string
): Promise<number> {
  const { total } = await computePreviousDebt(contractId);
  return total;
}

// =============================================
// Contract Discount Slot — khuyến mãi tháng X/Y
// Tính slot còn lại cho HĐ kế tiếp dựa trên contracts.discounts + số HĐ đã có.
// =============================================

export interface ContractDiscountSlot {
  /** True nếu HĐ này còn được áp khuyến mãi (slotIndex <= totalMonths). */
  applicable: boolean;
  /** Slot thứ mấy (1-based) — VD slotIndex=2 nghĩa "tháng 2/Y". */
  slotIndex: number;
  totalMonths: number;
  amountPerMonth: number;
  /** Label ghi chú gợi ý, vd "Khuyến mãi HĐ — tháng 2/3 × 500.000đ". */
  label: string;
}

const EMPTY_DISCOUNT_SLOT: ContractDiscountSlot = {
  applicable: false,
  slotIndex: 0,
  totalMonths: 0,
  amountPerMonth: 0,
  label: '',
};

/**
 * Đếm slot khuyến mãi còn lại cho contract. Trả về slot KẾ TIẾP sẽ áp dụng
 * (đếm bao gồm HĐ vẫn còn hiệu lực: status ≠ CANCELLED, deleted_at IS NULL).
 *
 * - opts.excludeInvoiceId: khi edit HĐ hiện có, loại HĐ đó khỏi count để slot
 *   của chính nó được giữ nguyên.
 */
export async function getContractDiscountSlot(
  contractId: string,
  opts: { excludeInvoiceId?: string } = {},
): Promise<ContractDiscountSlot> {
  if (!contractId) return EMPTY_DISCOUNT_SLOT;

  const { data: contract } = await (supabase
    .from('contracts') as any)
    .select('id, discounts')
    .eq('id', contractId)
    .maybeSingle();

  const discounts = (contract as any)?.discounts;
  const months = Number(discounts?.months) || 0;
  const amount = Number(discounts?.amount_per_month) || 0;
  if (months <= 0 || amount <= 0) return EMPTY_DISCOUNT_SLOT;

  // Đếm HĐ đã có cho contract (loại CANCELLED + soft-deleted).
  let countQuery = (supabase
    .from('invoices') as any)
    .select('id', { count: 'exact', head: true })
    .eq('contract_id', contractId)
    .is('deleted_at', null)
    .neq('status', 'CANCELLED');
  if (opts.excludeInvoiceId) {
    countQuery = countQuery.neq('id', opts.excludeInvoiceId);
  }
  const { count } = await countQuery;
  const usedSlots = Number(count) || 0;
  const slotIndex = usedSlots + 1;
  const applicable = slotIndex <= months;

  return {
    applicable,
    slotIndex,
    totalMonths: months,
    amountPerMonth: amount,
    label: applicable
      ? `Khuyến mãi HĐ — tháng ${slotIndex}/${months} × ${amount.toLocaleString('vi-VN')}đ`
      : '',
  };
}

// =============================================
// AUTO INVOICE GENERATION
// =============================================

import { format, startOfMonth, endOfMonth } from 'date-fns';

// Năm cột này NULLABLE trong DB (`invoice_generation_settings`, xem
// integrations/supabase/types.ts) — không cột nào có NOT NULL hay DEFAULT ở
// schema. Kiểu viết tay trước đây hẹp hơn DB nên nói dối chỗ gọi: hàng có cột
// NULL vẫn được trả về như thể luôn có giá trị. Nới kiểu cho khớp DB thay vì
// bịa giá trị mặc định tại chỗ đọc — nhánh "không có hàng" bên dưới vẫn trả bộ
// mặc định đầy đủ như cũ, nên hành vi không đổi.
export interface InvoiceGenerationSettings {
  auto_generate_enabled: boolean | null;
  generation_day: number | null; // 1-28
  due_days: number | null;
  include_previous_debt: boolean | null;
  auto_approve: boolean | null;
}

export interface GeneratedInvoiceItem {
  item_type: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

export interface ContractForInvoice {
  id: string;
  contract_number: string;
  tenant_id: string;
  room_id: string | null;
  rent_price: number;
  start_date: string;
  end_date: string;
  start_billing_date: string | null;
  tenant?: {
    id: string;
    full_name: string;
    phone: string;
  };
  room?: {
    id: string;
    name: string;
    building_id: string;
    building?: {
      id: string;
      name: string;
    };
  };
  contract_services?: Array<{
    service_id: string;
    unit_price: number;
    initial_reading: number | null;
    service?: {
      id: string;
      name: string;
      type: string;
      unit: string;
    };
  }>;
}

/**
 * Get invoice generation settings for user
 */
export async function getInvoiceSettings(userId: string): Promise<InvoiceGenerationSettings | null> {
  const { data, error } = await supabase
    .from('invoice_generation_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) {
    // Return default settings
    return {
      auto_generate_enabled: false,
      generation_day: 1,
      due_days: 5,
      include_previous_debt: true,
      auto_approve: false,
    };
  }

  return {
    auto_generate_enabled: data.auto_generate_enabled,
    generation_day: data.generation_day,
    due_days: data.due_days,
    include_previous_debt: data.include_previous_debt,
    auto_approve: data.auto_approve,
  };
}

/**
 * Save invoice generation settings
 */
export async function saveInvoiceSettings(
  userId: string,
  settings: Partial<InvoiceGenerationSettings>
): Promise<void> {
  const { error } = await supabase
    .from('invoice_generation_settings')
    .upsert({
      user_id: userId,
      ...settings,
      updated_at: new Date().toISOString(),
    });

  if (error) throw error;
}

// ĐÃ XOÁ 11/08/2026 — đường sinh hoá đơn PHÍA CLIENT.
//
// Năm hàm `getActiveContractsForInvoicing` · `getMeterReadingsForPeriod` ·
// `generateInvoiceItems` · `generateInvoiceForContract` · `bulkGenerateInvoices`
// nằm ở đây và KHÔNG file nào import. Chúng cũng không thể chạy được:
//   - insert vào `invoices` với `billing_period_from` / `billing_period_to` /
//     `issued_date` — ba cột KHÔNG TỒN TẠI trong schema;
//   - bỏ trống `billing_month` và `organization_id` — hai cột NOT NULL;
//   - insert vào `invoice_items` với `item_type`, trong khi cột tên `type` và
//     là enum bắt buộc;
//   - đọc `meter_readings.service_type`, cột cũng không tồn tại.
// Tức mọi lượt gọi chết ngay ở PGRST204, không phải sai lệch một trường.
//
// Hoá đơn thật sự được sinh PHÍA SERVER bằng SQL (`generate_invoices_for_building`
// và các RPC trong supabase/migrations); `src/` không có một câu insert nào vào
// bảng `invoices`.
//
// Nó nằm im được lâu vì `ts-baseline.json` miễn trừ file này. supabase-js
// 2.112 thêm `RejectExcessProperties` nên tên cột sai thành lỗi biên dịch —
// đó là thứ phơi khối mã này ra.


// NOTE (cũ, đã sai): "autoCreateInvoiceForContract đã hợp nhất vào contractHelpers.ts".
// File đó không còn tồn tại — xem khối giải thích phía trên.

