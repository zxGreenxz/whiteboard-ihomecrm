import { IS_TEST_ENV } from "@/lib/appEnvironment";

/**
 * Base URL công khai (deploy Vercel). Dùng cho link chia sẻ trang "Phòng trống".
 * Trên môi trường TEST, link phải trỏ về chính bản Preview đang mở — trỏ về
 * ptcrm.vercel.app thì người nhận sẽ mở trang của PRODUCTION với mã sinh ra ở TEST.
 */
export const PUBLIC_BASE =
  IS_TEST_ENV && typeof window !== "undefined" ? window.location.origin : "https://ptcrm.vercel.app";

/** URL đầy đủ của trang công khai theo token chia sẻ: /r/:token. */
export const roomShareUrl = (token: string): string => `${PUBLIC_BASE}/r/${token}`;
