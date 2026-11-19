import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { notifyActionError } from '@/lib/asyncActionFeedback';
import { chuanHoaIdThongBao } from '@/lib/notifications/notificationIds';
import { useAuth } from './useAuth';
import { dongThongBaoHeDieuHanh } from './useNotifications';

/**
 * Đánh dấu đã đọc NHIỀU dòng theo id — dùng khi bấm push (một push gộp mang
 * nhiều notificationIds, gói B12). Chỉ đổi `status` PENDING→READ, đúng phần guard
 * server (B1) cho phép người dùng sửa; dòng đã đọc/đã huỷ/không thuộc mình bị bỏ
 * qua chứ không báo lỗi. Trả về id thật sự đã đổi.
 *
 * File riêng (chỉ cầu nối service worker dùng): useNotifications.ts nằm trong
 * chunk vào app đang sát ngưỡng bundle.
 */
export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (notificationIds: readonly string[]): Promise<string[]> => {
      if (!user?.id) throw new Error('User not authenticated');
      const ids = chuanHoaIdThongBao(notificationIds);
      if (ids.length === 0) return [];
      const { data, error } = await supabase
        .from('notifications')
        .update({ status: 'READ' })
        .in('id', ids)
        .eq('user_id', user.id)
        .eq('status', 'PENDING')
        .select('id');
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được số thông báo đã thay đổi.');
      return data.map((row) => row.id);
    },
    onSuccess: (_changed, requested) => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      // Đóng theo id ĐÃ YÊU CẦU, không chỉ id vừa đổi: dòng đã đọc ở máy khác vẫn
      // còn thông báo trên màn khoá máy này.
      dongThongBaoHeDieuHanh(chuanHoaIdThongBao(requested));
    },
    onError: (error) => {
      notifyActionError(error, 'Chưa xác nhận được kết quả đánh dấu thông báo đã đọc');
    },
  });
}
