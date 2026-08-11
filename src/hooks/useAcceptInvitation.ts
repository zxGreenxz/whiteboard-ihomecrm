import { supabase } from '@/integrations/supabase/client';

/**
 * Nhận lời mời vào tổ chức bằng mã trong đường dẫn `/invite/:token`.
 *
 * Vì sao là một hàm riêng chứ không nằm thẳng trong trang: `supabase.rpc()` nhận
 * TÊN HÀM là một chuỗi, nên mỗi chỗ gọi rải rác là một chỗ có thể gõ sai mà
 * không trình biên dịch nào bắt. Gom về một nơi thì `check-rpc-arg-names` và
 * `check-rpc-surface` có đúng một điểm để soi, và trang chỉ còn lo phần hiển thị.
 *
 * Máy chủ so email của `auth.uid()` với `email_normalized` của lời mời, nên hàm
 * này chỉ có nghĩa khi người dùng ĐANG đăng nhập.
 */
export async function acceptInvitation(token: string): Promise<void> {
  const { error } = await supabase.rpc('accept_organization_invitation_v1', {
    p_token: token,
  });
  if (error) throw new Error(error.message || 'Không nhận được lời mời.');
}
