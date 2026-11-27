// Phần NHẸ của hàng đợi nhật ký tự gỡ khoá «chờ đối chiếu» (đợt 1b): khoá lưu, phép thử «còn dòng chờ đẩy
// không», và lối gọi đẩy ở nền. Phần đẩy thật nằm ở `pendingValveLogSync.ts` (kéo theo supabase, zod) và chỉ được
// nạp lười khi có việc.
//
// CHỈ `pendingValve.ts` được import tĩnh tệp này. Có thêm nơi import tĩnh (ví dụ gói mở ứng dụng) thì Vite tách nó
// thành gói riêng, và gói đó chen vào danh sách nạp trước của mọi trang đang dùng van, làm gói entry phình (đo
// 24/11/2026: +390 byte, vượt ngưỡng cửa bundle-inventory). Hook mở ứng dụng vì thế tự giữ một bản khoá
// (`usePendingValveLogFlushOnOpen.ts`), có test so khớp với `pendingValveLogKey`.
//
// Khoá localStorage `ihome:pending-valve-log:v1:<người dùng>` là của van (đợt 1); đăng xuất không xoá nó, để lần
// tự gỡ không mất dấu vết trước khi lên được máy chủ.
type ReadPort = Pick<Storage, 'getItem'>;

export const PENDING_VALVE_LOG_PREFIX = 'ihome:pending-valve-log:v1:';
export const pendingValveLogKey = (userId: string): string => PENDING_VALVE_LOG_PREFIX + encodeURIComponent(userId);

/** Hàng đợi của người này còn dòng chờ đẩy. Đọc lỗi (trình duyệt chặn lưu trữ) thì coi như không có, không ném. */
export function pendingValveLogWaiting(userId: string, storage: ReadPort = globalThis.localStorage): boolean {
  try {
    const raw = storage.getItem(pendingValveLogKey(userId));
    return raw !== null && raw !== '[]';
  } catch {
    return false;
  }
}

type SyncModule = { flushPendingValveLog: (userId: string) => Promise<unknown> };

/**
 * Đẩy hàng đợi của người này lên máy chủ ở nền. Không bao giờ ném: đẩy hỏng thì dòng nằm lại hàng đợi và được đẩy ở
 * lần tự gỡ kế tiếp hoặc lần mở ứng dụng sau; việc gỡ dấu hay thao tác của người dùng không chờ bước này.
 */
export async function flushPendingValveLogSoon(
  userId: string,
  options: { delayMs?: number; load?: () => Promise<SyncModule> } = {},
): Promise<void> {
  try {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const sync = await (options.load ?? (() => import('./pendingValveLogSync')))();
    await sync.flushPendingValveLog(userId);
  } catch {
    // Nạp hụt (mất mạng, bản mới vừa phát hành) hay đẩy hỏng: thử lại ở lần sau.
  }
}
