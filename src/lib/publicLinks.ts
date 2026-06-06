/** Base URL công khai (deploy Vercel). Dùng cho link chia sẻ trang "Phòng trống". */
export const PUBLIC_BASE = "https://ptcrm.vercel.app";

/** URL đầy đủ của trang công khai theo token chia sẻ: /r/:token. */
export const roomShareUrl = (token: string): string => `${PUBLIC_BASE}/r/${token}`;
