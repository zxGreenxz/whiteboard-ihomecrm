// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { MeterCaptureMeter } from '@/lib/meter-capture/types';
import type { PendingMeterCapture } from '@/lib/meter-capture/offlineQueue';
const state = vi.hoisted(() => ({ org: 'org-a', catalog: vi.fn(), captures: vi.fn(),
  reconcile: vi.fn(), upload: vi.fn(), pending: vi.fn<() => Promise<PendingMeterCapture[]>>(async () => []), acknowledge: vi.fn(async () => undefined),
  panels: vi.fn<(orgId: string, month: string) => Promise<unknown[]>>(async () => []), panelReconcile: vi.fn(), panelUpload: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'user-a' } }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: state.org }) }));
vi.mock('@/lib/meter-capture/service', () => ({ listCaptureCatalog: state.catalog, listMeterCaptures: state.captures,
  getMeterCaptureByClientId: state.reconcile, submitMeterCapture: state.upload,
  listMeterPanels: state.panels, getMeterPanel: state.panelReconcile, submitMeterPanel: state.panelUpload }));
vi.mock('@/lib/meter-capture/offlineQueue', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/meter-capture/offlineQueue')>();
  return { ...actual, listPendingCaptures: state.pending, saveCaptureCatalog: async () => undefined,
    readCaptureCatalog: async () => null,
    syncPendingCaptureBatch: (items: Parameters<typeof actual.syncPendingCaptureBatch>[0], transport: Parameters<typeof actual.syncPendingCaptureBatch>[1], proceed: () => boolean) =>
      actual.syncPendingCaptureBatch(items, { ...transport, acknowledge: state.acknowledge }, proceed) };
});
import { useMeterCaptureDesk } from './useMeterCaptureDesk';
afterEach(() => { cleanup(); vi.resetAllMocks(); state.org = 'org-a'; state.pending.mockResolvedValue([]); state.panels.mockResolvedValue([]); });
const meter = (orgId: string): MeterCaptureMeter => ({ id: `meter-${orgId}`, orgId, buildingId: 'building', buildingName: orgId,
  roomId: null, roomName: null, code: orgId, qrText: null, profile: null });
it('closes registration and camera readiness when a previously enabled reader is disabled', async () => {
  state.catalog.mockResolvedValue([meter('org-a')]); state.captures.mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderHook(() => useMeterCaptureDesk('2026-10'), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(view.result.current.catalogReady).toBe(true));
  state.catalog.mockRejectedValue(Object.assign(new Error('Chưa bật bộ đọc'), { code: 'meter_capture_reader_not_enabled' }));
  await act(() => view.result.current.refresh());
  expect(view.result.current.catalogReady).toBe(false);
  expect(view.result.current.error).toBe('Chưa bật bộ đọc');
});
it('hides previous organization media immediately and ignores its late response', async () => {
  let resolveOld!: (value: MeterCaptureMeter[]) => void;
  const old = new Promise<MeterCaptureMeter[]>(resolve => { resolveOld = resolve; });
  state.catalog.mockImplementation((orgId: string) => orgId === 'org-a' ? old : Promise.resolve([meter(orgId)]));
  state.captures.mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useMeterCaptureDesk('2026-10'), { wrapper });
  await waitFor(() => expect(state.catalog).toHaveBeenCalledWith('org-a'));
  state.org = 'org-b'; view.rerender();
  expect(view.result.current.meters).toEqual([]);
  await waitFor(() => expect(view.result.current.meters[0]?.orgId).toBe('org-b'));
  resolveOld([meter('org-a')]);
  await waitFor(() => expect(view.result.current.meters[0]?.orgId).toBe('org-b'));
  expect(view.result.current.owner?.orgId).toBe('org-b');
});
it('finishes queueing an uploaded original before removing the offline copy after a lost finalize response', async () => {
  const saved = { userId: 'user-a', orgId: 'org-a', clientId: 'client', meterId: 'meter', qrText: null,
    file: new Blob(['original'], { type: 'image/jpeg' }), fileName: 'meter.jpg', sha256: 'a'.repeat(64),
    purpose: 'MONTHLY' as const, readingDate: '2026-10-31', month: '2026-10', capturedAt: '2026-10-31T00:00:00Z' };
  state.pending.mockImplementation(async () => [saved]);
  state.catalog.mockResolvedValue([]); state.captures.mockResolvedValue([]);
  const receipt = { clientId: saved.clientId, orgId: saved.orgId, sha256: saved.sha256, mediaReceived: true };
  state.reconcile.mockResolvedValue({ ...receipt, status: 'UPLOADING' });
  state.upload.mockResolvedValue({ ...receipt, status: 'QUEUED' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderHook(() => useMeterCaptureDesk('2026-10'), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(state.acknowledge).toHaveBeenCalledWith(saved, receipt));
  expect(state.upload).toHaveBeenCalledTimes(1);
});
const wrap = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
const savedPanel: PendingMeterCapture = { userId: 'user-a', orgId: 'org-a', kind: 'panel', clientId: 'panel-client', meterId: '', buildingId: 'building-a',
  qrText: null, file: new Blob(['panel original'], { type: 'video/mp4' }), fileName: 'panel.mp4', sha256: 'b'.repeat(64), durationSeconds: 20,
  purpose: 'MONTHLY', readingDate: '2026-10-31', month: '2026-10', capturedAt: '2026-10-31T00:00:00Z' };
const panelReceipt = { clientId: savedPanel.clientId, orgId: savedPanel.orgId, sha256: savedPanel.sha256, mediaReceived: true };
it('loads panels for the month next to captures and keeps captures visible when only the panel list fails', async () => {
  const capture = { id: 'capture-a', meterId: 'meter-org-a', status: 'REVIEW' };
  state.catalog.mockResolvedValue([meter('org-a')]); state.captures.mockResolvedValue([capture]);
  state.panels.mockResolvedValue([{ id: 'panel-a', buildingId: 'building', detections: [] }]);
  const view = renderHook(() => useMeterCaptureDesk('2026-10'), { wrapper: wrap() });
  await waitFor(() => expect(view.result.current.panels.map(panel => panel.id)).toEqual(['panel-a']));
  expect(state.panels).toHaveBeenCalledWith('org-a', '2026-10');
  state.panels.mockRejectedValue(new Error('Máy chủ chưa hỗ trợ thao tác này.'));
  await act(() => view.result.current.refresh());
  expect(view.result.current.panelError).toContain('Máy chủ chưa hỗ trợ thao tác này.');
  expect(view.result.current.captures).toEqual([capture]);
  expect(view.result.current.catalogReady).toBe(true);
  expect(view.result.current.error).toBe('');
});
it('uploads a kept panel original through the panel gateway after reconciling it by client ID', async () => {
  state.pending.mockImplementation(async () => [savedPanel]);
  state.catalog.mockResolvedValue([]); state.captures.mockResolvedValue([]);
  state.panelReconcile.mockResolvedValue(null);
  state.panelUpload.mockResolvedValue({ ...panelReceipt, status: 'QUEUED' });
  renderHook(() => useMeterCaptureDesk('2026-10'), { wrapper: wrap() });
  await waitFor(() => expect(state.acknowledge).toHaveBeenCalledWith(savedPanel, panelReceipt));
  expect(state.panelReconcile).toHaveBeenCalledWith('org-a', { clientId: 'panel-client' });
  expect(state.panelUpload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ clientId: 'panel-client', orgId: 'org-a', buildingId: 'building-a',
    purpose: 'MONTHLY', readingDate: '2026-10-31', month: '2026-10', sha256: savedPanel.sha256, durationSeconds: 20, file: expect.any(File) }));
  expect(state.reconcile).not.toHaveBeenCalled(); expect(state.upload).not.toHaveBeenCalled();
});
it('releases an already received panel original without uploading it again', async () => {
  state.pending.mockImplementation(async () => [savedPanel]);
  state.catalog.mockResolvedValue([]); state.captures.mockResolvedValue([]);
  state.panelReconcile.mockResolvedValue({ ...panelReceipt, status: 'PROCESSING' });
  renderHook(() => useMeterCaptureDesk('2026-10'), { wrapper: wrap() });
  await waitFor(() => expect(state.acknowledge).toHaveBeenCalledWith(savedPanel, panelReceipt));
  expect(state.panelUpload).not.toHaveBeenCalled();
});
it('keeps a panel original whose finalize was interrupted until the queued receipt arrives', async () => {
  state.pending.mockImplementation(async () => [savedPanel]);
  state.catalog.mockResolvedValue([]); state.captures.mockResolvedValue([]);
  state.panelReconcile.mockResolvedValue({ ...panelReceipt, status: 'UPLOADING' });
  state.panelUpload.mockResolvedValue({ ...panelReceipt, status: 'UPLOADING' });
  const view = renderHook(() => useMeterCaptureDesk('2026-10'), { wrapper: wrap() });
  await waitFor(() => expect(view.result.current.error).toContain('panel.mp4'));
  expect(state.acknowledge).not.toHaveBeenCalled();
});
