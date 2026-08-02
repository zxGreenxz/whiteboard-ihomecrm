import { Suspense, lazy, useEffect, useMemo } from 'react';
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
import { usePersistedState } from '@/hooks/usePersistedState';
import { resolveNotificationUrl } from '@/lib/notificationRoutes';
import { useMyPermissions } from '@/hooks/useMyPermissions';

// Bản tin mobile: web-app full-screen riêng (scope CSS .cm-app) — lazy.
const NotificationsMobilePage = lazy(() => import('./NotificationsMobilePage'));

// =============================================
// Bảng tra theo LOẠI thông báo — một nguồn sự thật cho icon / nhãn / màu / chip.
// Thứ tự khai báo cũng là thứ tự chip hiển thị: việc-cần-làm trước, thông tin sau.
// =============================================

const TYPE_META: Record<NotificationType, { icon: string; label: string; chip: string; color: string }> = {
  ACTION_REQUIRED: {
    icon: '🛎️',
    label: 'Chờ tôi xử lý',
    chip: 'Chờ tôi xử lý',
    // Khớp badge "Chờ duyệt" của phiếu thu chi (VoucherDetailPage: bg-amber-100 text-amber-700).
    color: 'bg-amber-100 text-amber-700 border-amber-200',
  },
  APPROVAL_RESULT: {
    icon: '✅',
    label: 'Kết quả duyệt',
    chip: 'Kết quả duyệt',
    color: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  },
  PAYMENT_REMINDER: {
    icon: '⏰',
    label: 'Nhắc thanh toán',
    chip: 'Nhắc thanh toán',
    color: 'bg-orange-100 text-orange-700 border-orange-200',
  },
  OVERDUE_INVOICE: {
    icon: '⚠️',
    label: 'Quá hạn',
    chip: 'Quá hạn',
    color: 'bg-red-100 text-red-700 border-red-200',
  },
  CONTRACT_EXPIRING: {
    icon: '📅',
    label: 'Hợp đồng hết hạn',
    chip: 'HĐ hết hạn',
    color: 'bg-purple-100 text-purple-700 border-purple-200',
  },
  DEPOSIT_SHORTFALL: {
    icon: '⚠️',
    label: 'Thiếu cọc',
    chip: 'Thiếu cọc',
    color: 'bg-amber-100 text-amber-800 border-amber-200',
  },
  SALARY_BONUS: {
    icon: '🎉',
    label: 'Thưởng/Lương',
    chip: 'Thưởng/Lương',
    color: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  },
  NEW_INVOICE: {
    icon: '📄',
    label: 'Hóa đơn mới',
    chip: 'Hóa đơn mới',
    color: 'bg-blue-100 text-blue-700 border-blue-200',
  },
  ISSUE_RESOLVED: {
    icon: '✅',
    label: 'Công việc',
    chip: 'Công việc',
    color: 'bg-green-100 text-green-700 border-green-200',
  },
  GENERAL_ANNOUNCEMENT: {
    icon: '📢',
    label: 'Thông báo chung',
    chip: 'Thông báo chung',
    color: 'bg-gray-100 text-gray-700 border-gray-200',
  },
  CUSTOM: {
    icon: '🔔',
    label: 'Thông báo',
    chip: 'Thông báo',
    color: 'bg-gray-100 text-gray-700 border-gray-200',
  },
};

const KNOWN_TYPES = Object.keys(TYPE_META) as NotificationType[];
const KNOWN_FILTER_VALUES = new Set<string>(['all', ...KNOWN_TYPES]);

const NotificationsDesktopPage = () => {
  const navigate = useNavigate();
  const [selectedTab, setSelectedTab] = usePersistedState<'all' | 'unread'>('flt:notifications:tab', 'all');
  const [selectedType, setSelectedType] = usePersistedState<NotificationType | 'all'>(
    'flt:notifications:type',
    'all'
  );

  // Queries
  const { data: allNotifications = [], isLoading } = useNotifications();
  // Allow-list URL cần quyền của người bấm: route bị chặn sẽ được hạ về /my-day
  // thay vì ném thẳng vào một trang họ không mở được.
  const { data: perms } = useMyPermissions();

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

    // ĐI THEO metadata.url TRƯỚC MỌI NHÁNH id — đó là đích do chính nơi phát sự kiện
    // chỉ định (đã có 223 dòng cũ mang metadata.url = '/my-day').
    const url = resolveNotificationUrl(notification.metadata?.url, perms);
    if (url) {
      navigate(url);
      return;
    }

    // Fallback cho các dòng cũ không có metadata.url.
    // (Nhánh issue_id đã bị XOÁ: route /issues/:id KHÔNG tồn tại trong App.tsx.)
    if (notification.invoice_id) {
      navigate(`/invoices/${notification.invoice_id}`);
    } else if (notification.contract_id) {
      navigate(`/contracts/${notification.contract_id}`);
    }
  };

  const getNotificationIcon = (type: NotificationType) => TYPE_META[type]?.icon ?? '🔔';

  const getNotificationTypeLabel = (type: NotificationType) => TYPE_META[type]?.label ?? 'Khác';

  const getNotificationColor = (type: NotificationType) =>
    TYPE_META[type]?.color ?? 'bg-gray-100 text-gray-700 border-gray-200';

  // Đếm theo loại để ẩn chip rỗng — NEW_INVOICE / ISSUE_RESOLVED / GENERAL_ANNOUNCEMENT
  // hiện có 0 dòng trên prod; ẩn (chứ không xoá hẳn) để chip tự hiện lại khi có dữ liệu.
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of allNotifications) m.set(n.type, (m.get(n.type) ?? 0) + 1);
    return m;
  }, [allNotifications]);

  const notificationTypes = useMemo<{ value: NotificationType | 'all'; label: string }[]>(
    () => [
      { value: 'all', label: 'Tất cả' },
      ...KNOWN_TYPES.filter(
        (t) => (typeCounts.get(t) ?? 0) > 0 || selectedType === t,
      ).map((t) => ({ value: t, label: TYPE_META[t].chip })),
    ],
    [typeCounts, selectedType],
  );

  // 🔴 Bẫy "trang rỗng vĩnh viễn": giá trị chip đã lưu trong sessionStorage có thể
  // KHÔNG còn nằm trong danh sách đang render (loại bị bỏ, hoặc chip bị ẩn vì count=0).
  // Không có nhánh hạ về 'all' thì người từng chọn chip đó mở trang chỉ thấy khoảng trắng
  // mà không hiểu vì sao — nút để bấm về đã biến mất cùng chip.
  useEffect(() => {
    if (selectedType === 'all') return;
    // (1) Giá trị lạ/đã bị gỡ khỏi union — hạ ngay, không cần chờ dữ liệu.
    if (!KNOWN_FILTER_VALUES.has(selectedType)) {
      setSelectedType('all');
      return;
    }
    // (2) Chip bị ẩn vì 0 dòng — chỉ kết luận khi đã tải xong VÀ có dữ liệu,
    // nếu không lần render đầu (list rỗng) sẽ xoá oan lựa chọn hợp lệ.
    if (!isLoading && allNotifications.length > 0 && (typeCounts.get(selectedType) ?? 0) === 0) {
      setSelectedType('all');
    }
  }, [selectedType, setSelectedType, isLoading, allNotifications.length, typeCounts]);

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
