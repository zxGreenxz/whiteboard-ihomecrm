// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MeterCapture, MeterCaptureMeter, MeterPanel } from '@/lib/meter-capture/types';
import type { useMeterCaptureDesk } from './useMeterCaptureDesk';
const state = vi.hoisted(() => ({ desk: null as unknown, save: vi.fn(), inspectPanel: vi.fn(), sha: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'user-a' } }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('./useMeterCaptureDesk', () => ({ useMeterCaptureDesk: () => state.desk }));
vi.mock('@/lib/meter-capture/service', () => ({ resolveCaptureQr: vi.fn(), confirmMeterCapture: vi.fn(), assignPanelDetection: vi.fn(),
  getPanelEvidence: vi.fn(), saveMeterCaptureProfile: vi.fn(), revokeMeterCaptureQr: vi.fn(), rotateMeterCaptureQr: vi.fn() }));
vi.mock('@/lib/meter-capture/media', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/meter-capture/media')>(),
  inspectPanelMedia: state.inspectPanel, sha256Media: state.sha }));
vi.mock('@/lib/meter-capture/offlineQueue', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/meter-capture/offlineQueue')>(),
  savePendingCapture: state.save }));
vi.mock('@/hooks/useSignedUrl', () => ({ useSignedUrl: (url?: string | null) => url }));
vi.mock('@/components/ui/storage-image', () => ({ StorageImage: ({ value, alt }: { value?: string | null; alt: string }) => <img src={value ?? undefined} alt={alt} /> }));
import MeterCaptureDialog from './MeterCaptureDialog';

afterEach(() => { cleanup(); vi.resetAllMocks(); });
const meter = (id: string, buildingId: string, buildingName: string, roomName: string): MeterCaptureMeter => ({ id, orgId: 'org-a', buildingId, buildingName,
  roomId: `room-${id}`, roomName, code: `E-${roomName}`, qrText: null, profile: { serial: `S-${roomName}`, displayKind: 'DIGITAL', decimalPlaces: 1, registerCode: '1.8.0', version: 1 } });
const meters = [meter('m101', 'building-a', 'Tòa A', '101'), meter('m201', 'building-b', 'Tòa B', '201')];
const capture = (id: string, meterId: string): MeterCapture => ({ id, clientId: `client-${id}`, orgId: 'org-a', meterId, version: 1, status: 'REVIEW',
  proposedValue: '120.5', previousValue: '110.5', issues: [], replacement: null, supersedesCaptureId: null, supersededBy: null, serverResult: null,
  aiResult: null, evidenceUrl: `/private/${id}`, videoUrl: null, evidenceFrames: [], confirmedReadingId: null, readingDate: '2026-10-22', month: '2026-10',
  purpose: 'MONTHLY', capturedAt: '2026-10-22T10:00:00Z', sha256: 'hash', mediaReceived: true, mediaValidated: true });
const panel: MeterPanel = { id: 'panel-a', clientId: 'panel-client', orgId: 'org-a', buildingId: 'building-a', buildingName: 'Tòa A', purpose: 'MONTHLY',
  readingDate: '2026-10-22', month: '2026-10', capturedAt: '2026-10-22T10:00:00Z', status: 'REVIEW', version: 2, mimeType: 'video/mp4', sizeBytes: 1000,
  sha256: 'hash', durationSeconds: 20, mediaReceived: true, mediaValidated: true, issues: [], createdAt: '2026-10-22T10:00:01Z', aiStatus: 'ok',
  detections: [{ index: 0, label: 'P101', registerCode: '1.8.0', display: 'digital', value: '120.5', clear: true, state: 'MATCHED', matchKind: 'QR',
    meterId: 'm101', roomId: 'room-m101', roomName: '101', meterCode: 'E-101', captureId: 'child', cropUrl: '/private/crop', timestampSeconds: 2 }] };
type Desk = ReturnType<typeof useMeterCaptureDesk>;
function show(change: Partial<Desk> = {}) {
  const desk: Desk = { owner: { userId: 'user-a', orgId: 'org-a' }, meters, captures: [capture('child', 'm101'), capture('single', 'm201')], panels: [panel],
    panelError: '', pending: [], online: true, busy: false, error: '', setError: vi.fn(), catalogReady: true, refresh: vi.fn(async () => undefined),
    sync: vi.fn(async () => undefined), changed: vi.fn(async () => undefined), ...change };
  state.desk = desk;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MeterCaptureDialog open onOpenChange={vi.fn()} month="2026-10" /></QueryClientProvider>);
  return desk;
}

it('reviews a panel child inside its panel card and never again in the flat capture list', () => {
  show();
  // Radix activates tabs on mouse down.
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Đối chiếu (2)' }));
  const card = screen.getByRole('region', { name: 'Bảng đồng hồ Tòa A ngày 2026-10-22' });
  expect(screen.getAllByRole('article').map(article => article.textContent?.includes('E-201'))).toEqual([true]);
  expect(screen.queryByText(/Tòa A · 101 · E-101/)).toBeNull();
  fireEvent.click(within(card).getByRole('button', { name: 'Xem từng đồng hồ' }));
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(within(card).getByRole('article').textContent).toContain('Tòa A · 101 · E-101');
  fireEvent.change(screen.getByLabelText('Tòa'), { target: { value: 'building-b' } });
  expect(screen.queryByRole('region', { name: /Bảng đồng hồ/ })).toBeNull();
  expect(screen.getAllByRole('article').map(article => article.textContent?.includes('E-201'))).toEqual([true]);
});

it('shows a panel listing failure without hiding single captures', () => {
  show({ panels: [], panelError: 'Chưa tải được kết quả đọc cả bảng. Máy chủ chưa hỗ trợ thao tác này.' });
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Đối chiếu (2)' }));
  expect(screen.getByRole('alert').textContent).toContain('Chưa tải được kết quả đọc cả bảng');
  expect(screen.getAllByRole('article')).toHaveLength(2);
});

it('keeps the single-meter flow as the default mode', () => {
  show();
  expect(screen.getByRole('button', { name: 'Một đồng hồ' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText(/Lấy QR và mặt số trong cùng ảnh/)).toBeTruthy();
  expect(screen.queryByText(/Chọn tòa ở ô Tòa phía trên/)).toBeNull();
});

it('keeps a whole-panel original for the chosen building on the device, then starts syncing', async () => {
  const desk = show({ captures: [], panels: [] });
  state.inspectPanel.mockResolvedValue({ durationSeconds: 21.4 });
  state.sha.mockResolvedValue('a'.repeat(64));
  state.save.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Cả bảng đồng hồ' }));
  expect(screen.getByRole('button', { name: 'Cả bảng đồng hồ' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText('Chọn tòa ở ô Tòa phía trên trước khi quay cả bảng.')).toBeTruthy();
  expect(screen.getByText(/Quay chậm lần lượt từng đồng hồ/)).toBeTruthy();
  const clip = new File(['panel clip'], 'bang-dong-ho.mp4', { type: 'video/mp4' });
  fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [clip] } });
  await screen.findByText('Chưa chọn tòa');
  expect(state.inspectPanel).toHaveBeenCalledWith(clip, undefined);
  const acknowledgement = () => screen.getByRole('checkbox', { name: 'Đã chọn đúng tòa; quay lần lượt từng đồng hồ, thấy rõ nhãn phòng hoặc tem QR.' }) as HTMLInputElement;
  const keep = () => screen.getByRole('button', { name: 'Giữ và gửi đọc cả bảng' });
  expect(acknowledgement().disabled).toBe(true);
  expect(keep().hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Tòa'), { target: { value: 'building-a' } });
  fireEvent.click(acknowledgement());
  expect(keep().hasAttribute('disabled')).toBe(false);
  // A different building invalidates the acknowledgement.
  fireEvent.change(screen.getByLabelText('Tòa'), { target: { value: 'building-b' } });
  expect(acknowledgement().checked).toBe(false);
  expect(screen.getByText(/Bảng đồng hồ của tòa:/).textContent).toBe('Bảng đồng hồ của tòa: Tòa B');
  fireEvent.click(acknowledgement());
  fireEvent.click(keep());
  await screen.findByText('Đã giữ ảnh/clip cả bảng trên máy. Bạn có thể quay bảng tiếp theo.');
  expect(state.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: 'user-a', orgId: 'org-a', kind: 'panel', buildingId: 'building-b',
    meterId: '', qrText: null, purpose: 'MONTHLY', month: '2026-10', file: clip, fileName: 'bang-dong-ho.mp4', sha256: 'a'.repeat(64), durationSeconds: 21.4,
    readingDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), clientId: expect.any(String) }));
  await waitFor(() => expect(desk.sync).toHaveBeenCalledOnce());
  expect(desk.refresh).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Giữ và gửi đọc cả bảng' })).toBeNull();
});
