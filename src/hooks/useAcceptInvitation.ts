import { actionErrorMessage } from '@/lib/actionFeedback';
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
  if (error) throw new Error(invitationReasons.includes(error.message) ? error.message : actionErrorMessage(error, 'Chưa xác nhận được kết quả nhận lời mời'));
}

const invitationReasons: readonly string[] = [
  "Hãy đăng nhập bằng đúng email đã nhận lời mời, rồi mở lại đường dẫn.",
  "Thiếu mã lời mời.",
  "Tài khoản của bạn chưa có email nên không nhận lời mời được.",
  "Lời mời không tồn tại. Hãy sao chép lại đường dẫn hoặc xin mời lại.",
  "Lời mời này dành cho một địa chỉ email khác.",
  "Lời mời này đã được dùng hoặc đã bị thu hồi.",
  "Lời mời đã hết hạn. Hãy xin người quản lý mời lại.",
  "Bạn đã là thành viên của tổ chức này rồi."
];
