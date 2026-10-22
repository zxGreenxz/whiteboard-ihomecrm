// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { MeterCaptureMeter } from '@/lib/meter-capture/types';
import type { PendingMeterCapture } from '@/lib/meter-capture/offlineQueue';
const state = vi.hoisted(() => ({ org: 'org-a', catalog: vi.fn(), captures: vi.fn(),
  reconcile: vi.fn(), upload: vi.fn(), pending: vi.fn<() => Promise<PendingMeterCapture[]>>(async () => []), acknowledge: vi.fn(async () => undefined) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'user-a' } }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: state.org }) }));
vi.mock('@/lib/meter-capture/service', () => ({ listCaptureCatalog: state.catalog, listMeterCaptures: state.captures,
  getMeterCaptureByClientId: state.reconcile, submitMeterCapture: state.upload }));
vi.mock('@/lib/meter-capture/offlineQueue', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/meter-capture/offlineQueue')>();
  return { ...actual, listPendingCaptures: state.pending, saveCaptureCatalog: async () => undefined,
    readCaptureCatalog: async () => null,
    syncPendingCaptureBatch: (items: Parameters<typeof actual.syncPendingCaptureBatch>[0], transport: Parameters<typeof actual.syncPendingCaptureBatch>[1], proceed: () => boolean) =>
      actual.syncPendingCaptureBatch(items, { ...transport, acknowledge: state.acknowledge }, proceed) };
});
import { useMeterCaptureDesk } from './useMeterCaptureDesk';
afterEach(() => { cleanup(); vi.resetAllMocks(); state.org = 'org-a'; state.pending.mockResolvedValue([]); });
const meter = (orgId: string): MeterCaptureMeter => ({ id: `meter-${orgId}`, orgId, buildingId: 'building', buildingName: orgId,
  roomId: null, roomName: null, code: orgId, qrText: null, profile: null });
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
