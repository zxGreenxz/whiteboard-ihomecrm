/** Originals stay in IndexedDB until an authenticated server receipt confirms them. */
export interface CaptureOwner { userId: string; orgId: string }
export interface PendingMeterCapture extends CaptureOwner {
  clientId: string;
  file: Blob;
  fileName: string;
  sha256: string;
  durationSeconds?: number;
  meterId: string;
  qrText: string | null;
  purpose: 'MONTHLY' | 'MOVE_OUT';
  readingDate: string;
  month: string;
  contractId?: string;
  capturedAt: string;
}

const DB_NAME = 'ihome-meter-captures-v1';
const STORE = 'pending';
function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Thiết bị không hỗ trợ giữ ảnh ngoại tuyến.')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: ['userId', 'orgId', 'clientId'] });
      request.result.createObjectStore('catalog', { keyPath: ['userId', 'orgId'] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Không mở được nơi giữ ảnh trên máy.'));
    request.onblocked = () => reject(new Error('Đóng tab ghi chỉ số cũ rồi thử lại.'));
  });
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>, storeName = STORE): Promise<T> {
  const db = await openQueue();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    // Request success alone is not durable: quota errors can still abort commit.
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Chưa giữ được ảnh trên máy. Kiểm tra dung lượng.')); };
    tx.onerror = () => { /* onabort carries the transaction outcome */ };
  });
}

export async function saveCaptureCatalog<T>(owner: CaptureOwner, meters: T[]): Promise<void> {
  await transact('readwrite', store => store.put({ ...owner, meters, savedAt: new Date().toISOString() }), 'catalog');
}

export async function readCaptureCatalog<T>(owner: CaptureOwner): Promise<{ meters: T[]; savedAt: string } | null> {
  const result = await transact<{ meters: T[]; savedAt: string } | undefined>('readonly', store => store.get([owner.userId, owner.orgId]), 'catalog');
  return result ?? null;
}

export async function savePendingCapture(capture: PendingMeterCapture): Promise<void> {
  if (!capture.userId || !capture.orgId || !capture.clientId || capture.file.size === 0) throw new Error('Thiếu tài khoản, tổ chức hoặc ảnh cần giữ.');
  await transact('readwrite', store => store.add(capture));
}

export function belongsToCaptureOwner(item: CaptureOwner, owner: CaptureOwner): boolean {
  return item.userId === owner.userId && item.orgId === owner.orgId;
}

export async function listPendingCaptures(owner: CaptureOwner): Promise<PendingMeterCapture[]> {
  const range = IDBKeyRange.bound([owner.userId, owner.orgId], [owner.userId, owner.orgId, []]);
  const rows = await transact<PendingMeterCapture[]>('readonly', store => store.getAll(range));
  return rows.filter(item => belongsToCaptureOwner(item, owner)).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export interface CaptureUploadReceipt { clientId: string; orgId: string; sha256: string; mediaReceived: boolean }
export function assertCaptureReceipt(item: PendingMeterCapture, receipt: CaptureUploadReceipt): void {
  if (receipt.clientId !== item.clientId || receipt.orgId !== item.orgId || receipt.sha256 !== item.sha256 || !receipt.mediaReceived) {
    throw new Error('Server chưa xác nhận nhận đủ đúng ảnh. Bản gốc vẫn được giữ trên máy.');
  }
}

export async function acknowledgeCapture(item: PendingMeterCapture, receipt: CaptureUploadReceipt): Promise<void> {
  assertCaptureReceipt(item, receipt);
  await transact('readwrite', store => store.delete([item.userId, item.orgId, item.clientId]));
}

/** Every retry reconciles first: a timeout may have followed a successful upload. */
export async function syncPendingCapture(item: PendingMeterCapture, transport: {
  reconcile: (item: PendingMeterCapture) => Promise<CaptureUploadReceipt | null>;
  upload: (item: PendingMeterCapture) => Promise<CaptureUploadReceipt>;
  acknowledge?: (item: PendingMeterCapture, receipt: CaptureUploadReceipt) => Promise<void>;
}): Promise<void> {
  const existing = await transport.reconcile(item);
  const receipt = existing?.mediaReceived ? existing : await transport.upload(item);
  assertCaptureReceipt(item, receipt);
  await (transport.acknowledge ?? acknowledgeCapture)(item, receipt);
}

/** One rejected meter must not starve unrelated originals queued behind it. */
export async function syncPendingCaptureBatch(items: PendingMeterCapture[], transport: Parameters<typeof syncPendingCapture>[1],
  shouldContinue: () => boolean = () => true): Promise<Array<{ clientId: string; fileName: string; error: string }>> {
  const failed: Array<{ clientId: string; fileName: string; error: string }> = [];
  for (const item of items) {
    if (!shouldContinue()) break;
    try { await syncPendingCapture(item, transport); }
    catch (cause) { failed.push({ clientId: item.clientId, fileName: item.fileName, error: cause instanceof Error ? cause.message : 'Chưa đồng bộ được; bản gốc vẫn được giữ trên máy.' }); }
  }
  return failed;
}
