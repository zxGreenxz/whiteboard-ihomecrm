import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useQueryClient } from '@tanstack/react-query';
import { listCaptureCatalog, listMeterCaptures, getMeterCaptureByClientId, submitMeterCapture } from '@/lib/meter-capture/service';
import type { MeterCapture, MeterCaptureMeter } from '@/lib/meter-capture/types';
import { listPendingCaptures, saveCaptureCatalog, readCaptureCatalog, syncPendingCaptureBatch, type CaptureUploadReceipt, type PendingMeterCapture } from '@/lib/meter-capture/offlineQueue';

function uploadReceipt(capture: MeterCapture): CaptureUploadReceipt {
  const { clientId, orgId, sha256, mediaReceived } = capture;
  if (!clientId || !orgId || !sha256 || !mediaReceived || capture.status === 'UPLOADING') {
    throw new Error('Chưa nhận đủ biên nhận hoàn tất. Bản gốc vẫn được giữ trên máy.');
  }
  return { clientId, orgId, sha256, mediaReceived };
}

export function useMeterCaptureDesk(month: string) {
  const { data: user } = useAuth();
  const { selectedOrganizationId: orgId } = useOrganization();
  const queryClient = useQueryClient();
  const owner = user?.id && orgId ? { userId: user.id, orgId } : null;
  const scope = owner ? `${owner.userId}/${owner.orgId}` : '';
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const view = `${scope}:${month}`;
  const currentView = useRef(view);
  currentView.current = view;
  const [loadedView, setLoadedView] = useState('');
  const syncing = useRef(false);
  const [meters, setMeters] = useState<MeterCaptureMeter[]>([]);
  const [captures, setCaptures] = useState<MeterCapture[]>([]);
  const [pending, setPending] = useState<PendingMeterCapture[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [catalogReady, setCatalogReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!user?.id || !orgId) return;
    const target = `${user.id}/${orgId}:${month}`;
    const identity = { userId: user.id, orgId };
    try {
      const rows = await listPendingCaptures(identity);
      if (currentView.current !== target) return;
      setPending(rows);
      if (!navigator.onLine) {
        const cached = await readCaptureCatalog<MeterCaptureMeter>(identity);
        if (currentView.current !== target) return;
        if (cached) { setMeters(cached.meters); setCatalogReady(true); setLoadedView(target); }
        return;
      }
      const [catalog, collected] = await Promise.all([listCaptureCatalog(orgId), listMeterCaptures(orgId, month)]);
      if (currentView.current !== target) return;
      setMeters(catalog);
      setCaptures(collected);
      setCatalogReady(true);
      setLoadedView(target);
      await saveCaptureCatalog(identity, catalog);
    } catch (cause) {
      if (currentView.current === target) setError(cause instanceof Error ? cause.message : 'Chưa tải được danh sách đồng hồ.');
    }
  }, [user?.id, orgId, month]);

  const sync = useCallback(async () => {
    if (!user?.id || !orgId || !navigator.onLine || syncing.current) return;
    const target = `${user.id}/${orgId}`;
    syncing.current = true;
    setBusy(true);
    setError('');
    try {
      const rows = await listPendingCaptures({ userId: user.id, orgId });
      const failed = await syncPendingCaptureBatch(rows, {
          reconcile: async saved => {
            const existing = await getMeterCaptureByClientId(saved.clientId, saved.orgId);
            return existing?.mediaReceived && existing.status !== 'UPLOADING' ? uploadReceipt(existing) : null;
          },
          upload: async saved => {
            if (currentScope.current !== target) throw new Error('Tài khoản hoặc tổ chức đã thay đổi. Ảnh vẫn được giữ trên máy.');
            return uploadReceipt(await submitMeterCapture({ ...saved, file: new File([saved.file], saved.fileName, { type: saved.file.type }) }));
          },
      }, () => currentScope.current === target && navigator.onLine);
      if (currentScope.current === target && failed.length) setError(failed.map(item => `${item.fileName}: ${item.error}`).join(' · '));
    } catch (cause) {
      if (currentScope.current === target) setError(cause instanceof Error ? cause.message : 'Chưa đồng bộ được. Ảnh gốc vẫn được giữ trên máy.');
    } finally {
      syncing.current = false;
      if (currentScope.current === target) { setBusy(false); await refresh(); }
    }
  }, [user?.id, orgId, refresh]);

  useEffect(() => {
    currentScope.current = scope;
    setMeters([]); setCaptures([]); setPending([]); setError(''); setCatalogReady(false);
    void refresh();
    return () => { currentScope.current = ''; };
  }, [refresh, scope]);
  useEffect(() => {
    const connected = () => { setOnline(true); void sync(); };
    const disconnected = () => setOnline(false);
    window.addEventListener('online', connected);
    window.addEventListener('offline', disconnected);
    void sync();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') { void refresh(); void sync(); } }, 12000);
    return () => { clearInterval(timer); window.removeEventListener('online', connected); window.removeEventListener('offline', disconnected); };
  }, [refresh, sync]);

  const changed = async () => {
    await refresh();
    for (const queryKey of [['meter-readings'], ['meters'], ['unrecorded-meters']]) void queryClient.invalidateQueries({ queryKey });
  };
  const visible = loadedView === view;
  return { owner, meters: visible ? meters : [], captures: visible ? captures : [], pending: visible ? pending : [], online, busy, error, setError, catalogReady: visible && catalogReady, refresh, sync, changed };
}
