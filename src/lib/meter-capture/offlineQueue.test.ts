import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertCaptureReceipt, belongsToCaptureOwner, isPanelCapture, listPendingCaptures, savePendingCapture, syncPendingCapture, syncPendingCaptureBatch,
  type PendingMeterCapture } from './offlineQueue';

const item: PendingMeterCapture = {
  userId: 'user-a', orgId: 'org-a', clientId: 'client-a', file: new Blob(['original']), fileName: 'meter.jpg',
  sha256: 'hash-a', meterId: 'meter-a', qrText: 'qr-a', purpose: 'MONTHLY', readingDate: '2026-10-22', month: '2026-10', capturedAt: '2026-10-22T10:00:00Z',
};
const receipt = { clientId: item.clientId, orgId: item.orgId, sha256: item.sha256, mediaReceived: true };
afterEach(() => vi.unstubAllGlobals());
describe('meter original retention', () => {
  it('reconciles a lost upload response before retry and removes only the confirmed original', async () => {
    const reconcile = vi.fn().mockResolvedValue(receipt), upload = vi.fn(), acknowledge = vi.fn();
    await syncPendingCapture(item, { reconcile, upload, acknowledge });
    expect(reconcile).toHaveBeenCalledWith(item);
    expect(upload).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledWith(item, receipt);
  });
  it('resumes an incomplete upload with the same client ID', async () => {
    const upload = vi.fn().mockResolvedValue(receipt), acknowledge = vi.fn();
    await syncPendingCapture(item, { reconcile: vi.fn().mockResolvedValue({ ...receipt, mediaReceived: false }), upload, acknowledge });
    expect(upload).toHaveBeenCalledWith(item);
    expect(acknowledge).toHaveBeenCalledOnce();
  });
  it.each([
    { ...receipt, orgId: 'other-org' }, { ...receipt, clientId: 'other-capture' },
    { ...receipt, sha256: 'other-original' }, { ...receipt, mediaReceived: false },
  ])('does not delete originals after an invalid receipt: %j', async invalid => {
    expect(() => assertCaptureReceipt(item, invalid)).toThrow();
    const acknowledge = vi.fn();
    await expect(syncPendingCapture(item, { reconcile: vi.fn().mockResolvedValue(null), upload: vi.fn().mockResolvedValue(invalid), acknowledge })).rejects.toThrow();
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it('does not upload again or delete when reconciliation fails', async () => {
    const upload = vi.fn(), acknowledge = vi.fn();
    await expect(syncPendingCapture(item, { reconcile: vi.fn().mockRejectedValue(new Error('offline')), upload, acknowledge })).rejects.toThrow('offline');
    expect(upload).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled();
  });
  it('retains a rejected capture and continues uploading later meters', async () => {
    const later = { ...item, clientId: 'client-b', fileName: 'second-meter.jpg', sha256: 'hash-b' };
    const laterReceipt = { ...receipt, clientId: later.clientId, sha256: later.sha256 };
    const upload = vi.fn().mockRejectedValueOnce(new Error('Tem đã thu hồi')).mockResolvedValueOnce(laterReceipt);
    const acknowledge = vi.fn();
    const failed = await syncPendingCaptureBatch([item, later], { reconcile: vi.fn().mockResolvedValue(null), upload, acknowledge });
    expect(upload.mock.calls.map(([saved]) => saved.clientId)).toEqual(['client-a', 'client-b']);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(later, laterReceipt);
    expect(failed).toEqual([{ clientId: item.clientId, fileName: item.fileName, error: 'Tem đã thu hồi' }]);
  });
  it('stops the batch before touching another account after scope changes', async () => {
    const upload = vi.fn(), reconcile = vi.fn(), acknowledge = vi.fn();
    await syncPendingCaptureBatch([item], { reconcile, upload, acknowledge }, () => false);
    expect(reconcile).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled();
  });
  it('isolates both the account and organization', () => {
    expect(belongsToCaptureOwner(item, { userId: 'user-a', orgId: 'org-a' })).toBe(true);
    expect(belongsToCaptureOwner(item, { userId: 'user-b', orgId: 'org-a' })).toBe(false);
    expect(belongsToCaptureOwner(item, { userId: 'user-a', orgId: 'org-b' })).toBe(false);
  });
  it('does not claim the original is saved before IndexedDB commits; quota abort rejects', async () => {
    const tx = { oncomplete: null as (() => void) | null, onabort: null as (() => void) | null,
      error: new DOMException('Quota exceeded', 'QuotaExceededError'), objectStore: () => ({ add: () => ({ result: item.clientId }) }) };
    const close = vi.fn();
    const request = { result: { transaction: () => tx, close }, onsuccess: null as (() => void) | null };
    vi.stubGlobal('indexedDB', { open: () => { queueMicrotask(() => request.onsuccess?.()); return request; } });
    let reportedSaved = false;
    const saving = savePendingCapture(item).then(() => { reportedSaved = true; });
    const outcome = expect(saving).rejects.toThrow('Quota exceeded');
    await vi.waitFor(() => expect(tx.onabort).toBeTypeOf('function'));
    expect(reportedSaved).toBe(false);
    tx.onabort?.();
    await outcome;
    expect(reportedSaved).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });
});

/** Minimal in-memory IndexedDB: one database, keyPath [userId, orgId, clientId], commit after the request. */
function memoryQueue(initial: PendingMeterCapture[]) {
  const key = (row: PendingMeterCapture) => JSON.stringify([row.userId, row.orgId, row.clientId]);
  const rows = new Map(initial.map(row => [key(row), row]));
  const opened: Array<[string, number | undefined]> = [];
  const stores: string[] = [];
  const db = {
    close: () => undefined,
    transaction: (storeName: string) => {
      stores.push(storeName);
      const tx = { oncomplete: null as (() => void) | null, onabort: null as (() => void) | null, onerror: null as (() => void) | null, error: null };
      const request = <T,>(result: T) => { queueMicrotask(() => tx.oncomplete?.()); return { result }; };
      return Object.assign(tx, { objectStore: () => ({
        add: (row: PendingMeterCapture) => { if (rows.has(key(row))) throw new Error('ConstraintError'); rows.set(key(row), row); return request(row.clientId); },
        getAll: (range: { owner: unknown[] }) => request([...rows.values()].filter(row => row.userId === range.owner[0] && row.orgId === range.owner[1])),
      }) });
    },
  };
  vi.stubGlobal('indexedDB', { open: (name: string, version?: number) => {
    opened.push([name, version]);
    const open = { result: db, onsuccess: null as (() => void) | null };
    queueMicrotask(() => open.onsuccess?.());
    return open;
  } });
  vi.stubGlobal('IDBKeyRange', { bound: (lower: unknown[]) => ({ owner: lower }) });
  return { rows, opened, stores };
}

const panelItem: PendingMeterCapture = { ...item, kind: 'panel', clientId: 'client-panel', fileName: 'panel.mp4', sha256: 'hash-panel',
  meterId: '', buildingId: 'building-a', qrText: null, capturedAt: '2026-10-22T09:00:00Z' };
describe('panel originals in the same offline queue', () => {
  it('treats records saved before panel capture as single-meter captures', () => {
    const legacy: PendingMeterCapture = { ...item };
    delete legacy.kind;
    expect(isPanelCapture(legacy)).toBe(false);
    expect(isPanelCapture({ kind: 'meter' })).toBe(false);
    expect(isPanelCapture(panelItem)).toBe(true);
  });
  it('stores a panel original next to an old record in the version 1 store and reads both back', async () => {
    const legacy: PendingMeterCapture = { ...item };
    delete legacy.kind;
    const queue = memoryQueue([legacy]);
    await savePendingCapture(panelItem);
    const listed = await listPendingCaptures({ userId: 'user-a', orgId: 'org-a' });
    expect(queue.opened.every(([name, version]) => name === 'ihome-meter-captures-v1' && version === 1)).toBe(true);
    expect(queue.stores).toEqual(['pending', 'pending']);
    expect(listed.map(row => [row.clientId, isPanelCapture(row)])).toEqual([['client-panel', true], ['client-a', false]]);
    expect(listed[0]).toMatchObject({ kind: 'panel', buildingId: 'building-a', meterId: '', qrText: null });
    expect(listed[1].meterId).toBe('meter-a');
  });
  it('does not keep a panel original that has no building', async () => {
    const queue = memoryQueue([]);
    await expect(savePendingCapture({ ...panelItem, buildingId: undefined })).rejects.toThrow('Chọn tòa');
    expect(queue.opened).toEqual([]);
  });
  it('releases a panel original only for a matching receipt after reconciling by client ID', async () => {
    const receiptFor = { clientId: panelItem.clientId, orgId: panelItem.orgId, sha256: panelItem.sha256, mediaReceived: true };
    const reconcile = vi.fn().mockResolvedValue(null), upload = vi.fn().mockResolvedValue(receiptFor), acknowledge = vi.fn();
    await syncPendingCapture(panelItem, { reconcile, upload, acknowledge });
    expect(reconcile).toHaveBeenCalledWith(panelItem); expect(upload).toHaveBeenCalledWith(panelItem);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(panelItem, receiptFor);
    const keep = vi.fn();
    await expect(syncPendingCapture(panelItem, { reconcile, upload: vi.fn().mockResolvedValue({ ...receiptFor, sha256: 'other-panel' }), acknowledge: keep })).rejects.toThrow();
    expect(keep).not.toHaveBeenCalled();
  });
});
