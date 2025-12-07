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
    content: `Hóa đơn ${invoiceNumber} đã được tạo cho ${tenantName}. Số tiền: ${amount.toLocaleString('vi-VN')}đ. Hạn thanh toán: ${new Date(dueDate).toLocaleDateString('vi-VN')}.`,
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
    content: `Hóa đơn ${invoiceNumber} sẽ đến hạn vào ${new Date(dueDate).toLocaleDateString('vi-VN')}. Vui lòng thanh toán ${amount.toLocaleString('vi-VN')}đ.`,
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
 * Get previous debt for a contract (if enabled in settings)
 *
 * @param userId - User ID
 * @param contractId - Contract ID
 * @returns Previous debt amount
 */
export async function getPreviousDebt(
  userId: string,
  contractId: string
): Promise<number> {
  // Check if including previous debt is enabled
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'invoice_config')
    .maybeSingle();

  if (!settings?.value) return 0;

  const config = settings.value as any;

  if (!config.include_previous_debt) return 0;

  // Get all unpaid/partial paid invoices for this contract
  // Note: invoice_status enum has: DRAFT, PENDING_APPROVAL, APPROVED, PAID, PARTIAL_PAID, OVERDUE, CANCELLED
  const { data: invoices } = await supabase
    .from('invoices')
    .select('total_amount, paid_amount')
    .eq('contract_id', contractId)
    .in('status', ['PARTIAL_PAID', 'OVERDUE', 'APPROVED', 'PENDING_APPROVAL']);

  if (!invoices || invoices.length === 0) return 0;

  // Calculate total debt
  const totalDebt = invoices.reduce((sum, invoice) => {
    return sum + ((invoice.total_amount || 0) - (invoice.paid_amount || 0));
  }, 0);

  return totalDebt;
}
