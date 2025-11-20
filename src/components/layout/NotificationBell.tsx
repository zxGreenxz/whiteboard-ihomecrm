import { useState } from 'react';
import { Bell, Check, CheckCheck, Trash2, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { vi } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  useNotifications,
  useUnreadNotificationsCount,
  useMarkAsRead,
  useMarkAllAsRead,
  useDeleteNotification,
  getNotificationTypeLabel,
  getNotificationTypeIcon,
  getNotificationTypeColor,
  type InAppNotification,
} from '@/hooks/useNotifications';
import { cn } from '@/lib/utils';
import { useNavigate } from 'react-router-dom';

// =============================================
// NotificationBell Component
// =============================================

const NotificationBell = () => {
  const [isOpen, setIsOpen] = useState(false);
  const { data: notifications = [], isLoading } = useNotifications();
  const { count: unreadCount, hasUnread } = useUnreadNotificationsCount();
  const markAsReadMutation = useMarkAsRead();
  const markAllAsReadMutation = useMarkAllAsRead();

  const handleMarkAllAsRead = () => {
    markAllAsReadMutation.mutate();
  };

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {hasUnread && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0 flex items-center justify-center text-xs"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-96 p-0" align="end">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold text-lg">Thông báo</h3>
          {hasUnread && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={handleMarkAllAsRead}
              disabled={markAllAsReadMutation.isPending}
            >
              <CheckCheck className="h-4 w-4 mr-1" />
              Đánh dấu tất cả đã đọc
            </Button>
          )}
        </div>

        <ScrollArea className="h-[400px]">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Bell className="h-12 w-12 mb-3 opacity-50" />
              <p className="text-sm">Không có thông báo nào</p>
            </div>
          ) : (
            <div className="divide-y">
              {notifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onMarkAsRead={() => markAsReadMutation.mutate(notification.id)}
                  onClose={() => setIsOpen(false)}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {notifications.length > 0 && (
          <>
            <Separator />
            <div className="p-2 text-center">
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  // Future: Navigate to notifications page
                  setIsOpen(false);
                }}
              >
                Xem tất cả thông báo
              </Button>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// =============================================
// NotificationItem Component
// =============================================

interface NotificationItemProps {
  notification: InAppNotification;
  onMarkAsRead: () => void;
  onClose: () => void;
}

const NotificationItem = ({
  notification,
  onMarkAsRead,
  onClose,
}: NotificationItemProps) => {
  const navigate = useNavigate();
  const deleteNotificationMutation = useDeleteNotification();

  const handleClick = () => {
    // Mark as read if unread
    if (!notification.is_read) {
      onMarkAsRead();
    }

    // Navigate based on notification type
    if (notification.invoice_id) {
      navigate(`/invoices/${notification.invoice_id}`);
      onClose();
    } else if (notification.contract_id) {
      navigate(`/contracts/${notification.contract_id}`);
      onClose();
    } else if (notification.issue_id) {
      navigate(`/issues/${notification.issue_id}`);
      onClose();
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNotificationMutation.mutate(notification.id);
  };

  const handleMarkAsRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    onMarkAsRead();
  };

  // Calculate relative time
  const timeAgo = formatDistanceToNow(new Date(notification.created_at), {
    addSuffix: true,
    locale: vi,
  });

  return (
    <div
      className={cn(
        'p-4 hover:bg-accent/50 cursor-pointer transition-colors relative',
        !notification.is_read && 'bg-blue-50/50'
      )}
      onClick={handleClick}
    >
      {/* Unread indicator dot */}
      {!notification.is_read && (
        <div className="absolute left-2 top-6 w-2 h-2 bg-blue-600 rounded-full" />
      )}

      <div className="flex gap-3 pl-3">
        {/* Icon */}
        <div className="flex-shrink-0 text-2xl">
          {getNotificationTypeIcon(notification.type)}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Type badge */}
          <div className="mb-1">
            <Badge
              variant="outline"
              className={cn(
                'text-xs font-normal',
                getNotificationTypeColor(notification.type)
              )}
            >
              {getNotificationTypeLabel(notification.type)}
            </Badge>
          </div>

          {/* Subject */}
          {notification.subject && (
            <p className="font-medium text-sm mb-1">{notification.subject}</p>
          )}

          {/* Content */}
          <p className="text-sm text-muted-foreground line-clamp-2">
            {notification.content}
          </p>

          {/* Time */}
          <p className="text-xs text-muted-foreground mt-1">{timeAgo}</p>
        </div>

        {/* Actions */}
        <div className="flex-shrink-0 flex gap-1">
          {!notification.is_read && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleMarkAsRead}
              title="Đánh dấu đã đọc"
            >
              <Check className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={handleDelete}
            title="Xóa thông báo"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};

export default NotificationBell;
