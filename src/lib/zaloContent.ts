// Nội dung tin Zalo cho giao diện: chuỗi máy của Zalo, thẻ link/danh thiếp, và nhãn cho
// media mà link máy chủ Zalo đã hết hạn. Thuần — test được không cần DOM.
//
// Bối cảnh (đo production 09/10/2026): 484 tin hiện nguyên chữ "sendBubbleMessage" vì worker cũ
// ghi tên hàm Zalo làm nội dung; ảnh, video, file, voice nhận về chỉ lưu link máy chủ Zalo và các
// link thử đều đã trả 404. Chủ dự án chốt không tải file về — giao diện phải nói rõ lý do thay
// vì một ô xám trơn.
import type { ZaloAccount, ZaloCard } from '@/components/chat-zalo/types';

/** Chữ thay cho tin thẻ cũ mà worker chỉ kịp ghi tên hàm của Zalo. */
export const CHU_TIN_THE_CU = 'Tin dạng thẻ — xem trên điện thoại';

const CHUOI_MAY = /^send[A-Z][A-Za-z]*$/;

/** Chữ hiển thị của tin hoặc ô xem trước: chuỗi máy kiểu "sendBubbleMessage" thành câu đọc được. */
export function chuHienThi(text: string): string {
  return CHUOI_MAY.test(text.trim()) ? CHU_TIN_THE_CU : text;
}

const LOAI_THE: ReadonlySet<string> = new Set(['link', 'contact', 'card']);

function chuoi(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** URL đã phân tích, hoặc undefined khi chuỗi không phải URL tuyệt đối. */
function phanTichUrl(s: string): URL | undefined {
  let u: URL | undefined;
  try {
    u = new URL(s);
  } catch {
    /* không phải URL (vd đường dẫn nội bộ "stored:zalo-media/…"): kết quả là undefined, không phải lỗi */
  }
  return u;
}

// Lọc lại ở web: `media_meta` là jsonb, không tin hình dạng của nó chỉ vì worker đã lọc.
function linkWeb(v: unknown): string | null {
  const s = chuoi(v);
  const u = s ? phanTichUrl(s) : undefined;
  return u && (u.protocol === 'https:' || u.protocol === 'http:') ? u.toString() : null;
}

/** Thẻ trong `media_meta.card`; sai hình dạng thì null để web hiện chữ như tin thường. */
export function docThe(meta: unknown): ZaloCard | null {
  if (!meta || typeof meta !== 'object') return null;
  const c: unknown = (meta as Record<string, unknown>).card;
  if (!c || typeof c !== 'object') return null;
  const r = c as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== 'string' || !LOAI_THE.has(kind)) return null;
  return {
    kind: kind as ZaloCard['kind'],
    title: chuoi(r.title),
    description: chuoi(r.description),
    href: linkWeb(r.href),
    thumb: linkWeb(r.thumb),
  };
}

// Máy chủ file của Zalo: ảnh (zdn.vn, zadn.vn), video (dlmd.me), tệp (dlfl.vn).
const MAY_CHU_ZALO = /(^|\.)(zdn\.vn|zadn\.vn|dlmd\.me|dlfl\.vn)$/i;

/** URL nằm trên máy chủ file của Zalo — loại link tự hết hạn sau một thời gian. */
export function laLinkZalo(url: string | null | undefined): boolean {
  const u = url ? phanTichUrl(url) : undefined;
  return !!u && MAY_CHU_ZALO.test(u.hostname);
}

const TEN_MEDIA = { image: 'Ảnh', video: 'Video', voice: 'Tin thoại' } as const;

/**
 * Nhãn khi media không tải được. Link máy chủ Zalo hỏng thì gần như luôn do hết hạn (đo 09/10/2026:
 * mọi link thử đều 404), nhưng mạng chập chờn cũng cho cùng lỗi — nên nói "có thể".
 */
export function nhanMediaLoi(loai: keyof typeof TEN_MEDIA, url: string | null | undefined): string {
  const ten = TEN_MEDIA[loai];
  return laLinkZalo(url) ? `${ten} không mở được — có thể đã hết hạn trên Zalo` : `Không tải được ${ten.toLowerCase()}`;
}

export type CanhBaoKetNoi =
  /** worker im lặng; `tu` = nhịp tim cuối (null khi chưa từng có hoặc worker đã nhả lease) */
  | { loai: 'worker'; tu: string | null }
  /** worker sống nhưng phiên Zalo của một tài khoản hỏng: cần quét QR lại */
  | { loai: 'phien'; accountId: string; ten: string; loi: string | null };

/**
 * Cảnh báo kết nối cho trang Chat Zalo. `status` undefined = chưa đọc được nhịp tim
 * (đang tải, lỗi mạng): không kết luận worker chết, nhưng tài khoản 'error' vẫn là tín hiệu thật.
 */
export function canhBaoKetNoi(
  status: { online: boolean; heartbeatAt: string | null } | undefined,
  accounts: readonly ZaloAccount[],
): CanhBaoKetNoi | null {
  // Chỉ nick cá nhân đi qua worker; tài khoản OA không phụ thuộc nó (khớp phía SQL canh gác).
  const caNhan = accounts.filter((a) => a.kind === 'personal');
  const canWorker = caNhan.some((a) => a.status !== 'disconnected');
  if (status && !status.online && canWorker) {
    const tu = status.heartbeatAt && Date.parse(status.heartbeatAt) > 0 ? status.heartbeatAt : null;
    return { loai: 'worker', tu };
  }
  const hong = caNhan.find((a) => a.status === 'error');
  return hong ? { loai: 'phien', accountId: hong.id, ten: hong.name, loi: hong.lastError ?? null } : null;
}

/** Tên miền ngắn để hiện dưới thẻ link ("example.com"). */
export function tenTrang(href: string | null): string | null {
  const u = href ? phanTichUrl(href) : undefined;
  return u ? u.hostname.replace(/^www\./, '') || null : null;
}
