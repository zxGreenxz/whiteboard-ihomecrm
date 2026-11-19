import { useEffect, useRef, useState } from 'react';

/**
 * Hội thoại đang mở của trang Chat Zalo (21/10/2026, A8 — RT-OTHER-M2, RT-OTHER-7).
 *
 * VÌ SAO KHÔNG CÒN `activeId || conversations[0]?.id`
 *   Khi người dùng chưa bấm chọn, kênh `zalo-msg-<id>` và truy vấn 1.000 tin bám
 *   theo hội thoại ĐẦU danh sách. Danh sách sắp theo tin mới nhất, nên mỗi tin ở
 *   hội thoại khác là leave/join kênh rồi tải 1.000 tin của hội thoại mới lên
 *   đầu (đo 24 giờ: 1.754 lần tin kế tiếp thuộc hội thoại khác) — cả trên mobile
 *   đang ở màn danh sách, và khung chat desktop tự nhảy sang người khác. Hôm nay
 *   chưa nổ chỉ vì đầu danh sách là hội thoại được ghim.
 *
 *   Nay hội thoại đầu được CHỐT một lần làm lựa chọn mặc định; danh sách đổi thứ
 *   tự không đổi hội thoại đang mở nữa.
 *
 * ĐỔI CÔNG TY
 *   Trang không remount theo công ty, nên id của công ty cũ sẽ còn nằm lại (trỏ
 *   vào hội thoại không còn trong danh sách). Đổi org ⇒ bỏ chọn, rồi chốt lại hội
 *   thoại đầu của công ty mới khi danh sách về.
 */
export function useActiveConversation(
  conversations: readonly { id: string }[],
  orgId: string | null,
): readonly [string, (id: string) => void] {
  const [activeId, setActiveId] = useState('');
  const orgTruocRef = useRef(orgId);

  useEffect(() => {
    if (orgTruocRef.current === orgId) return;
    orgTruocRef.current = orgId;
    setActiveId('');
  }, [orgId]);

  const dauDanhSach = conversations[0]?.id ?? '';
  useEffect(() => {
    if (activeId || !dauDanhSach) return;
    setActiveId(dauDanhSach);
  }, [activeId, dauDanhSach]);

  return [activeId, setActiveId] as const;
}
