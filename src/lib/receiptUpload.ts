// =============================================
// Upload ảnh chứng từ thanh toán — dùng chung giữa useUploadPaymentReceipt
// (đính ảnh vào payment đã có) và form thu tiền /thu-tien (đính lúc thu).
//
// Bucket 'payment-receipts' (private — hiển thị lại qua
// StorageImage/useSignedUrl), path {uid}/{ts}_receipt.{ext} khớp policy
// INSERT theo folder = auth.uid(). KHÔNG có fallback: bucket 'documents'
// từng được dùng làm fallback KHÔNG tồn tại trên production (audit 02/09/2026)
// nên nhánh đó chỉ che mờ lỗi thật của payment-receipts.
// =============================================

import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';

/** Trả message lỗi nếu file không hợp lệ, null nếu OK. */
export const validateReceiptFile = (file: File): string | null => {
  if (!file.type.startsWith('image/')) {
    return 'Vui lòng chọn file ảnh (jpg, png, gif…)';
  }
  if (file.size > 5 * 1024 * 1024) {
    return 'Kích thước file không được vượt quá 5MB';
  }
  return null;
};

/** Upload lên Storage, trả public URL. Throw lỗi thật của bucket nếu fail. */
export const uploadReceiptToStorage = async (file: File): Promise<string> => {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated');

  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const fileName = `${user.id}/${Date.now()}_receipt.${ext}`;

  const { error } = await supabase.storage
    .from('payment-receipts')
    .upload(fileName, file, { cacheControl: '3600', upsert: false });
  if (error) throw error;

  const { data: urlData } = supabase.storage
    .from('payment-receipts')
    .getPublicUrl(fileName);
  return urlData.publicUrl;
};
