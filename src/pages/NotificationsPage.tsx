import { Suspense, lazy, useState } from 'react';
import MainLayout from "@/components/layout/MainLayout";
import { usePhoneViewport } from '@/hooks/use-mobile';
import { Bell, CheckCheck, Trash2, Filter, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useNotifications,
  useMarkAsRead,
  useMarkAllAsRead,
  useDeleteNotification,
  useDeleteAllRead,
  type Notification,
  type NotificationType,
} from '@/hooks/useNotifications';
import { formatDistanceToNow, format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useNavigate } from 'react-router-dom';

// Bản tin mobile: web-app full-screen riêng (scope CSS .cm-app) — lazy.
const NotificationsMobilePage = lazy(() => import('./NotificationsMobilePage'));

const NotificationsDesktopPage = () => {
  const navigate = useNavigate();
  const [selectedTab, setSelectedTab] = useState<'all' | 'unread'>('all');
  const [selectedType, setSelectedType] = useState<NotificationType | 'all'>(
    'all'
  );

  // Queries
  const { data: allNotifications = [], isLoading } = useNotifications();

  // Mutations
  const markAsReadMutation = useMarkAsRead();
  const markAllAsReadMutation = useMarkAllAsRead();
  const deleteNotificationMutation = useDeleteNotification();
  const deleteAllReadMutation = useDeleteAllRead();

  // Filter notifications
  const filteredNotifications = allNotifications.filter((notification) => {
    // Filter by read/unread
    if (selectedTab === 'unread' && notification.status === 'READ') {
      return false;
    }

    // Filter by type
    if (selectedType !== 'all' && notification.type !== selectedType) {
      return false;
    }

    return true;
  });

  const unreadCount = allNotifications.filter((n) => n.status !== 'READ').length;

  const handleNotificationClick = (notification: Notification) => {
    // Mark as read
    if (notification.status !== 'READ') {
      markAsReadMutation.mutate(notification.id);
    }

    // Navigate to related entity
    if (notification.invoice_id) {
      navigate(`/invoices/${notification.invoice_id}`);
    } else if (notification.contract_id) {
      navigate(`/contracts/${notification.contract_id}`);
    } else if (notification.issue_id) {
      navigate(`/issues/${notification.issue_id}`);
    }
  };

  const getNotificationIcon = (type: NotificationType) => {
    switch (type) {
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
      default:
        return '🔔';
    }
  };

  const getNotificationTypeLabel = (type: NotificationType) => {
    switch (type) {
      case 'NEW_INVOICE':
        return 'Hóa đơn mới';
      case 'PAYMENT_REMINDER':
        return 'Nhắc thanh toán';
      case 'OVERDUE_INVOICE':
        return 'Quá hạn';
      case 'CONTRACT_EXPIRING':
        return 'Hợp đồng hết hạn';
      case 'ISSUE_RESOLVED':
        return 'Công việc';
      case 'GENERAL_ANNOUNCEMENT':
        return 'Thông báo chung';
      default:
        return 'Khác';
    }
  };

  const getNotificationColor = (type: NotificationType) => {
    switch (type) {
      case 'NEW_INVOICE':
        return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'PAYMENT_REMINDER':
        return 'bg-orange-100 text-orange-700 border-orange-200';
      case 'OVERDUE_INVOICE':
        return 'bg-red-100 text-red-700 border-red-200';
      case 'CONTRACT_EXPIRING':
        return 'bg-purple-100 text-purple-700 border-purple-200';
      case 'ISSUE_RESOLVED':
        return 'bg-green-100 text-green-700 border-green-200';
      case 'GENERAL_ANNOUNCEMENT':
        return 'bg-gray-100 text-gray-700 border-gray-200';
      default:
        return 'bg-gray-100 text-gray-700 border-gray-200';
    }
  };

  const notificationTypes: { value: NotificationType | 'all'; label: string }[] =
    [
      { value: 'all', label: 'Tất cả' },
      { value: 'NEW_INVOICE', label: 'Hóa đơn mới' },
      { value: 'PAYMENT_REMINDER', label: 'Nhắc thanh toán' },
      { value: 'OVERDUE_INVOICE', label: 'Quá hạn' },
      { value: 'CONTRACT_EXPIRING', label: 'HĐ hết hạn' },
      { value: 'ISSUE_RESOLVED', label: 'Công việc' },
      { value: 'GENERAL_ANNOUNCEMENT', label: 'Thông báo chung' },
    ];

  return (
    <MainLayout>
      <div className="container mx-auto p-6 max-w-4xl">
        {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-blue-100 flex items-center justify-center">
            <Bell className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Thông báo</h1>
            <p className="text-sm text-muted-foreground">
              {unreadCount > 0
                ? `${unreadCount} thông báo chưa đọc`
                : 'Không có thông báo chưa đọc'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => markAllAsReadMutation.mutate()}
              disabled={markAllAsReadMutation.isPending}
            >
              <CheckCheck className="h-4 w-4 mr-2" />
              Đánh dấu đã đọc
            </Button>
          )}
          {allNotifications.some((n) => n.status === 'READ') && (
            <Button
              variant="outline"
              size="sm"
              className="text-red-600 hover:text-red-700 border-red-200 hover:bg-red-50"
              onClick={() => deleteAllReadMutation.mutate()}
              disabled={deleteAllReadMutation.isPending}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Xóa đã đọc
            </Button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 space-y-4">
        {/* Tabs: All / Unread */}
        <Tabs value={selectedTab} onValueChange={(v) => setSelectedTab(v as any)}>
          <TabsList>
            <TabsTrigger value="all">
              Tất cả ({allNotifications.length})
            </TabsTrigger>
            <TabsTrigger value="unread">Chưa đọc ({unreadCount})</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Type Filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loại:</span>
          {notificationTypes.map((type) => (
            <Button
              key={type.value}
              variant={selectedType === type.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedType(type.value)}
            >
              {type.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Notifications List */}
      <div className="space-y-3">
        {isLoading ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">Đang tải thông báo...</p>
          </Card>
        ) : filteredNotifications.length === 0 ? (
          <Card className="p-12 text-center">
            <Bell className="h-16 w-16 mx-auto mb-4 text-muted-foreground/30" />
            <h3 className="text-lg font-semibold mb-2">Không có thông báo</h3>
            <p className="text-muted-foreground">
              {selectedTab === 'unread'
                ? 'Bạn đã đọc hết tất cả thông báo'
                : 'Chưa có thông báo nào'}
            </p>
          </Card>
        ) : (
          filteredNotifications.map((notification) => (
            <Card
              key={notification.id}
              className={cn(
                'p-4 cursor-pointer hover:shadow-md transition-shadow',
                notification.status === 'READ' ? 'bg-white' : 'bg-blue-50/30'
              )}
              onClick={() => handleNotificationClick(notification)}
            >
              <div className="flex items-start gap-4">
                {/* Icon */}
                <div className="flex-shrink-0 text-3xl">
                  {getNotificationIcon(notification.type)}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  {/* Header: Type Badge + Time */}
                  <div className="flex items-center gap-2 mb-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-xs',
                        getNotificationColor(notification.type)
                      )}
                    >
                      {getNotificationTypeLabel(notification.type)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(notification.created_at), 'dd/MM/yyyy HH:mm')}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ({formatDistanceToNow(new Date(notification.created_at), {
                        addSuffix: true,
                        locale: vi,
                      })})
                    </span>
                    {notification.status !== 'READ' && (
                      <div className="h-2 w-2 rounded-full bg-blue-600" />
                    )}
                  </div>

                  {/* Subject */}
                  {notification.subject && (
                    <h3 className="font-semibold text-gray-900 mb-1">
                      {notification.subject}
                    </h3>
                  )}

                  {/* Content */}
                  <p className="text-sm text-gray-700 leading-relaxed">
                    {notification.content}
                  </p>
                </div>

                {/* Delete Button */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="flex-shrink-0 text-gray-400 hover:text-red-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteNotificationMutation.mutate(notification.id);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))
        )}
        </div>
      </div>
    </MainLayout>
  );
};

/**
 * "/notifications" tách nhánh theo bề ngang màn hình:
 *  - Mobile  → Bản tin web-app (danh sách + chi tiết, dạng app).
 *  - Desktop → trang Thông báo như cũ (MainLayout), KHÔNG đổi.
 */
const NotificationsPage = () => {
  const isPhone = usePhoneViewport();
  if (isPhone) {
    return (
      <Suspense fallback={null}>
        <NotificationsMobilePage />
      </Suspense>
    );
  }
  return <NotificationsDesktopPage />;
};

export default NotificationsPage;
