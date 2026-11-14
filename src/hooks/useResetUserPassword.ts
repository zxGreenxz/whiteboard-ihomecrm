import { useMutation, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/integrations/supabase/client';
import { authzKeys } from '@/hooks/useOrganizationAuthorization';
import { datLaiMatKhauNguoiDung, type AdminResetUserPasswordRequest } from '@/lib/edgeFunctions';

/**
 * Superadmin / chủ công ty đặt lại mật khẩu cho người khác (hàm Edge `admin-reset-user-password`).
 *
 * - Không toast: hộp thoại tự hiện kết quả tại chỗ. `meta.handlesFeedback` để MutationCache chung
 *   không báo thêm lần nữa.
 * - `retry: false` và không có đường tự gửi lại: lỗi `outcomeUnknown` để người dùng tự quyết.
 * - `gcTime: 0`: mật khẩu mới nằm trong `variables` của mutation, không giữ lại trong bộ đệm sau khi
 *   hộp thoại đóng.
 * - Mọi lần thử đều làm mới hồ sơ tổ chức: máy chủ ghi dòng nhật ký ngay khi kiểm quyền xong (cả khi
 *   sau đó thất bại — kèm dòng "không thành"), nên trang Tổ chức phải nạp lại dù kết quả thế nào.
 */
export function useResetUserPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    // KHÔNG đặt dưới 'auth': authQueryCache coi mutation ['auth', …] là đăng nhập/đăng xuất đang chạy
    // và khi đó không tự nạp lại trang lúc đổi tài khoản — đây là thao tác quản trị trên người khác.
    mutationKey: ['admin-users', 'reset-password'],
    meta: { handlesFeedback: true },
    retry: false,
    // Mất mạng thì gọi luôn để nhận lỗi ngay, không để mutation "tạm dừng" treo hộp thoại ở trạng
    // thái đang gửi (hộp thoại không cho đóng lúc đang gửi).
    networkMode: 'always',
    gcTime: 0,
    mutationFn: (input: AdminResetUserPasswordRequest) =>
      datLaiMatKhauNguoiDung((fn, options) => supabase.functions.invoke(fn, options), input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: authzKeys.organization });
    },
  });
}
