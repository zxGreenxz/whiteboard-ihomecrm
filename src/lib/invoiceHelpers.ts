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

export interface PreviousDebtBreakdown {
  total: number;
  sources: PreviousDebtSource[];
}

export interface ComputePreviousDebtOptions {
  /** Khi edit HĐ hiện có, loại trừ chính HĐ đó khỏi nguồn nợ. */
  excludeInvoiceId?: string;
}

/**
 * Tính nợ cũ cho một hợp đồng — gồm:
 *  1. Remaining của các HĐ APPROVED/PARTIAL_PAID/OVERDUE (loại bỏ residual < ngưỡng).
 *  2. Cọc còn thiếu = contracts.total_deposit - contracts.deposit_paid (nếu > ngưỡng).
 *
 * Trả về breakdown để UI hiển thị tooltip + lưu vào invoices.previous_debt_sources.
 */
export async function computePreviousDebt(
  contractId: string,
  opts: ComputePreviousDebtOptions = {},
): Promise<PreviousDebtBreakdown> {
  if (!contractId) return { total: 0, sources: [] };

  const sources: PreviousDebtSource[] = [];

  // 1) HĐ cũ chưa tất toán — fetch kèm items/room/building/notes để build title
  // khớp với cột "Hoá đơn" trên bảng danh sách.
  const { getInvoiceTitle } = await import('./invoiceUtils');
  let invoicesQuery = (supabase
    .from('invoices') as any)
    .select(`
      id, invoice_number, billing_month, total_amount, paid_amount, status, notes,
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

  for (const inv of (oldInvoices ?? []) as any[]) {
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

  // 2) Cọc còn thiếu
  const { data: contract } = await (supabase
    .from('contracts') as any)
    .select('id, total_deposit, deposit_paid, deposit_remaining')
    .eq('id', contractId)
    .maybeSingle();
  if (contract) {
    const depositRemaining =
      Number(contract.deposit_remaining ??
        ((Number(contract.total_deposit) || 0) - (Number(contract.deposit_paid) || 0)));
    if (depositRemaining >= PREVIOUS_DEBT_ROUND_THRESHOLD) {
      sources.push({
        type: 'deposit',
        contract_id: contract.id,
        amount: depositRemaining,
        label: 'Cọc còn thiếu',
      });
    }
  }

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
// AUTO INVOICE GENERATION
// =============================================

import { format, startOfMonth, endOfMonth } from 'date-fns';

export interface InvoiceGenerationSettings {
  auto_generate_enabled: boolean;
  generation_day: number; // 1-28
  due_days: number;
  include_previous_debt: boolean;
  auto_approve: boolean;
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
  bed_id: string | null;
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

/**
 * Get active contracts for invoice generation
 */
export async function getActiveContractsForInvoicing(
  userId: string,
  buildingId?: string
): Promise<ContractForInvoice[]> {
  let query = supabase
    .from('contracts')
    .select(`
      *,
      tenant:tenants!contracts_tenant_id_fkey (
        id, full_name, phone
      ),
      room:rooms!contracts_room_id_fkey (
        id, name, building_id,
        building:buildings!rooms_building_id_fkey (
          id, name
        )
      ),
      contract_services (
        service_id, unit_price, initial_reading,
        service:services!contract_services_service_id_fkey (
          id, name, type, unit
        )
      )
    `)
    .eq('user_id', userId)
    .eq('status', 'ACTIVE')
    .is('deleted_at', null);

  const { data, error } = await query;

  if (error) throw error;
  return (data || []) as ContractForInvoice[];
}

/**
 * Get meter readings for a contract in a specific period
 */
export async function getMeterReadingsForPeriod(
  contractId: string,
  periodFrom: Date,
  periodTo: Date
): Promise<Array<{
  service_type: string;
  previous_reading: number;
  current_reading: number;
  consumption: number;
}>> {
  const { data, error } = await supabase
    .from('meter_readings')
    .select('*')
    .eq('contract_id', contractId)
    .gte('reading_date', format(periodFrom, 'yyyy-MM-dd'))
    .lte('reading_date', format(periodTo, 'yyyy-MM-dd'));

  if (error) return [];

  return (data || []).map(reading => ({
    service_type: reading.service_type || '',
    previous_reading: reading.previous_reading || 0,
    current_reading: reading.current_reading,
    consumption: reading.consumption || 0,
  }));
}

/**
 * Generate invoice items for a contract
 */
export function generateInvoiceItems(
  contract: ContractForInvoice,
  meterReadings: Array<{
    service_type: string;
    consumption: number;
  }>,
  periodFrom: Date,
  periodTo: Date
): GeneratedInvoiceItem[] {
  const items: GeneratedInvoiceItem[] = [];

  // Add rent
  items.push({
    item_type: 'RENT',
    description: `Tiền thuê căn hộ tháng ${format(periodFrom, 'MM/yyyy')}`,
    quantity: 1,
    unit_price: contract.rent_price,
    amount: contract.rent_price,
  });

  // Add services
  if (contract.contract_services) {
    for (const cs of contract.contract_services) {
      if (!cs.service) continue;

      if (cs.service.type === 'METER_READING') {
        // Find meter reading for this service
        const reading = meterReadings.find(r =>
          r.service_type.toLowerCase().includes(cs.service!.name.toLowerCase().includes('điện') ? 'electricity' : 'water')
        );

        if (reading && reading.consumption > 0) {
          items.push({
            item_type: cs.service.name.toUpperCase().includes('ĐIỆN') ? 'ELECTRICITY' : 'WATER',
            description: `${cs.service.name}: ${reading.consumption} ${cs.service.unit}`,
            quantity: reading.consumption,
            unit_price: cs.unit_price,
            amount: reading.consumption * cs.unit_price,
          });
        }
      } else if (cs.service.type === 'FIXED') {
        items.push({
          item_type: cs.service.name.toUpperCase().replace(/\s+/g, '_'),
          description: cs.service.name,
          quantity: 1,
          unit_price: cs.unit_price,
          amount: cs.unit_price,
        });
      }
    }
  }

  return items;
}

/**
 * Generate a single invoice for a contract
 */
export async function generateInvoiceForContract(
  userId: string,
  contract: ContractForInvoice,
  billingPeriod: { from: Date; to: Date },
  settings: InvoiceGenerationSettings
): Promise<string> {
  // Get meter readings
  const meterReadings = await getMeterReadingsForPeriod(
    contract.id,
    billingPeriod.from,
    billingPeriod.to
  );

  // Generate invoice items
  const items = generateInvoiceItems(
    contract,
    meterReadings,
    billingPeriod.from,
    billingPeriod.to
  );

  // Calculate subtotal
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);

  // Nợ cũ (luôn tính, bỏ qua source < ngưỡng làm tròn)
  const { total: previousDebtAmount, sources: previousDebtSources } =
    await computePreviousDebt(contract.id);

  // Calculate total
  const totalAmount = subtotal + previousDebtAmount;

  // Generate invoice number using proper sequential generation
  let invoiceNumber = await autoGenerateInvoiceNumber(userId);

  // Fallback to default format if auto-generation is disabled or fails
  if (!invoiceNumber) {
    const seq = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    const count = (seq.count || 0) + 1;
    invoiceNumber = `INV${format(new Date(), 'yyyyMM')}${String(count).padStart(4, '0')}`;
  }

  // Calculate due date
  const issuedDate = new Date();
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + settings.due_days);

  // Create invoice
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      invoice_number: invoiceNumber,
      contract_id: contract.id,
      room_id: contract.room_id,
      building_id: contract.room?.building_id,
      billing_period_from: format(billingPeriod.from, 'yyyy-MM-dd'),
      billing_period_to: format(billingPeriod.to, 'yyyy-MM-dd'),
      subtotal,
      previous_debt: previousDebtAmount,
      previous_debt_sources: previousDebtSources as any,
      discount_amount: 0,
      tax_rate: 0,
      tax_amount: 0,
      total_amount: totalAmount,
      paid_amount: 0,
      status: settings.auto_approve ? 'APPROVED' : 'DRAFT',
      issued_date: format(issuedDate, 'yyyy-MM-dd'),
      due_date: format(dueDate, 'yyyy-MM-dd'),
    })
    .select()
    .single();

  if (invoiceError) throw invoiceError;

  // Create invoice items
  const invoiceItems = items.map(item => ({
    invoice_id: invoice.id,
    ...item,
  }));

  const { error: itemsError } = await supabase
    .from('invoice_items')
    .insert(invoiceItems);

  if (itemsError) throw itemsError;

  return invoice.id;
}

/**
 * Bulk generate invoices for all active contracts
 */
export async function bulkGenerateInvoices(
  userId: string,
  billingMonth: Date,
  buildingId?: string
): Promise<{ success: number; failed: number; errors: string[] }> {
  const settings = await getInvoiceSettings(userId);
  if (!settings) {
    throw new Error('Vui lòng cấu hình cài đặt tạo hóa đơn trước');
  }

  const contracts = await getActiveContractsForInvoicing(userId, buildingId);

  const billingPeriod = {
    from: startOfMonth(billingMonth),
    to: endOfMonth(billingMonth),
  };

  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const contract of contracts) {
    try {
      await generateInvoiceForContract(userId, contract, billingPeriod, settings);
      success++;
    } catch (error: any) {
      failed++;
      errors.push(`${contract.contract_number}: ${error.message}`);
    }
  }

  return { success, failed, errors };
}

// NOTE: autoCreateInvoiceForContract has been consolidated into contractHelpers.ts
// to avoid duplication. Use the version from contractHelpers.ts instead.

