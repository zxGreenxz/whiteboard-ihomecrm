import { notifyActionError } from '@/lib/asyncActionFeedback';
import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';
import { useOrganization } from '@/contexts/OrganizationContext';
import { subscribeResilient } from '@/lib/realtime/subscribeResilient';
import { useRealtimeHealth, type RealtimeLinkState } from '@/lib/realtime/channelHealth';
import { suKienCanLamMoi, taoBoGomThongBao, type NotificationChangePayload } from '@/lib/notifications/realtimeSignal';

// Mọi dòng notifications đều mang organization_id (trigger autofill_org_strict
// fail-closed từ 15/09/2026, đo 0 dòng NULL) ⇒ đã chốt công ty thì MỌI thông báo —
// kể cả thông báo thường — chỉ hiện của công ty đó. Trước đây chỉ LIFECYCLE bị lọc
// nên người thuộc hai công ty thấy cả thông báo thường của công ty kia.
// Chưa chốt (null) giữ hành vi cũ: ẩn LIFECYCLE (link phụ thuộc công ty), dòng
// không có event phải qua được ngữ nghĩa NULL của SQL.
// hermes-parity:begin w2c-notifications — Hermes chép vùng này (public.notifications_inbox_v1: phạm vi công ty)
export function inboxScope(organizationId: string | null): string {
  return organizationId
    ? `organization_id.eq.${organizationId}`
    : 'metadata->>event.neq.LIFECYCLE,metadata->>event.is.null';
}
// hermes-parity:end w2c-notifications

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
  // Hai họ mới của bộ 5 sự kiện (E1…E5). Enum Postgres được bổ sung bằng migration
  // ALTER TYPE riêng; union TS đi trước nên UI đã có nhãn/màu sẵn khi dòng đầu tiên về.
  | 'ACTION_REQUIRED'
  | 'APPROVAL_RESULT'
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
  | 'CANCELLED'
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
  job_id?: string | null;
  organization_id?: string | null;
  metadata?: Record<string, unknown> | null;
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
 * Đóng thông báo hệ điều hành của các dòng vừa đọc (C5). Nạp lười: module này nằm
 * trong chunk vào app (chuông mount ở AppProviders) mà chunk đó đang sát ngưỡng
 * bundle — phần dọn màn khoá chỉ cần khi người dùng thực sự đánh dấu đọc.
 */
export function dongThongBaoHeDieuHanh(notificationIds: readonly string[]): void {
  if (notificationIds.length === 0) return;
  void import('@/lib/push/osNotifications')
    .then((os) => os.dongThongBaoDaDoc(notificationIds))
    .catch((error: unknown) => console.warn('[push] chưa đóng được thông báo hệ điều hành đã đọc', error));
}

/**
 * Hook to fetch all notifications for the current user
 */
export function useNotifications() {
  const { data: user } = useAuth();
  const { selectedOrganizationId } = useOrganization();

  return useQuery({
    queryKey: ['notifications', user?.id, selectedOrganizationId],
    queryFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      // hermes-parity:begin w2c-notifications — Hermes chép vùng này (public.notifications_inbox_v1)
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        // Lọc user_id tường minh: RLS đã ép own-row từ 29/07/2026, đây là lớp bảo hiểm
        // + tránh quét thừa. Xem migration 20260729130000_notifications_rls_own_row.sql.
        .eq('user_id', user.id)
        .eq('channel', 'IN_APP')
        // CANCELLED = việc đã xong (hoá đơn đã thu, bàn giao đã xác nhận…): server tự
        // đóng dòng nhắc thay vì xoá, để sự kiện UPDATE vẫn tới chuông. Ẩn khỏi hộp thư.
        .neq('status', 'CANCELLED')
        .or(inboxScope(selectedOrganizationId))
        .order('created_at', { ascending: false })
        // Cap an toàn: trang thông báo không cần kéo toàn bộ lịch sử.
        .limit(200);
      // hermes-parity:end w2c-notifications

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
  const { selectedOrganizationId } = useOrganization();

  return useQuery({
    queryKey: ['notifications', 'unread-count', user?.id, selectedOrganizationId],
    queryFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      // Dùng PENDING làm cờ chưa đọc. Hôm nay bảng chỉ có PENDING/READ nên tương đương
      // `!= READ`; nếu sau này có dòng SENT/FAILED thì phải xem lại (đã ghi trong plan).
      // hermes-parity:begin w2c-notifications — Hermes chép vùng này (public.notifications_inbox_v1: chưa đọc = PENDING)
      const { count, error } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('channel', 'IN_APP')
        .or(inboxScope(selectedOrganizationId))
        .eq('status', 'PENDING');
      // hermes-parity:end w2c-notifications

      if (error) throw error;
      return count || 0;
    },
    enabled: !!user?.id,
    staleTime: 1000 * 30, // 30 seconds
    // Toàn app tắt refetchOnWindowFocus có chủ ý (QueryProvider). Riêng số chưa đọc
    // + danh sách thả xuống thì rẻ (head count + 10 dòng) và là thứ người dùng nhìn
    // đầu tiên khi quay lại tab: bù cho sự kiện realtime đã lỡ lúc tab ngủ.
    refetchOnWindowFocus: true,
  });
}

/**
 * Hook to fetch recent unread notifications (for dropdown)
 */
export function useRecentNotifications(limit: number = 5) {
  const { data: user } = useAuth();
  const { selectedOrganizationId } = useOrganization();

  return useQuery({
    queryKey: ['notifications', 'recent', user?.id, limit, selectedOrganizationId],
    queryFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .eq('channel', 'IN_APP')
        // Cùng tập với hộp thư (vùng parity ở trên): việc đã xong thì không hiện.
        .neq('status', 'CANCELLED')
        .or(inboxScope(selectedOrganizationId))
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data as Notification[];
    },
    enabled: !!user?.id,
    staleTime: 1000 * 30,
    refetchOnWindowFocus: true,
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
      if (!user?.id) throw new Error('User not authenticated');

      // .maybeSingle() thay .single(): dòng không thuộc mình (hoặc đã bị xoá) trả null
      // thay vì ném PGRST116 — trước đây lỗi này bị nuốt câm vì không có onError.
      const { data, error } = await supabase
        .from('notifications')
        .update({ status: 'READ' })
        .eq('id', notificationId)
        .eq('user_id', user.id)
        .select()
        .maybeSingle();

      if (error) throw error;
      return data;
    },
    onSuccess: (_data, notificationId) => {
      // Invalidate all notification queries to refresh
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      // Đã đọc trong app ⇒ thông báo cùng dòng trên màn khoá máy này hết ý nghĩa.
      dongThongBaoHeDieuHanh([notificationId]);
    },
    onError: (error) => {
      notifyActionError(error, 'Chưa xác nhận được kết quả đánh dấu thông báo đã đọc');
    },
  });
}

/**
 * Hook to mark all notifications as read
 */
export function useMarkAllAsRead() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      let query = supabase
        .from('notifications')
        .update({ status: 'READ' })
        .eq('user_id', user.id)
        .eq('channel', 'IN_APP')
        // Chưa đọc = PENDING ở mọi nơi. `neq READ` cũ quét cả CANCELLED (việc đã xong),
        // mà guard server chỉ cho người dùng đổi PENDING→READ.
        .eq('status', 'PENDING');
      // Cùng phạm vi với hộp thư đang hiện: không đánh dấu ngầm thông báo của công ty khác.
      if (selectedOrganizationId) query = query.eq('organization_id', selectedOrganizationId);
      const { data, error } = await query.select('id');

      if (error) throw error;
      if (!Array.isArray(data)) throw new Error("Chưa xác nhận được số thông báo đã thay đổi.");
      return data;
    },
    onSuccess: (rows) => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      dongThongBaoHeDieuHanh(rows.map((row) => row.id));
      if (rows.length) toast.success(`Đã đánh dấu ${rows.length} thông báo là đã đọc.`);
      else toast.info('Không có thông báo chưa đọc cần thay đổi.');
    },
    onError: (error) => {
      notifyActionError(error, 'Chưa xác nhận được kết quả đánh dấu các thông báo đã đọc');
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
      const { data, error } = await supabase
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
      notifyActionError(error, 'Chưa xác nhận được kết quả tạo thông báo');
    },
  });
}

/**
 * Hook to delete a notification
 */
export function useDeleteNotification() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (notificationId: string) => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('notifications')
        .delete()
        .eq('id', notificationId)
        .eq('user_id', user.id)
        .select('id');

      if (error) throw error;
      return data ?? [];
    },
    onSuccess: (rows) => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      // Trước đây toast "thành công" cả khi xoá 0 dòng (dòng của người khác / đã bị xoá).
      if (rows.length) toast.success('Thông báo đã được xóa thành công');
      else toast.info('Thông báo không còn tồn tại');
    },
    onError: (error) => {
      notifyActionError(error, 'Chưa xác nhận được kết quả xóa thông báo');
    },
  });
}

/**
 * Hook to delete all read notifications
 */
export function useDeleteAllRead() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      let query = supabase
        .from('notifications')
        .delete()
        .eq('user_id', user.id)
        .eq('channel', 'IN_APP')
        .eq('status', 'READ');
      // Cùng phạm vi với hộp thư đang hiện: không xoá ngầm thông báo của công ty khác.
      if (selectedOrganizationId) query = query.eq('organization_id', selectedOrganizationId);
      const { data, error } = await query.select('id');

      if (error) throw error;
      if (!Array.isArray(data)) throw new Error("Chưa xác nhận được số thông báo đã thay đổi.");
      return data;
    },
    onSuccess: (rows) => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      if (rows.length) toast.success(`Đã xóa ${rows.length} thông báo đã đọc.`);
      else toast.info('Không có thông báo đã đọc để xóa.');
    },
    onError: (error) => {
      notifyActionError(error, 'Chưa xác nhận được kết quả xóa thông báo');
    },
  });
}

/**
 * Realtime chuông thông báo — KÊNH RIÊNG, cố ý KHÔNG nhét vào hub
 * `useRealtimeDataSync.ts`. Bốn lý do (§E.1):
 *
 *  1. Hub không có chỗ khai `filter`: `SyncEntry` chỉ có `table/keys/domain` và nó
 *     subscribe `{event:'*', schema, table}`. Không filter ⇒ MỖI thông báo của bất kỳ
 *     ai cũng đánh thức toàn bộ máy đang mở app và bắt họ refetch 200 dòng.
 *  2. Một lệnh invalidate `['notifications']` đã phủ cả 3 query key của file này
 *     (chúng dùng chung prefix), không cần bảng ánh xạ của hub.
 *  3. Debounce 800 ms của hub trì hoãn chuông một cách vô ích.
 *  4. `SyncTable` là union ĐÓNG — thêm 1 ca đặc thù vào đó là sửa cấu trúc dùng chung.
 *
 * An toàn dữ liệu: Realtime áp RLS của người đăng ký, và từ 20260729130000 policy
 * `notifications` đã là own-row, nên filter `user_id=eq.<uid>` chỉ là lớp thứ hai.
 *
 * Nghe '*' (21/10/2026, C1): đọc/xoá ở THIẾT BỊ KHÁC và mọi UPDATE phía server
 * (dòng gộp E1 đổi số, LIFECYCLE, v5 tự đánh dấu đọc, nhắc bị huỷ khi việc xong)
 * đều phải tới chuông. Bản cũ chỉ nghe INSERT với lập luận "đọc/xoá là do chính
 * máy này gây ra" — sai khi có hai thiết bị, sai với mọi UPDATE từ server.
 * Sự kiện vẫn chỉ là TÍN HIỆU: lọc bằng `suKienCanLamMoi` (bỏ UPDATE cột push_*
 * của hàng đợi drain) rồi gom 300 ms / trần 1 s (`taoBoGomThongBao`), sau đó mới
 * invalidate — xem realtimeSignal.ts vì sao không gom thì markAll là bão refetch.
 * DELETE tới được qua filter user_id vì bảng để REPLICA IDENTITY FULL (gói B2).
 *
 * Vòng đời kênh (bắt kịp sau rớt/ngủ máy, dựng lại khi server đóng, trạng thái cho
 * dải cảnh báo) do `subscribeResilient` lo — id 'notif' trong store channelHealth.
 */
export const NOTIF_CHANNEL_ID = 'notif';

/**
 * Trạng thái kênh chuông cho popover. MỘT nguồn: store channelHealth (id 'notif')
 * — store riêng cũ đã bỏ để dải cảnh báo layout và chuông không bao giờ lệch nhau.
 * Chưa có kênh (chưa đăng nhập / vừa dọn) ⇒ 'connecting'.
 */
export function useNotificationConnectionStatus(): RealtimeLinkState {
  return useRealtimeHealth().channels[NOTIF_CHANNEL_ID] ?? 'connecting';
}

export function useNotificationsRealtime() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();
  const uid = user?.id ?? null;

  useEffect(() => {
    if (!uid) return;
    const lamMoi = () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };
    const boGom = taoBoGomThongBao(lamMoi);

    const stop = subscribeResilient({
      id: NOTIF_CHANNEL_ID,
      topic: `notif-${uid}`,
      bind: (channel) =>
        channel.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${uid}`,
          },
          (payload: NotificationChangePayload) => {
            if (suKienCanLamMoi(payload)) boGom.day();
          },
        ),
      // Sau gián đoạn/ngủ máy: làm tươi NGAY, không chờ gom — đây là lần bù duy nhất.
      onResync: lamMoi,
    });

    return () => {
      boGom.huy();
      stop();
    };
  }, [uid, queryClient]);
}

/**
 * Bọc hook trên thành component rỗng để mount cạnh `<RealtimeDataSync />` trong
 * `src/App.tsx` (cùng khuôn với hub). Đặt TRONG QueryClientProvider.
 */
export function NotificationsRealtime(): null {
  useNotificationsRealtime();
  return null;
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
