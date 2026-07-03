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
 * Đọc cấu hình thông báo của user. Tách riêng để runScheduledNotifications nạp
 * MỘT lần rồi truyền xuống — trước đây 3 hàm con mỗi hàm tự query
 * notification_config gây 3 request trùng mỗi lần mở app.
 */
async function fetchNotificationConfig(userId: string): Promise<any | null> {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'notification_config')
    .maybeSingle();
  return (data?.value as any) ?? null;
}

/**
 * Check and create contract expiry reminders
 * Should be called daily
 *
 * @param userId - User ID
 */
export async function checkContractExpiryReminders(userId: string, config?: any): Promise<void> {
  // Dùng config đã nạp sẵn nếu có; nếu gọi lẻ thì tự nạp (giữ tương thích).
  const cfg = config ?? (await fetchNotificationConfig(userId));
  const reminderDays = cfg?.contract_expiry_reminder_days || [30, 15, 7];

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
    .in('status', ['ACTIVE']);

  if (!contracts) return;

  const today = new Date();

  // Lọc HĐ tới mốc nhắc TRƯỚC, rồi kiểm tra "đã gửi hôm nay" bằng 1 query IN
  // (bản cũ N+1: mỗi HĐ 1 query notifications).
  const due = contracts.filter((c) =>
    reminderDays.includes(differenceInDays(new Date(c.end_date), today)),
  );
  if (due.length === 0) return;

  const { data: sentToday } = await supabase
    .from('notifications')
    .select('contract_id')
    .in('contract_id', due.map((c) => c.id))
    .eq('type', 'CONTRACT_EXPIRING')
    .gte('created_at', format(today, 'yyyy-MM-dd'));
  const sentSet = new Set((sentToday ?? []).map((n: any) => n.contract_id));

  for (const contract of due) {
    if (sentSet.has(contract.id)) continue; // Already sent today

    const daysUntilExpiry = differenceInDays(new Date(contract.end_date), today);
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

/**
 * Check and create invoice payment reminders
 * Should be called daily
 *
 * @param userId - User ID
 */
export async function checkInvoicePaymentReminders(userId: string, config?: any): Promise<void> {
  const cfg = config ?? (await fetchNotificationConfig(userId));
  const reminderDays = cfg?.invoice_reminder_days || [7, 3, 1];

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

  // Lọc hoá đơn tới mốc nhắc TRƯỚC, rồi kiểm "đã gửi hôm nay" bằng 1 query IN
  // (bản cũ N+1: mỗi hoá đơn 1 query notifications).
  const due = invoices.filter((inv) => {
    const daysUntilDue = differenceInDays(new Date(inv.due_date), today);
    return daysUntilDue > 0 && reminderDays.includes(daysUntilDue);
  });
  if (due.length === 0) return;

  const { data: sentToday } = await supabase
    .from('notifications')
    .select('invoice_id')
    .in('invoice_id', due.map((inv) => inv.id))
    .eq('type', 'PAYMENT_REMINDER')
    .gte('created_at', format(today, 'yyyy-MM-dd'));
  const sentSet = new Set((sentToday ?? []).map((n: any) => n.invoice_id));

  for (const invoice of due) {
    if (sentSet.has(invoice.id)) continue; // Already sent today

    const remainingAmount = ((invoice as any).total_amount || 0) - ((invoice as any).paid_amount || 0);
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

/**
 * Check and create overdue invoice notifications
 * Should be called daily
 *
 * @param userId - User ID
 */
export async function checkOverdueInvoices(userId: string, config?: any): Promise<void> {
  const cfg = config ?? (await fetchNotificationConfig(userId));
  const frequency = cfg?.overdue_reminder_frequency || 'WEEKLY';

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

  if (!invoices || invoices.length === 0) return;

  const today = new Date();

  // Nạp lần-gửi-cuối của TẤT CẢ hoá đơn quá hạn trong 1 query (trước đây N+1:
  // mỗi hoá đơn 1 query notifications). Sắp xếp desc → bản đầu cho mỗi invoice_id
  // là mới nhất.
  const invoiceIds = invoices.map((inv) => inv.id);
  const { data: lastNotifs } = await supabase
    .from('notifications')
    .select('invoice_id, created_at')
    .in('invoice_id', invoiceIds)
    .eq('type', 'OVERDUE_INVOICE')
    .order('created_at', { ascending: false });
  const lastByInvoice = new Map<string, string>();
  for (const n of (lastNotifs ?? []) as Array<{ invoice_id: string; created_at: string }>) {
    if (!lastByInvoice.has(n.invoice_id)) lastByInvoice.set(n.invoice_id, n.created_at);
  }

  for (const invoice of invoices) {
    const remainingAmount = ((invoice as any).total_amount || 0) - ((invoice as any).paid_amount || 0);

    const lastSentAt = lastByInvoice.get(invoice.id);

    // Determine if we should send based on frequency
    let shouldSend = false;

    if (!lastSentAt) {
      shouldSend = true; // Never sent
    } else {
      const lastSent = new Date(lastSentAt);
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
 * Check and create deposit shortfall reminders.
 * Should be called daily.
 *
 * HĐ đang hiệu lực còn thiếu cọc (deposit_remaining >= ngưỡng) và KHÔNG ở chế độ
 * "đóng đủ trong hoá đơn" (FIRST_INVOICE — khoản đó thu qua hoá đơn, đã có nhắc
 * hoá đơn quá hạn riêng). Nhắc lại tối đa 1 lần/tuần cho mỗi HĐ; nếu quá hẹn
 * bổ sung (deposit_topup_due_date) thì nhắc dày hơn (mỗi ngày).
 *
 * @param userId - User ID
 */
export async function checkDepositTopupReminders(userId: string): Promise<void> {
  const SHORTFALL_THRESHOLD = 10000;

  const { data: contracts } = await (supabase as any)
    .from('contracts')
    .select(`
      id,
      contract_number,
      deposit_remaining,
      deposit_topup_due_date,
      contract_customers!contract_customers_contract_id_fkey(
        is_representative,
        customer:customers!contract_customers_customer_id_fkey(full_name)
      )
    `)
    .eq('user_id', userId)
    .in('status', ['ACTIVE'])
    .is('deleted_at', null)
    .gte('deposit_remaining', SHORTFALL_THRESHOLD)
    .or('deposit_debt_mode.is.null,deposit_debt_mode.eq.DEBT');

  if (!contracts) return;

  const today = new Date();

  // Nạp lần-gửi-cuối của TẤT CẢ HĐ thiếu cọc trong 1 query (bản cũ N+1:
  // mỗi HĐ 1 query notifications) — cùng khuôn checkOverdueInvoices.
  const { data: lastNotifs } = await supabase
    .from('notifications')
    .select('contract_id, created_at')
    .in('contract_id', (contracts as any[]).map((c) => c.id))
    .eq('type', 'DEPOSIT_SHORTFALL')
    .order('created_at', { ascending: false });
  const lastByContract = new Map<string, string>();
  for (const n of (lastNotifs ?? []) as Array<{ contract_id: string; created_at: string }>) {
    if (!lastByContract.has(n.contract_id)) lastByContract.set(n.contract_id, n.created_at);
  }

  for (const contract of contracts as any[]) {
    const remaining = Number(contract.deposit_remaining) || 0;
    if (remaining < SHORTFALL_THRESHOLD) continue;

    const dueIso: string | null = contract.deposit_topup_due_date ?? null;
    const overdue = dueIso ? new Date(dueIso) < today : false;

    // Throttle: quá hẹn → nhắc tối đa 1 lần/ngày; chưa tới hẹn → 1 lần/tuần.
    const minGapDays = overdue ? 1 : 7;
    const lastSentAt = lastByContract.get(contract.id);
    if (lastSentAt) {
      const daysSince = differenceInDays(today, new Date(lastSentAt));
      if (daysSince < minGapDays) continue;
    }

    const rep = (contract.contract_customers ?? []).find(
      (cc: any) => cc.is_representative,
    );
    const customerName =
      rep?.customer?.full_name ||
      (contract.contract_customers ?? [])[0]?.customer?.full_name ||
      'Khách hàng';

    const dueText = dueIso
      ? ` (hẹn bổ sung ${format(new Date(dueIso), 'dd/MM/yyyy')})`
      : '';
    const subject = overdue ? 'Quá hẹn bổ sung cọc' : 'Hợp đồng thiếu cọc';

    await supabase.from('notifications').insert({
      user_id: userId,
      type: 'DEPOSIT_SHORTFALL',
      channel: 'IN_APP',
      subject,
      content: `Hợp đồng ${contract.contract_number || ''} của ${customerName} còn thiếu ${remaining.toLocaleString('vi-VN')}đ tiền cọc${dueText}. Vui lòng thu đủ cọc.`,
      contract_id: contract.id,
      status: 'PENDING',
    });
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
    // Nạp notification_config MỘT lần rồi truyền xuống (bỏ 3 query trùng).
    const config = await fetchNotificationConfig(userId);
    await Promise.all([
      checkContractExpiryReminders(userId, config),
      checkInvoicePaymentReminders(userId, config),
      checkOverdueInvoices(userId, config),
      checkDepositTopupReminders(userId),
    ]);
  } catch (error) {
    console.error('Error running scheduled notifications:', error);
  }
}
