/**
 * Notification Scheduler
 *
 * Functions to check and create scheduled notifications:
 * - Contract expiry reminders (30/15/7 days before)
 * - Invoice payment reminders (X days before due)
 * - Overdue invoice reminders
 *
 * NOTE: These functions should be called periodically (e.g., daily cron job)
 * For now, they can be called manually or on app load
 */

import { supabase } from '@/integrations/supabase/client';
import { differenceInDays, format } from 'date-fns';
import { createPaymentReminderNotification, createOverdueNotification } from './invoiceHelpers';

/**
 * Check and create contract expiry reminders
 * Should be called daily
 *
 * @param userId - User ID
 */
export async function checkContractExpiryReminders(userId: string): Promise<void> {
  // Get notification settings
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'notification_config')
    .maybeSingle();

  const reminderDays = settings?.value
    ? ((settings.value as any).contract_expiry_reminder_days || [30, 15, 7])
    : [30, 15, 7];

  // Get active contracts
  const { data: contracts } = await supabase
    .from('contracts')
    .select(`
      id,
      contract_number,
      end_date,
      tenant:tenants(full_name),
      room:rooms(name)
    `)
    .eq('user_id', userId)
    .in('status', ['ACTIVE', 'EXTENDED']);

  if (!contracts) return;

  const today = new Date();

  for (const contract of contracts) {
    const endDate = new Date(contract.end_date);
    const daysUntilExpiry = differenceInDays(endDate, today);

    // Check if we should send reminder
    if (reminderDays.includes(daysUntilExpiry)) {
      // Check if notification already sent for this date
      const { data: existing } = await supabase
        .from('notifications')
        .select('id')
        .eq('contract_id', contract.id)
        .eq('type', 'CONTRACT_EXPIRING')
        .gte('created_at', format(today, 'yyyy-MM-dd'))
        .maybeSingle();

      if (existing) continue; // Already sent today

      // Create notification
      await supabase.from('notifications').insert({
        user_id: userId,
        type: 'CONTRACT_EXPIRING',
        channel: 'IN_APP',
        subject: 'Hợp đồng sắp hết hạn',
        content: `Hợp đồng ${contract.contract_number} của ${contract.tenant?.full_name} (căn hộ ${contract.room?.name}) sẽ hết hạn trong ${daysUntilExpiry} ngày. Vui lòng liên hệ để gia hạn.`,
        contract_id: contract.id,
        status: 'PENDING',
      });
    }
  }
}

/**
 * Check and create invoice payment reminders
 * Should be called daily
 *
 * @param userId - User ID
 */
export async function checkInvoicePaymentReminders(userId: string): Promise<void> {
  // Get notification settings
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'notification_config')
    .maybeSingle();

  const reminderDays = settings?.value
    ? ((settings.value as any).invoice_reminder_days || [7, 3, 1])
    : [7, 3, 1];

  // Get unpaid/partial paid invoices
  const { data: invoices } = await supabase
    .from('invoices')
    .select(`
      id,
      invoice_number,
      due_date,
      total_amount,
      paid_amount,
      contract:contracts(tenant:tenants(full_name))
    `)
    .eq('user_id', userId)
    .in('status', ['APPROVED', 'PARTIAL_PAID']);

  if (!invoices) return;

  const today = new Date();

  for (const invoice of invoices) {
    const dueDate = new Date(invoice.due_date);
    const daysUntilDue = differenceInDays(dueDate, today);
    const remainingAmount = ((invoice as any).total_amount || 0) - ((invoice as any).paid_amount || 0);

    // Check if we should send reminder
    if (daysUntilDue > 0 && reminderDays.includes(daysUntilDue)) {
      // Check if notification already sent for this date
      const { data: existing } = await supabase
        .from('notifications')
        .select('id')
        .eq('invoice_id', invoice.id)
        .eq('type', 'PAYMENT_REMINDER')
        .gte('created_at', format(today, 'yyyy-MM-dd'))
        .maybeSingle();

      if (existing) continue; // Already sent today

      // Create reminder
      await createPaymentReminderNotification(
        invoice.id,
        userId,
        (invoice as any).contract?.tenant?.full_name || '',
        invoice.invoice_number || '',
        remainingAmount,
        invoice.due_date
      );
    }
  }
}

/**
 * Check and create overdue invoice notifications
 * Should be called daily
 *
 * @param userId - User ID
 */
export async function checkOverdueInvoices(userId: string): Promise<void> {
  // Get notification settings
  const { data: settings } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'notification_config')
    .maybeSingle();

  const frequency = settings?.value
    ? ((settings.value as any).overdue_reminder_frequency || 'WEEKLY')
    : 'WEEKLY';

  if (frequency === 'NONE') return;

  // Get overdue invoices
  const { data: invoices } = await supabase
    .from('invoices')
    .select(`
      id,
      invoice_number,
      due_date,
      total_amount,
      paid_amount,
      contract:contracts(tenant:tenants(full_name))
    `)
    .eq('user_id', userId)
    .in('status', ['APPROVED', 'PARTIAL_PAID'])
    .lt('due_date', new Date().toISOString());

  if (!invoices) return;

  const today = new Date();

  for (const invoice of invoices) {
    const remainingAmount = ((invoice as any).total_amount || 0) - ((invoice as any).paid_amount || 0);

    // Check last notification
    const { data: lastNotification } = await supabase
      .from('notifications')
      .select('created_at')
      .eq('invoice_id', invoice.id)
      .eq('type', 'OVERDUE_INVOICE')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Determine if we should send based on frequency
    let shouldSend = false;

    if (!lastNotification) {
      shouldSend = true; // Never sent
    } else {
      const lastSent = new Date(lastNotification.created_at);
      const daysSinceLastSent = differenceInDays(today, lastSent);

      if (frequency === 'DAILY' && daysSinceLastSent >= 1) {
        shouldSend = true;
      } else if (frequency === 'WEEKLY' && daysSinceLastSent >= 7) {
        shouldSend = true;
      }
    }

    if (shouldSend) {
      await createOverdueNotification(
        invoice.id,
        userId,
        (invoice as any).contract?.tenant?.full_name || '',
        invoice.invoice_number || '',
        remainingAmount
      );
    }
  }
}

/**
 * Run all scheduled notification checks
 * Call this function daily (e.g., via cron job or on app startup)
 *
 * @param userId - User ID
 */
export async function runScheduledNotifications(userId: string): Promise<void> {
  try {
    await Promise.all([
      checkContractExpiryReminders(userId),
      checkInvoicePaymentReminders(userId),
      checkOverdueInvoices(userId),
    ]);
  } catch (error) {
    console.error('Error running scheduled notifications:', error);
  }
}
