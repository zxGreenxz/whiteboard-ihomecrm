// Cầu nối tới extension "iHome Tạm trú": CRM chuyển gói dữ liệu, extension mở
// cổng DVC và điền. Không có credential nào đi qua kênh này.
//
// VÌ SAO KHÔNG DÙNG window.postMessage
//   Tin trên window đến MỌI listener cùng cửa sổ, kể cả content script của
//   extension khác — và MessageChannel cũng không cứu được, vì cổng nằm trong
//   cùng một sự kiện nên listener nào cũng cầm được. Gói này có CCCD, ngày sinh,
//   SĐT và signed URL 1 giờ tới ảnh giấy tờ, nên phải đi đường riêng:
//   chrome.runtime.sendMessage(<id>, …) nhờ externally_connectable trong manifest
//   của extension. Chrome chuyển thẳng cho đúng extension đó, không ai nghe ké.
//   Id cố định nhờ khoá "key" trong manifest.
import type { TamTruPayload } from './tamTruPayload';

export const TAM_TRU_EXT_ATTR = 'data-ihome-tamtru-ext';
export const TAM_TRU_EXT_ID_ATTR = 'data-ihome-tamtru-id';
/** Id cố định của extension (sinh từ "key" trong extensions/tam-tru/manifest.json). */
export const TAM_TRU_EXT_ID = 'kaleeijefebjdhcmkfdbbffmielfjjgf';
/** Thư mục extension trong repo, hiện trong hướng dẫn cài. */
export const TAM_TRU_EXT_FOLDER = 'extensions/tam-tru';

interface AckMessage { ok?: boolean; error?: string }
interface ChromeRuntimeLike {
  lastError?: { message?: string } | undefined;
  sendMessage?: (id: string, message: unknown, callback: (response?: AckMessage) => void) => void;
}
/** `chrome` do trình duyệt bơm vào trang khi extension khai externally_connectable. */
type WindowWithChrome = Window & { chrome?: { runtime?: ChromeRuntimeLike } };

/** Phiên bản extension đang cài (content script đặt thuộc tính lên <html>), hoặc null. */
export function detectTamTruExtension(doc: Document = document): string | null {
  const v = doc.documentElement.getAttribute(TAM_TRU_EXT_ATTR);
  return v && v.trim() ? v.trim() : null;
}

/** Id extension trang đang thấy; rơi về id cố định khi content script chưa kịp đặt thuộc tính. */
export function tamTruExtensionId(doc: Document = document): string {
  const id = doc.documentElement.getAttribute(TAM_TRU_EXT_ID_ATTR);
  return id && id.trim() ? id.trim() : TAM_TRU_EXT_ID;
}

/** Gửi gói cho extension và chờ xác nhận; từ chối nếu extension im lặng hoặc báo lỗi. */
export function sendTamTruPayload(payload: TamTruPayload, win: Window = window, timeoutMs = 5000): Promise<void> {
  const runtime = (win as WindowWithChrome).chrome?.runtime;
  const chuaCai = 'Extension iHome Tạm trú chưa sẵn sàng. Kiểm tra extension đã bật chưa rồi tải lại trang.';
  return new Promise<void>((resolve, reject) => {
    if (!runtime?.sendMessage) { reject(new Error(chuaCai)); return; }
    let done = false;
    const timer = win.setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('Extension iHome Tạm trú không phản hồi. Kiểm tra extension đã bật chưa rồi thử lại.'));
    }, timeoutMs);
    runtime.sendMessage(tamTruExtensionId(win.document), { type: 'TAM_TRU_PAYLOAD', payload }, (response) => {
      if (done) return;
      done = true;
      win.clearTimeout(timer);
      if (runtime.lastError) { reject(new Error(chuaCai)); return; }
      if (response?.ok) resolve();
      else reject(new Error(response?.error || 'Extension từ chối gói dữ liệu.'));
    });
  });
}
