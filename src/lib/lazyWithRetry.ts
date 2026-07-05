// =============================================================================
// lazyWithRetry — drop-in thay React.lazy chịu được mạng chập chờn.
//
// TRIỆU CHỨNG (desktop): để im tab một lúc rồi bấm sang trang chưa tải → mạng/
// wifi vừa "ngủ" nên request tải chunk JS của page (import động) ĐẦU TIÊN fail
// → lỗi nổi lên ErrorBoundary, chớp thẻ lỗi ~1s, rồi cơ chế reload tự cứu →
// "Đang tải" ~1-2s → ra dữ liệu. Tự hồi nhưng trông như web lỗi.
//
// CÁCH CHỮA: thử lại import() vài lần với backoff ngắn NGAY TẠI CHỖ trước khi
// để lỗi rơi xuống ErrorBoundary. Hiccup mạng tạm thời → lần retry (mạng đã
// tỉnh) thành công → user chỉ thấy "Đang tải" (Suspense fallback) lâu hơn ~0.5s,
// KHÔNG chớp thẻ lỗi, KHÔNG reload cả trang.
//
// CHỈ retry lỗi dạng chunk-load (mạng/tải module). Lỗi khác (component throw lúc
// eval) ném ngay — không nuốt bug thật. Chunk mất hẳn sau deploy (cache poisoned
// trả cùng nội dung độc) thì retry cũng vô ích → sau MAX_RETRIES ném lại để
// ErrorBoundary/vite:preloadError bust-cache + reload xử như cũ.
// =============================================================================

import { lazy, type ComponentType } from 'react';
import { isChunkLoadError } from './chunkReload';

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 400;

/**
 * Gọi factory, retry khi lỗi chunk-load. Thuần Promise để test không cần React.
 * @param factory hàm trả về Promise (thường là `() => import('...')`).
 */
export async function retryImport<T>(
  factory: () => Promise<T>,
  retries = MAX_RETRIES,
  delay = BASE_DELAY_MS
): Promise<T> {
  try {
    return await factory();
  } catch (err) {
    // Hết lượt, hoặc lỗi KHÔNG phải do tải chunk → ném để ErrorBoundary xử.
    if (retries <= 0 || !isChunkLoadError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return retryImport(factory, retries - 1, delay * 2);
  }
}

/**
 * Drop-in thay React.lazy: bọc factory bằng retryImport. Dùng qua alias trong
 * App.tsx (`import { lazyWithRetry as lazy }`) nên mọi call site giữ nguyên.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
) {
  return lazy(() => retryImport(factory));
}
