// Phần NHẸ của hàng đợi nhật ký tự gỡ khoá «chờ đối chiếu» (đợt 1b): khoá lưu, phép thử «còn dòng chờ đẩy
// không», công ty đang mở, và lối gọi đẩy ở nền. Tệp này được nạp lúc mở ứng dụng (OrganizationProvider) và
// bởi van (`pendingValve.ts`), nên cố ý không kéo theo supabase, zod hay sổ chiến lược: phần đẩy thật nằm ở
// `pendingValveLogSync.ts` và chỉ được nạp khi hàng đợi có dòng.
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

/**
 * Công ty đang mở trong tab này, đúng khoá mà lõi chống ghi trùng đọc khi dựng phạm vi dấu
 * (`persistentFinancialWorkflow.ts`, `companyPreference.ts` ghi). Van ghi giá trị này vào dòng nhật ký lúc gỡ để
 * máy chủ biết công ty của các dấu phạm vi người dùng ('actor-scope'), vốn không mang mã công ty.
 */
export function readActiveOrganizationId(storage: ReadPort = globalThis.localStorage): string | null {
  try {
    return storage.getItem('ihomecrm.selectedOrganizationId') || null;
  } catch {
    return null;
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
