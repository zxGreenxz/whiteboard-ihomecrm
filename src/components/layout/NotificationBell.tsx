import { useState } from 'react';
import { Bell, Check, CheckCheck, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  useRecentNotifications,
  useUnreadNotificationsCount,
  useMarkAsRead,
  useMarkAllAsRead,
  useDeleteNotification,
  useDeleteAllRead,
  type Notification,
} from '@/hooks/useNotifications';
import { formatDistanceToNow } from 'date-fns';
import { vi } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useNavigate } from 'react-router-dom';
import { resolveNotificationUrl } from '@/lib/notificationRoutes';
import { useMyPermissions } from '@/hooks/useMyPermissions';

const NotificationBell = () => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Allow-list URL cần quyền của người bấm (route bị chặn → hạ về /my-day).
  const { data: perms } = useMyPermissions();

  // Queries
  const { data: notifications = [], isLoading } = useRecentNotifications(10);
  const { data: unreadCount = 0 } = useUnreadNotificationsCount();

  // Mutations
  const markAsReadMutation = useMarkAsRead();
  const markAllAsReadMutation = useMarkAllAsRead();
  const deleteNotificationMutation = useDeleteNotification();
  const deleteAllReadMutation = useDeleteAllRead();

  const handleNotificationClick = (notification: Notification) => {
    // Mark as read
    if (notification.status !== 'READ') {
      markAsReadMutation.mutate(notification.id);
    }

    // ĐI THEO metadata.url TRƯỚC MỌI NHÁNH id — nơi phát sự kiện mới biết đích đúng
    // (danh sách đã lọc sẵn, phiếu cụ thể, tab bàn giao…), không suy ra được từ id.
    const url = resolveNotificationUrl(notification.metadata?.url, perms);
    if (url) {
      navigate(url);
      setOpen(false);
      return;
    }

    // Fallback cho dòng cũ không có metadata.url.
    // (Nhánh issue_id đã bị XOÁ: route /issues/:id KHÔNG tồn tại — bấm vào chỉ đóng
    // dropdown và không đi đâu cả, khiến người dùng tưởng app đơ.)
    if (notification.invoice_id) {
      navigate(`/invoices/${notification.invoice_id}`);
      setOpen(false);
    } else if (notification.contract_id) {
      navigate(`/contracts/${notification.contract_id}`);
      setOpen(false);
    } else if (notification.type === 'SALARY_BONUS') {
      // Giữ lại: 52 dòng SALARY_BONUS cũ không có metadata.url.
      navigate('/finance/salary');
      setOpen(false);
    }
  };

  const handleMarkAllAsRead = () => {
    markAllAsReadMutation.mutate();
  };

  const handleDeleteAllRead = () => {
    deleteAllReadMutation.mutate();
  };

  const handleDeleteNotification = (
    e: React.MouseEvent,
    notificationId: string
  ) => {
    e.stopPropagation();
    deleteNotificationMutation.mutate(notificationId);
  };

  const getNotificationIcon = (type: Notification['type']) => {
    switch (type) {
      case 'ACTION_REQUIRED':
        return '🛎️';
      case 'APPROVAL_RESULT':
        return '✅';
      case 'NEW_INVOICE':
        return '📄';
      case 'PAYMENT_REMINDER':
        return '⏰';
      case 'OVERDUE_INVOICE':
        return '⚠️';
      case 'CONTRACT_EXPIRING':
        return '📅';
      case 'ISSUE_RESOLVED':
        return '✅';
      case 'GENERAL_ANNOUNCEMENT':
        return '📢';
      case 'DEPOSIT_SHORTFALL':
        return '⚠️';
      case 'SALARY_BONUS':
        return '🎉';
      default:
        return '🔔';
    }
  };

  const getNotificationColor = (type: Notification['type']) => {
    switch (type) {
      // Amber = "còn việc phải làm", khớp badge Chờ duyệt của phiếu thu chi.
      case 'ACTION_REQUIRED':
        return 'text-amber-600';
      case 'APPROVAL_RESULT':
        return 'text-emerald-600';
      case 'NEW_INVOICE':
        return 'text-blue-600';
      case 'PAYMENT_REMINDER':
        return 'text-orange-600';
      case 'OVERDUE_INVOICE':
        return 'text-red-600';
      case 'CONTRACT_EXPIRING':
        return 'text-purple-600';
      case 'ISSUE_RESOLVED':
        return 'text-green-600';
      case 'GENERAL_ANNOUNCEMENT':
        return 'text-gray-600';
      case 'DEPOSIT_SHORTFALL':
        return 'text-amber-700';
      case 'SALARY_BONUS':
        return 'text-emerald-600';
      default:
        return 'text-gray-600';
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 min-w-[20px] rounded-full p-0 flex items-center justify-center text-xs"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[380px]">
        {/* Header */}
        <DropdownMenuLabel className="flex items-center justify-between">
          <span className="font-semibold">Thông báo</span>
          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleMarkAllAsRead}
                disabled={markAllAsReadMutation.isPending}
              >
                <CheckCheck className="h-3 w-3 mr-1" />
                Đánh dấu đã đọc
              </Button>
            )}
            {notifications.some((n) => n.status === 'READ') && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-red-600 hover:text-red-700"
                onClick={handleDeleteAllRead}
                disabled={deleteAllReadMutation.isPending}
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Xóa đã đọc
              </Button>
            )}
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        {/* Notifications List */}
        <ScrollArea className="h-[400px]">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Đang tải...
            </div>
          ) : notifications.length === 0 ? (
            <div className="p-8 text-center">
              <Bell className="h-12 w-12 mx-auto mb-3 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                Chưa có thông báo nào
              </p>
            </div>
          ) : (
            <div className="space-y-1 p-1">
              {notifications.map((notification) => (
                <DropdownMenuItem
                  key={notification.id}
                  className={cn(
                    'cursor-pointer p-3 flex-col items-start gap-2',
                    notification.status === 'READ'
                      ? 'bg-white'
                      : 'bg-blue-50/50'
                  )}
                  onClick={() => handleNotificationClick(notification)}
                >
                  <div className="flex items-start gap-3 w-full">
                    {/* Icon */}
                    <div className="flex-shrink-0 text-2xl">
                      {getNotificationIcon(notification.type)}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      {/* Subject */}
                      {notification.subject && (
                        <p
                          className={cn(
                            'text-sm font-medium mb-1',
                            getNotificationColor(notification.type)
                          )}
                        >
                          {notification.subject}
                        </p>
                      )}

                      {/* Content */}
                      <p className="text-sm text-gray-700 line-clamp-2">
                        {notification.content}
                      </p>

                      {/* Time */}
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatDistanceToNow(new Date(notification.created_at), {
                          addSuffix: true,
                          locale: vi,
                        })}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex-shrink-0 flex items-center gap-1">
                      {notification.status !== 'READ' && (
                        <div className="h-2 w-2 rounded-full bg-blue-600" />
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-gray-400 hover:text-red-600"
                        onClick={(e) =>
                          handleDeleteNotification(e, notification.id)
                        }
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </DropdownMenuItem>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        {notifications.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="p-2">
              <Button
                variant="ghost"
                className="w-full text-xs text-primary hover:text-primary"
                onClick={() => {
                  navigate('/notifications');
                  setOpen(false);
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

export default NotificationBell;
