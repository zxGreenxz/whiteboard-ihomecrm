import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

// Types
export type NotificationType =
  | 'NEW_INVOICE'
  | 'PAYMENT_REMINDER'
  | 'OVERDUE_INVOICE'
  | 'CONTRACT_EXPIRING'
  | 'ISSUE_RESOLVED'
  | 'GENERAL_ANNOUNCEMENT'
  | 'DEPOSIT_SHORTFALL'
  | 'SALARY_BONUS'
  | 'CUSTOM';

export type NotificationChannel =
  | 'IN_APP'
  | 'EMAIL'
  | 'SMS'
  | 'ZALO'
  | 'PUSH';

export type NotificationStatus =
  | 'PENDING'
  | 'SENT'
  | 'FAILED'
  | 'READ';

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  channel: NotificationChannel;
  recipient_tenant_ids?: string[];
  recipient_emails?: string[];
  recipient_phones?: string[];
  subject?: string;
  content: string;
  invoice_id?: string;
  contract_id?: string;
  issue_id?: string;
  scheduled_at?: string;
  sent_at?: string;
  status: NotificationStatus;
  error_message?: string;
  created_at: string;
}

export interface CreateNotificationInput {
  type: NotificationType;
  channel: NotificationChannel;
  recipient_tenant_ids?: string[];
  recipient_emails?: string[];
  recipient_phones?: string[];
  subject?: string;
  content: string;
  invoice_id?: string;
  contract_id?: string;
  issue_id?: string;
  scheduled_at?: string;
}

/**
 * Hook to fetch all notifications for the current user
 */
export function useNotifications() {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['notifications', user?.id],
    queryFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('channel', 'IN_APP')
        .order('created_at', { ascending: false })
        // Cap an toàn: trang thông báo không cần kéo toàn bộ lịch sử.
        .limit(200);

      if (error) throw error;
      return data as Notification[];
    },
    enabled: !!user?.id,
    staleTime: 1000 * 30, // 30 seconds - refresh frequently for real-time feel
  });
}

/**
 * Hook to fetch unread notifications count
 */
export function useUnreadNotificationsCount() {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['notifications', 'unread-count', user?.id],
    queryFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      // Use PENDING as unread indicator since READ may not exist in enum yet
      const { count, error } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('channel', 'IN_APP')
        .eq('status', 'PENDING');

      if (error) throw error;
      return count || 0;
    },
    enabled: !!user?.id,
    staleTime: 1000 * 30, // 30 seconds
  });
}

/**
 * Hook to fetch recent unread notifications (for dropdown)
 */
export function useRecentNotifications(limit: number = 5) {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['notifications', 'recent', user?.id, limit],
    queryFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('channel', 'IN_APP')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data as Notification[];
    },
    enabled: !!user?.id,
    staleTime: 1000 * 30,
  });
}

/**
 * Hook to mark a notification as read
 */
export function useMarkAsRead() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (notificationId: string) => {
      const { data, error } = await supabase
        .from('notifications')
        .update({ status: 'READ' })
        .eq('id', notificationId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      // Invalidate all notification queries to refresh
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

/**
 * Hook to mark all notifications as read
 */
export function useMarkAllAsRead() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      const { error } = await supabase
        .from('notifications')
        .update({ status: 'READ' })
        .eq('channel', 'IN_APP')
        .neq('status', 'READ');

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('Đã đánh dấu tất cả là đã đọc');
    },
    onError: (error) => {
      toast.error('Có lỗi xảy ra khi đánh dấu thông báo: ' + error.message);
    },
  });
}

/**
 * Hook to create a new notification
 */
export function useCreateNotification() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (input: CreateNotificationInput) => {
      if (!user?.id) throw new Error('User not authenticated');

      // types.ts chưa regen sau khi thêm enum 'SALARY_BONUS' → cast (pattern như push.ts)
      const { data, error } = await (supabase as any)
        .from('notifications')
        .insert({
          user_id: user.id,
          ...input,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('Thông báo đã được tạo thành công');
    },
    onError: (error) => {
      toast.error('Có lỗi xảy ra khi tạo thông báo: ' + error.message);
    },
  });
}

/**
 * Hook to delete a notification
 */
export function useDeleteNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (notificationId: string) => {
      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('id', notificationId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('Thông báo đã được xóa thành công');
    },
    onError: (error) => {
      toast.error('Có lỗi xảy ra khi xóa thông báo: ' + error.message);
    },
  });
}

/**
 * Hook to delete all read notifications
 */
export function useDeleteAllRead() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('channel', 'IN_APP')
        .eq('status', 'READ');

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('Đã xóa tất cả thông báo đã đọc thành công');
    },
    onError: (error) => {
      toast.error('Có lỗi xảy ra khi xóa thông báo: ' + error.message);
    },
  });
}

/**
 * Helper function to create notification content based on type
 */
export function getNotificationContent(
  type: NotificationType,
  data: {
    tenantName?: string;
    amount?: number;
    invoiceNumber?: string;
    contractNumber?: string;
    dueDate?: string;
    daysLeft?: number;
    roomName?: string;
    issueTitle?: string;
  }
): { subject: string; content: string } {
  switch (type) {
    case 'NEW_INVOICE':
      return {
        subject: 'Hóa đơn mới',
        content: `Hóa đơn ${data.invoiceNumber} đã được tạo cho ${data.tenantName}. Số tiền: ${data.amount?.toLocaleString('vi-VN')}đ. Hạn thanh toán: ${data.dueDate}.`,
      };
    case 'PAYMENT_REMINDER':
      return {
        subject: 'Nhắc nhở thanh toán',
        content: `Hóa đơn ${data.invoiceNumber} sẽ đến hạn vào ${data.dueDate}. Vui lòng thanh toán ${data.amount?.toLocaleString('vi-VN')}đ.`,
      };
    case 'OVERDUE_INVOICE':
      return {
        subject: 'Hóa đơn quá hạn',
        content: `Hóa đơn ${data.invoiceNumber} đã quá hạn thanh toán. Vui lòng liên hệ với ${data.tenantName} để thu hồi nợ.`,
      };
    case 'CONTRACT_EXPIRING':
      return {
        subject: 'Hợp đồng sắp hết hạn',
        content: `Hợp đồng ${data.contractNumber} của ${data.tenantName} (căn hộ ${data.roomName}) sẽ hết hạn trong ${data.daysLeft} ngày. Vui lòng liên hệ để gia hạn.`,
      };
    case 'ISSUE_RESOLVED':
      return {
        subject: 'Công việc đã được giải quyết',
        content: `Công việc "${data.issueTitle}" tại căn hộ ${data.roomName} đã được giải quyết thành công.`,
      };
    case 'GENERAL_ANNOUNCEMENT':
      return {
        subject: 'Thông báo chung',
        content: 'Thông báo mới từ quản lý.',
      };
    default:
      return {
        subject: 'Thông báo',
        content: '',
      };
  }
}
