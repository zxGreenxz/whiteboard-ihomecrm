import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { useOrganization } from '@/contexts/OrganizationContext';
import { inboxScope, useNotifications, useUnreadNotificationsCount, type Notification } from './useNotifications';
import {
  boLocHopThu,
  canDoiMoc,
  gopDongHopThu,
  mocTrangSau,
  SO_DONG_MOI_TRANG,
  TRAN_DANH_SACH_PARITY,
  type InboxCursor,
} from '@/lib/notifications/inboxPaging';

/**
 * "Xem thêm" + tab "Chưa đọc" của trang /notifications — NGOÀI vùng parity
 * w2c-notifications (xem chú thích đầu src/lib/notifications/inboxPaging.ts).
 *
 * File riêng, không nằm trong useNotifications.ts: file đó vào chunk vào app (chuông
 * realtime mount ở AppProviders) đang sát ngưỡng bundle, còn useInfiniteQuery chỉ
 * trang /notifications (lazy) mới cần.
 *
 * - `unreadOnly`: lọc PENDING ngay ở server. Trước đây tab "Chưa đọc" lọc trên 200
 *   dòng đã cắt ở client — người có 1.979 dòng chưa đọc chỉ thấy phần lọt vào 200.
 * - `from`: mốc bắt đầu; null ⇒ đọc từ dòng mới nhất. Tab "Tất cả" truyền dòng
 *   cuối của danh sách parity (id = null ⇒ lấy cả nhóm cùng created_at, khử trùng
 *   ở trang) để nối tiếp sau 200 dòng đầu.
 * - Khoá nằm dưới tiền tố `['notifications']` nên realtime/mutation làm tươi luôn
 *   mọi trang đã tải mà không cần khai riêng.
 */
export function useNotificationPages(options: { unreadOnly: boolean; from: InboxCursor | null; enabled: boolean }) {
  const { data: user } = useAuth();
  const { selectedOrganizationId } = useOrganization();
  const { unreadOnly, from, enabled } = options;

  return useInfiniteQuery({
    queryKey: ['notifications', 'pages', user?.id, selectedOrganizationId, unreadOnly ? 'unread' : 'all', from?.created_at ?? null],
    initialPageParam: from,
    queryFn: async ({ pageParam }): Promise<Notification[]> => {
      if (!user?.id) throw new Error('User not authenticated');
      const base = supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .eq('channel', 'IN_APP');
      // Chưa đọc = PENDING ở mọi nơi; CANCELLED (việc đã xong) không bao giờ hiện.
      const filtered = unreadOnly ? base.eq('status', 'PENDING') : base.neq('status', 'CANCELLED');
      const { data, error } = await filtered
        .or(boLocHopThu(inboxScope(selectedOrganizationId), pageParam))
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(SO_DONG_MOI_TRANG);
      if (error) throw error;
      return data as Notification[];
    },
    getNextPageParam: (lastPage: Notification[]) => mocTrangSau(lastPage),
    enabled: !!user?.id && enabled,
    staleTime: 1000 * 30,
  });
}

export type InboxTab = 'all' | 'unread';

/**
 * Hộp thư của trang /notifications (desktop + mobile) — ghép 200 dòng parity với
 * các trang "Xem thêm", hoặc tab "Chưa đọc" lọc ở server. Số chưa đọc lấy từ hook
 * đếm (count exact), KHÔNG đếm trên danh sách đã cắt — trước đây chuông "99+" mà
 * trang ghi "200 thông báo chưa đọc".
 */
export function useNotificationInbox(tab: InboxTab) {
  const { selectedOrganizationId } = useOrganization();
  const parity = useNotifications();
  const countQuery = useUnreadNotificationsCount();
  const [moc, setMoc] = useState<{ org: string | null; cursor: InboxCursor } | null>(null);
  // Mốc thuộc về công ty lúc bấm; đổi công ty thì mốc cũ vô nghĩa.
  const cursor = moc && moc.org === selectedOrganizationId ? moc.cursor : null;

  const parityRows = useMemo(() => parity.data ?? [], [parity.data]);
  const duoi = parityRows.at(-1);
  useEffect(() => {
    // Dòng mới chèn lên đầu đẩy dòng cuối của top 200 ra ngoài: dời mốc về dòng
    // cuối mới để không hở khoảng giữa hai nguồn (xem canDoiMoc).
    if (cursor && duoi && canDoiMoc(cursor, duoi)) {
      setMoc({ org: selectedOrganizationId, cursor: { created_at: duoi.created_at, id: null } });
    }
  }, [cursor, duoi, selectedOrganizationId]);

  const more = useNotificationPages({ unreadOnly: false, from: cursor, enabled: tab === 'all' && cursor !== null });
  const unread = useNotificationPages({ unreadOnly: true, from: null, enabled: tab === 'unread' });

  const rows = useMemo(
    () => (tab === 'all'
      ? gopDongHopThu(parityRows, ...(cursor ? more.data?.pages ?? [] : []))
      : gopDongHopThu(...(unread.data?.pages ?? []))),
    [tab, parityRows, cursor, more.data, unread.data],
  );

  const coThem = tab === 'all'
    ? parityRows.length >= TRAN_DANH_SACH_PARITY && (cursor === null || more.hasNextPage)
    : unread.hasNextPage;

  const taiThem = () => {
    if (tab === 'unread') {
      void unread.fetchNextPage();
      return;
    }
    if (cursor === null) {
      if (duoi) setMoc({ org: selectedOrganizationId, cursor: { created_at: duoi.created_at, id: null } });
      return;
    }
    void more.fetchNextPage();
  };

  return {
    rows,
    /** Nguồn chính cho QueryRegion của danh sách đang xem. */
    query: tab === 'all' ? parity : unread,
    countQuery,
    unreadCount: countQuery.data,
    coThem,
    taiThem,
    dangTaiThem: tab === 'all'
      ? cursor !== null && (more.isFetchingNextPage || more.isLoading)
      : unread.isFetchingNextPage,
    /** Lỗi của phần "Xem thêm" (tab Tất cả) — hiện cạnh nút, không chặn 200 dòng đầu. */
    loiTaiThem: tab === 'all' && cursor !== null && more.isError ? more.error : null,
    thuLaiTaiThem: () => {
      void more.refetch();
    },
  };
}
