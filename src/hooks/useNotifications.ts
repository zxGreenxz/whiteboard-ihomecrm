import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

// =============================================
// TYPES
// =============================================

export type NotificationType =
  | 'NEW_INVOICE'
  | 'PAYMENT_REMINDER'
  | 'OVERDUE_INVOICE'
  | 'CONTRACT_EXPIRING'
  | 'ISSUE_RESOLVED'
  | 'GENERAL_ANNOUNCEMENT'
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
  | 'CANCELLED';

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  channel: NotificationChannel;

  // Recipients
  recipient_tenant_ids: string[] | null;
  recipient_emails: string[] | null;
  recipient_phones: string[] | null;

  // Content
  subject: string | null;
  content: string;

  // Related entities
  invoice_id: string | null;
  contract_id: string | null;
  issue_id: string | null;

  // Scheduling
  scheduled_at: string | null;
  sent_at: string | null;

  // Status
  status: NotificationStatus;
  error_message: string | null;

  // Metadata (for in-app notifications)
  is_read?: boolean;
  read_at?: string | null;

  created_at: string;
}

// Extended notification with read status
export interface InAppNotification extends Notification {
  is_read: boolean;
  read_at: string | null;
}

// =============================================
// HOOKS
// =============================================

/**
 * useNotifications - Fetch all in-app notifications for current user
 */
export const useNotifications = () => {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['notifications', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];

      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .eq('channel', 'IN_APP')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      // Add is_read and read_at metadata (from metadata JSONB or default to false)
      const notificationsWithReadStatus: InAppNotification[] = (data || []).map(notif => {
        // For now, we'll use a simple localStorage-based read tracking
        // In production, you might want a separate notifications_read table
        const readKey = `notification_read_${notif.id}`;
        const readData = localStorage.getItem(readKey);
        const isRead = readData ? JSON.parse(readData).is_read : false;
        const readAt = readData ? JSON.parse(readData).read_at : null;

        return {
          ...notif,
          is_read: isRead,
          read_at: readAt,
        };
      });

      return notificationsWithReadStatus;
    },
    enabled: !!user?.id,
    staleTime: 30000, // 30 seconds
    refetchInterval: 60000, // Refetch every minute for real-time feel
  });
};

/**
 * useUnreadNotificationsCount - Get count of unread notifications
 */
export const useUnreadNotificationsCount = () => {
  const { data: notifications = [] } = useNotifications();

  const unreadCount = notifications.filter(n => !n.is_read).length;

  return {
    count: unreadCount,
    hasUnread: unreadCount > 0,
  };
};

/**
 * useMarkAsRead - Mark a notification as read
 */
export const useMarkAsRead = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (notificationId: string) => {
      // For now, use localStorage. In production, update a notifications_read table or metadata
      const readKey = `notification_read_${notificationId}`;
      const readData = {
        is_read: true,
        read_at: new Date().toISOString(),
      };
      localStorage.setItem(readKey, JSON.stringify(readData));

      return notificationId;
    },
    onSuccess: () => {
      // Invalidate notifications query to refetch with updated read status
      queryClient.invalidateQueries({ queryKey: ['notifications', user?.id] });
    },
    onError: (error) => {
      console.error('Error marking notification as read:', error);
      toast.error('Không thể đánh dấu thông báo đã đọc');
    },
  });
};

/**
 * useMarkAllAsRead - Mark all notifications as read
 */
export const useMarkAllAsRead = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();
  const { data: notifications = [] } = useNotifications();

  return useMutation({
    mutationFn: async () => {
      // Mark all notifications as read in localStorage
      notifications.forEach(notif => {
        const readKey = `notification_read_${notif.id}`;
        const readData = {
          is_read: true,
          read_at: new Date().toISOString(),
        };
        localStorage.setItem(readKey, JSON.stringify(readData));
      });

      return notifications.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['notifications', user?.id] });
      toast.success(`Đã đánh dấu ${count} thông báo là đã đọc`);
    },
    onError: (error) => {
      console.error('Error marking all as read:', error);
      toast.error('Không thể đánh dấu tất cả thông báo');
    },
  });
};

/**
 * useCreateNotification - Create a new notification (admin/system use)
 */
export const useCreateNotification = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (notification: Partial<Notification>) => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('notifications')
        .insert({
          user_id: user.id,
          type: notification.type || 'CUSTOM',
          channel: notification.channel || 'IN_APP',
          content: notification.content || '',
          subject: notification.subject,
          status: 'PENDING',
          scheduled_at: notification.scheduled_at,
          invoice_id: notification.invoice_id,
          contract_id: notification.contract_id,
          issue_id: notification.issue_id,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications', user?.id] });
      toast.success('Thông báo đã được tạo');
    },
    onError: (error) => {
      console.error('Error creating notification:', error);
      toast.error('Không thể tạo thông báo');
    },
  });
};

/**
 * useDeleteNotification - Delete a notification
 */
export const useDeleteNotification = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (notificationId: string) => {
      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('id', notificationId);

      if (error) throw error;

      // Also remove from localStorage
      const readKey = `notification_read_${notificationId}`;
      localStorage.removeItem(readKey);

      return notificationId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications', user?.id] });
      toast.success('Thông báo đã được xóa');
    },
    onError: (error) => {
      console.error('Error deleting notification:', error);
      toast.error('Không thể xóa thông báo');
    },
  });
};

// =============================================
// HELPER FUNCTIONS
// =============================================

/**
 * Get notification type label in Vietnamese
 */
export const getNotificationTypeLabel = (type: NotificationType): string => {
  const labels: Record<NotificationType, string> = {
    NEW_INVOICE: 'Hóa đơn mới',
    PAYMENT_REMINDER: 'Nhắc thanh toán',
    OVERDUE_INVOICE: 'Hóa đơn quá hạn',
    CONTRACT_EXPIRING: 'Hợp đồng sắp hết hạn',
    ISSUE_RESOLVED: 'Sự cố đã giải quyết',
    GENERAL_ANNOUNCEMENT: 'Thông báo chung',
    CUSTOM: 'Tùy chỉnh',
  };
  return labels[type] || type;
};

/**
 * Get notification type icon
 */
export const getNotificationTypeIcon = (type: NotificationType): string => {
  const icons: Record<NotificationType, string> = {
    NEW_INVOICE: '📄',
    PAYMENT_REMINDER: '💰',
    OVERDUE_INVOICE: '⚠️',
    CONTRACT_EXPIRING: '📅',
    ISSUE_RESOLVED: '✅',
    GENERAL_ANNOUNCEMENT: '📢',
    CUSTOM: '🔔',
  };
  return icons[type] || '🔔';
};

/**
 * Get notification type color for badge
 */
export const getNotificationTypeColor = (type: NotificationType): string => {
  const colors: Record<NotificationType, string> = {
    NEW_INVOICE: 'bg-blue-100 text-blue-800 border-blue-200',
    PAYMENT_REMINDER: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    OVERDUE_INVOICE: 'bg-red-100 text-red-800 border-red-200',
    CONTRACT_EXPIRING: 'bg-orange-100 text-orange-800 border-orange-200',
    ISSUE_RESOLVED: 'bg-green-100 text-green-800 border-green-200',
    GENERAL_ANNOUNCEMENT: 'bg-purple-100 text-purple-800 border-purple-200',
    CUSTOM: 'bg-gray-100 text-gray-800 border-gray-200',
  };
  return colors[type] || 'bg-gray-100 text-gray-800 border-gray-200';
};
