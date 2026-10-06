import { IS_TEST_ENV } from '../appEnvironment';

export const TEST_MEDIA_MESSAGE = 'Tệp không có trong TEST';
export const TEST_MEDIA_DETAIL = 'Bản sao TEST chỉ chứa thông tin tệp. Hãy tải tệp mới để thử.';

// Caller ngoài React (xem biên nhận, OCR...) cũng nhận một URL cục bộ hợp lệ,
// không nhận lại URL production hay chuỗi rỗng khiến fetch tải trang hiện tại.
export const TEST_MEDIA_PLACEHOLDER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160" viewBox="0 0 480 160"><rect width="480" height="160" fill="#f1f5f9"/><text x="240" y="80" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#475569">${TEST_MEDIA_MESSAGE}</text></svg>`,
)}`;

/** URL Storage của project khác là metadata sao chép, không có bytes trong TEST. */
export function isUnavailableTestMedia(value?: string | null): boolean {
  if (!IS_TEST_ENV || !value) return false;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    if (!/^\/storage\/v1\/(?:object|render\/image)\//.test(url.pathname)) return false;
    return url.origin !== new URL(import.meta.env.VITE_SUPABASE_URL).origin;
  } catch {
    return false;
  }
}

/** Dùng tại các thẻ ảnh đọc URL công khai trực tiếp, giữ nguyên hành vi production. */
export function testMediaSource<T extends string | null | undefined>(value: T): T | string {
  return isUnavailableTestMedia(value) ? TEST_MEDIA_PLACEHOLDER : value;
}
