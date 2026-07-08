// Mở ảnh phiếu chi (bucket private → tạo signed URL rồi mở tab mới).
// Nhận publicUrl đã lưu ở income_expenses.attachments; tách bucket + path
// từ '/object/public/{bucket}/{path}', ký lại 1h. Fallback mở thẳng url.

import { supabase } from '@/integrations/supabase/client';

export const openReceipt = async (url: string): Promise<void> => {
  try {
    const marker = '/object/public/';
    const idx = url.indexOf(marker);
    if (idx >= 0) {
      const rest = url.slice(idx + marker.length); // 'bucket/path...'
      const slash = rest.indexOf('/');
      if (slash > 0) {
        const bucket = rest.slice(0, slash);
        const path = rest.slice(slash + 1);
        const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
        if (data?.signedUrl) {
          window.open(data.signedUrl, '_blank', 'noopener');
          return;
        }
      }
    }
  } catch {
    /* fall through */
  }
  window.open(url, '_blank', 'noopener');
};
