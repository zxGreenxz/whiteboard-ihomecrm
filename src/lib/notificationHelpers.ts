import { supabase } from './supabase';
import type { NotificationType } from '@/hooks/useNotifications';

// =============================================
// NOTIFICATION HELPER FUNCTIONS
// =============================================

/**
 * Create a notification for a specific user
 */
export const createNotification = async ({
  userId,
  type,
  content,
  subject,
  invoiceId,
  contractId,
  issueId,
}: {
  userId: string;
  type: NotificationType;
  content: string;
  subject?: string;
  invoiceId?: string;
  contractId?: string;
  issueId?: string;
}) => {
  const { data, error } = await supabase
    .from('notifications')
    .insert({
      user_id: userId,
      type,
      channel: 'IN_APP',
      content,
      subject,
      invoice_id: invoiceId,
      contract_id: contractId,
      issue_id: issueId,
      status: 'PENDING',
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating notification:', error);
    throw error;
  }

  return data;
};

/**
 * Send notification when a new invoice is created
 */
export const notifyNewInvoice = async (
  userId: string,
  invoiceId: string,
  invoiceNumber: string,
  amount: number
) => {
  return createNotification({
    userId,
    type: 'NEW_INVOICE',
    subject: 'Hóa đơn mới',
    content: `Bạn có hóa đơn mới ${invoiceNumber} với số tiền ${amount.toLocaleString('vi-VN')} VND`,
    invoiceId,
  });
};

/**
 * Send payment reminder notification
 */
export const notifyPaymentReminder = async (
  userId: string,
  invoiceId: string,
  invoiceNumber: string,
  dueDate: string,
  amount: number
) => {
  return createNotification({
    userId,
    type: 'PAYMENT_REMINDER',
    subject: 'Nhắc nhở thanh toán',
    content: `Hóa đơn ${invoiceNumber} sẽ đến hạn thanh toán vào ${dueDate}. Số tiền: ${amount.toLocaleString('vi-VN')} VND`,
    invoiceId,
  });
};

/**
 * Send overdue invoice notification
 */
export const notifyOverdueInvoice = async (
  userId: string,
  invoiceId: string,
  invoiceNumber: string,
  daysOverdue: number,
  amount: number
) => {
  return createNotification({
    userId,
    type: 'OVERDUE_INVOICE',
    subject: 'Hóa đơn quá hạn',
    content: `Hóa đơn ${invoiceNumber} đã quá hạn ${daysOverdue} ngày. Vui lòng thanh toán số tiền ${amount.toLocaleString('vi-VN')} VND`,
    invoiceId,
  });
};

/**
 * Send contract expiring notification
 */
export const notifyContractExpiring = async (
  userId: string,
  contractId: string,
  contractNumber: string,
  daysLeft: number,
  roomName: string
) => {
  return createNotification({
    userId,
    type: 'CONTRACT_EXPIRING',
    subject: 'Hợp đồng sắp hết hạn',
    content: `Hợp đồng ${contractNumber} (${roomName}) sẽ hết hạn trong ${daysLeft} ngày. Vui lòng liên hệ để gia hạn.`,
    contractId,
  });
};

/**
 * Send issue resolved notification
 */
export const notifyIssueResolved = async (
  userId: string,
  issueId: string,
  issueTitle: string,
  roomName: string
) => {
  return createNotification({
    userId,
    type: 'ISSUE_RESOLVED',
    subject: 'Sự cố đã được giải quyết',
    content: `Sự cố "${issueTitle}" tại ${roomName} đã được giải quyết thành công.`,
    issueId,
  });
};

/**
 * Send general announcement notification
 */
export const notifyGeneralAnnouncement = async (
  userId: string,
  subject: string,
  content: string
) => {
  return createNotification({
    userId,
    type: 'GENERAL_ANNOUNCEMENT',
    subject,
    content,
  });
};

// =============================================
// BATCH NOTIFICATION FUNCTIONS
// =============================================

/**
 * Send notifications to multiple users
 */
export const sendBulkNotifications = async (
  userIds: string[],
  type: NotificationType,
  content: string,
  subject?: string,
  relatedEntityId?: string
) => {
  const notifications = userIds.map(userId => ({
    user_id: userId,
    type,
    channel: 'IN_APP' as const,
    content,
    subject,
    status: 'PENDING' as const,
    ...(type === 'NEW_INVOICE' || type === 'PAYMENT_REMINDER' || type === 'OVERDUE_INVOICE'
      ? { invoice_id: relatedEntityId }
      : {}),
    ...(type === 'CONTRACT_EXPIRING' ? { contract_id: relatedEntityId } : {}),
    ...(type === 'ISSUE_RESOLVED' ? { issue_id: relatedEntityId } : {}),
  }));

  const { data, error } = await supabase
    .from('notifications')
    .insert(notifications)
    .select();

  if (error) {
    console.error('Error sending bulk notifications:', error);
    throw error;
  }

  return data;
};

// =============================================
// SCHEDULED NOTIFICATION FUNCTIONS
// =============================================

/**
 * Schedule notifications for expiring contracts (run daily)
 */
export const scheduleExpiringContractNotifications = async () => {
  // Get contracts expiring in 30, 15, and 7 days
  const today = new Date();
  const targetDays = [30, 15, 7];

  for (const days of targetDays) {
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() + days);

    const { data: contracts, error } = await supabase
      .from('contracts')
      .select(
        `
        id,
        contract_number,
        end_date,
        user_id,
        rooms (
          name
        )
      `
      )
      .eq('status', 'ACTIVE')
      .gte('end_date', targetDate.toISOString().split('T')[0])
      .lt(
        'end_date',
        new Date(targetDate.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      );

    if (error) {
      console.error(`Error fetching contracts expiring in ${days} days:`, error);
      continue;
    }

    if (contracts && contracts.length > 0) {
      for (const contract of contracts) {
        try {
          await notifyContractExpiring(
            contract.user_id,
            contract.id,
            contract.contract_number,
            days,
            (contract.rooms as any)?.name || 'N/A'
          );
        } catch (err) {
          console.error(`Error creating notification for contract ${contract.id}:`, err);
        }
      }
    }
  }
};

/**
 * Schedule notifications for overdue invoices (run daily)
 */
export const scheduleOverdueInvoiceNotifications = async () => {
  const today = new Date().toISOString().split('T')[0];

  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*')
    .lt('due_date', today)
    .in('status', ['APPROVED', 'PARTIAL_PAID', 'OVERDUE']);

  if (error) {
    console.error('Error fetching overdue invoices:', error);
    return;
  }

  if (invoices && invoices.length > 0) {
    for (const invoice of invoices) {
      const dueDate = new Date(invoice.due_date);
      const daysOverdue = Math.floor(
        (new Date().getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      try {
        await notifyOverdueInvoice(
          invoice.user_id,
          invoice.id,
          invoice.invoice_number,
          daysOverdue,
          invoice.amount - (invoice.amount_paid || 0)
        );
      } catch (err) {
        console.error(`Error creating notification for invoice ${invoice.id}:`, err);
      }
    }
  }
};

/**
 * Schedule notifications for upcoming payments (run daily)
 */
export const schedulePaymentReminderNotifications = async () => {
  const today = new Date();
  const threeDaysLater = new Date(today);
  threeDaysLater.setDate(threeDaysLater.getDate() + 3);

  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*')
    .gte('due_date', today.toISOString().split('T')[0])
    .lte('due_date', threeDaysLater.toISOString().split('T')[0])
    .in('status', ['APPROVED', 'PARTIAL_PAID']);

  if (error) {
    console.error('Error fetching upcoming invoices:', error);
    return;
  }

  if (invoices && invoices.length > 0) {
    for (const invoice of invoices) {
      try {
        await notifyPaymentReminder(
          invoice.user_id,
          invoice.id,
          invoice.invoice_number,
          invoice.due_date,
          invoice.amount - (invoice.amount_paid || 0)
        );
      } catch (err) {
        console.error(`Error creating payment reminder for invoice ${invoice.id}:`, err);
      }
    }
  }
};
