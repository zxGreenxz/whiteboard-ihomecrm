// =============================================================================
// useSignedMediaUrl — ký URL media của Chat Zalo trước khi đưa vào <img>/<video>.
//
// LỖI ĐÃ CẮN THẬT (31/08/2026): ảnh mình gửi từ web hiện ra một ô xám trống.
//
// Nguyên nhân: media do SHOP gửi được tự host trong bucket `zalo-media`, và
// bucket đó **private** (20260813110000 đặt `public = false` có chủ đích — media
// khách hàng không được nằm hớ hênh trên Internet). Nhưng chỗ upload lại lưu
// xuống DB một URL dạng `/object/public/…`, và các component media dùng thẳng
// chuỗi đó. Với bucket private thì đường `/object/public/` trả 400 → ảnh hỏng.
//
// Repo đã có sẵn cách chữa đúng cho đúng lớp lỗi này ở `src/lib/storage.ts`
// (`parseStorageRef` + `createSignedUrlFromStored`, viết cho các bucket ảnh đã
// chuyển private) — chỉ là nhánh Chat Zalo chưa dùng tới. Hook này nối vào đó.
//
// Ba loại giá trị đi qua đây, và chỉ MỘT loại cần ký:
//   • `blob:` / `data:`      → ảnh đang chờ upload ở máy người dùng, dùng thẳng.
//   • URL CDN Zalo (zdn.vn)  → của bên ngoài, không phải Storage, dùng thẳng.
//   • URL Supabase Storage   → ký, vì bucket private.
// Ký nhầm loại đầu là hỏng ảnh đang gửi; không ký loại cuối là ô xám trống.
// =============================================================================
import { useEffect, useState } from 'react';
import { parseStorageRef, createSignedUrlFromStored } from '@/lib/storage';

/**
 * @param raw giá trị đã lưu trong DB (`media_url`) hoặc blob URL tạm.
 * @returns URL dùng được ngay. Trong lúc chờ ký, trả `undefined` thay vì trả URL
 *   chưa ký — hiện một ô trống chớp nhoáng còn hơn để trình duyệt tải 400 rồi
 *   `onError` bật cờ hỏng vĩnh viễn (các component media đều nhớ trạng thái lỗi).
 */
export function useSignedMediaUrl(raw?: string | null): string | undefined {
  const [daKy, setDaKy] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!raw) { setDaKy(undefined); return; }
    // Không phải file Storage (blob/data/CDN ngoài) → dùng nguyên giá trị.
    if (!parseStorageRef(raw)) { setDaKy(raw); return; }

    let conHieuLuc = true;
    setDaKy(undefined);
    createSignedUrlFromStored(raw)
      .then((u) => { if (conHieuLuc) setDaKy(u); })
      // `createSignedUrlFromStored` đã tự trả lại giá trị gốc khi lỗi; nhánh này
      // chỉ phòng trường hợp chính nó ném.
      .catch(() => { if (conHieuLuc) setDaKy(raw); });
    return () => { conHieuLuc = false; };
  }, [raw]);

  return daKy;
}
