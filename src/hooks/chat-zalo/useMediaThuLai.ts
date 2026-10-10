import { useEffect, useState } from 'react';

/**
 * Ảnh tải lỗi thì thử lại một lần trước khi báo lỗi. 10/10/2026 một ô album báo "Không mở được"
 * trong khi chính link đó vẫn trả 200 — lỗi tải nhất thời không nên thành nhãn lỗi ngay.
 * Lượt thử lại đổi phần fragment (#) để trình duyệt nạp lại; fragment không gửi lên máy chủ nên
 * không làm hỏng chữ ký của link Zalo.
 */
export function useMediaThuLai(url: string | null | undefined) {
  const [lan, setLan] = useState(0);
  useEffect(() => { setLan(0); }, [url]);
  const src = !url ? undefined : lan === 1 && !url.includes('#') ? `${url}#thu-lai` : url;
  return {
    src,
    loi: lan >= 2 || (lan === 1 && !!url && url.includes('#')),
    onError: () => setLan((n) => (n < 2 ? n + 1 : n)),
  };
}
