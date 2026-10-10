import { useState } from 'react';

/**
 * Ảnh tải lỗi thì thử lại một lần trước khi báo lỗi. 10/10/2026 một ô album báo "Không mở được"
 * trong khi chính link đó vẫn trả 200 — lỗi tải nhất thời không nên thành nhãn lỗi ngay.
 * Lượt thử lại đổi phần fragment (#) để trình duyệt nạp lại; fragment không gửi lên máy chủ nên
 * không làm hỏng chữ ký của link Zalo. Số lần thử gắn với đúng link đang đếm, nên đổi link là
 * về 0 ngay trong lượt render đó, không chớp ô lỗi của link cũ.
 */
export function useMediaThuLai(url: string | null | undefined) {
  const [dem, setDem] = useState<{ url: string | null | undefined; lan: number }>({ url, lan: 0 });
  const lan = dem.url === url ? dem.lan : 0;
  const src = !url ? undefined : lan === 1 && !url.includes('#') ? `${url}#thu-lai` : url;
  return {
    src,
    loi: lan >= 2 || (lan === 1 && !!url && url.includes('#')),
    onError: () => setDem((d) => {
      const hienTai = d.url === url ? d.lan : 0;
      return { url, lan: hienTai < 2 ? hienTai + 1 : hienTai };
    }),
  };
}
