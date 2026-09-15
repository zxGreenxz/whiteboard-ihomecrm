// Cầu nối tới extension "iHome Tạm trú": CRM chỉ postMessage gói dữ liệu, extension
// mở cổng DVC và điền. Không có credential nào đi qua kênh này.
import type { TamTruPayload } from './tamTruPayload';

export const TAM_TRU_EXT_ATTR = 'data-ihome-tamtru-ext';
export const TAM_TRU_MESSAGE_SOURCE = 'ihome-crm';
export const TAM_TRU_EXT_SOURCE = 'ihome-tamtru-ext';
/** Thư mục extension trong repo, hiện trong hướng dẫn cài. */
export const TAM_TRU_EXT_FOLDER = 'extensions/tam-tru';

interface AckMessage { source?: string; type?: string; requestId?: string; ok?: boolean; error?: string }

/** Phiên bản extension đang cài (content script cầu nối đặt thuộc tính lên <html>), hoặc null. */
export function detectTamTruExtension(doc: Document = document): string | null {
  const v = doc.documentElement.getAttribute(TAM_TRU_EXT_ATTR);
  return v && v.trim() ? v.trim() : null;
}

/** Gửi gói cho extension và chờ xác nhận; từ chối nếu extension im lặng hoặc báo lỗi. */
export function sendTamTruPayload(payload: TamTruPayload, win: Window = window, timeoutMs = 3000): Promise<void> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      win.clearTimeout(timer);
      win.removeEventListener('message', onMessage);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as AckMessage | null;
      // Chỉ nhận tin từ chính cửa sổ này (content script cùng trang); jsdom để source null.
      if ((event.source && event.source !== win) || (event.origin && event.origin !== win.location.origin)) return;
      if (!data || data.source !== TAM_TRU_EXT_SOURCE || data.type !== 'TAM_TRU_ACK' || data.requestId !== requestId) return;
      cleanup();
      if (data.ok) resolve();
      else reject(new Error(data.error || 'Extension từ chối gói dữ liệu.'));
    };
    const timer = win.setTimeout(() => {
      cleanup();
      reject(new Error('Extension iHome Tạm trú không phản hồi. Kiểm tra extension đã bật chưa rồi thử lại.'));
    }, timeoutMs);
    win.addEventListener('message', onMessage);
    win.postMessage({ source: TAM_TRU_MESSAGE_SOURCE, type: 'TAM_TRU_PAYLOAD', requestId, payload }, win.location.origin);
  });
}
