import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertCaptureReceipt, belongsToCaptureOwner, savePendingCapture, syncPendingCapture, syncPendingCaptureBatch, type PendingMeterCapture } from './offlineQueue';

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
