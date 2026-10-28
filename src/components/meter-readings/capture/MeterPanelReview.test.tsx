// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MeterCapture, MeterCaptureMeter, MeterPanel, MeterPanelDetection } from '@/lib/meter-capture/types';
const api = vi.hoisted(() => ({ confirm: vi.fn(), assign: vi.fn(), evidence: vi.fn() }));
vi.mock('@/lib/meter-capture/service', () => ({ confirmMeterCapture: api.confirm, assignPanelDetection: api.assign, getPanelEvidence: api.evidence }));
vi.mock('@/hooks/useSignedUrl', () => ({ useSignedUrl: (url?: string | null) => url }));
vi.mock('@/components/ui/storage-image', () => ({ StorageImage: ({ value, alt }: { value?: string | null; alt: string }) => <img src={value ?? undefined} alt={alt} /> }));
import { MeterPanelReview } from './MeterPanelReview';

afterEach(() => { cleanup(); vi.resetAllMocks(); });
const meter = (id: string, roomName: string, buildingId = 'building-a', registered = true): MeterCaptureMeter => ({ id, orgId: 'org-a', buildingId,
  buildingName: buildingId === 'building-a' ? 'Tòa A' : 'Tòa B', roomId: `room-${id}`, roomName, code: `E-${roomName}`, qrText: null,
  profile: registered ? { serial: `S-${roomName}`, displayKind: 'DIGITAL', decimalPlaces: 1, registerCode: '1.8.0', version: 1 } : null });
const meters = [meter('m101', '101'), meter('m102', '102'), meter('m103', '103'), meter('m104', '104', 'building-a', false), meter('m201', '201', 'building-b')];
const child = (id: string, meterId: string, change: Partial<MeterCapture> = {}): MeterCapture => ({ id, clientId: `client-${id}`, orgId: 'org-a', meterId,
  version: 1, status: 'REVIEW', proposedValue: '120.5', previousValue: '110.5', issues: ['PANEL_SINGLE_READER'], replacement: null, supersedesCaptureId: null,
  supersededBy: null, serverResult: null, aiResult: { value: '120.5', registerCode: '1.8.0', unit: 'kWh', status: 'ok' }, evidenceUrl: `/private/${id}`,
  videoUrl: null, evidenceFrames: [], confirmedReadingId: null, readingDate: '2026-10-22', month: '2026-10', purpose: 'MONTHLY',
  capturedAt: '2026-10-22T10:00:00Z', sha256: 'hash', mediaReceived: true, mediaValidated: true, ...change });
const det = (index: number, change: Partial<MeterPanelDetection>): MeterPanelDetection => ({ index, label: null, registerCode: '1.8.0', display: 'digital',
  value: '120.5', clear: true, state: 'UNMATCHED', matchKind: null, meterId: null, roomId: null, roomName: null, meterCode: null, captureId: null,
  cropUrl: `/private/crop-${index}`, timestampSeconds: index, ...change });
const matched = (index: number, label: string | null, captureId: string, meterId: string, matchKind: MeterPanelDetection['matchKind'] = 'QR') =>
  det(index, { label, state: 'MATCHED', matchKind, captureId, meterId, roomName: meterId.slice(1), meterCode: `E-${meterId.slice(1)}` });
const basePanel: MeterPanel = { id: 'panel-a', clientId: 'panel-client', orgId: 'org-a', buildingId: 'building-a', buildingName: 'Tòa A', purpose: 'MONTHLY',
  readingDate: '2026-10-22', month: '2026-10', capturedAt: '2026-10-22T10:00:00Z', status: 'REVIEW', version: 3, mimeType: 'video/mp4', sizeBytes: 1000,
  sha256: 'hash', durationSeconds: 20, mediaReceived: true, mediaValidated: true, issues: [], createdAt: '2026-10-22T10:00:01Z', aiStatus: 'ok', detections: [] };
function show(panel: MeterPanel, captures: MeterCapture[] = [], onChanged = vi.fn(async () => undefined)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (next: MeterCapture[]) => <QueryClientProvider client={client}><MeterPanelReview panel={panel} captures={next} meters={meters} onChanged={onChanged} /></QueryClientProvider>;
  const view = render(ui(captures));
  return { ...view, onChanged, update: (next: MeterCapture[]) => view.rerender(ui(next)) };
}
const row = (name: string) => screen.getByRole('listitem', { name: `Dòng ${name}` });

it('names every detection state in Vietnamese and signs crop images only after the panel is opened', () => {
  show({ ...basePanel, detections: [matched(0, 'P101', 'c101', 'm101', 'QR'), matched(1, '102', 'c102', 'm102', 'LABEL'), matched(2, null, 'c103', 'm103', 'MANUAL'),
    det(3, { label: 'P105', value: null, clear: false }), det(4, { label: '10', state: 'AMBIGUOUS' }), det(5, { label: '101', state: 'DUPLICATE', meterId: 'm101' }),
    det(6, { label: '104', state: 'NO_PROFILE', meterId: 'm104' }), det(7, { label: '106', state: 'NO_CONTRACT' }), det(8, { label: '201', state: 'OTHER_BUILDING', cropUrl: null })] },
  [child('c101', 'm101'), child('c102', 'm102'), child('c103', 'm103')]);
  const card = screen.getByRole('region', { name: 'Bảng đồng hồ Tòa A ngày 2026-10-22' });
  expect(card.textContent).toContain('2026-10-22 · Kỳ tháng · Chờ xác nhận · 9 đồng hồ · 3 đã khớp');
  expect(screen.queryAllByRole('img')).toHaveLength(0);
  expect(screen.queryByRole('article')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Xem từng đồng hồ' }));
  expect(row('P101').textContent).toContain('Đã khớp theo tem QR');
  expect(row('P101').textContent).toContain('P101 → 101 · E-101');
  expect(row('102').textContent).toContain('Đã khớp theo nhãn phòng');
  expect(row('3').textContent).toContain('Không thấy nhãn');
  expect(row('3').textContent).toContain('Đã khớp gán tay');
  expect(row('P105').textContent).toContain('Chưa khớp · AI: Chưa đọc rõ');
  expect(row('10').textContent).toContain('Khớp nhiều phòng');
  expect(row('101').textContent).toContain('Trùng đồng hồ');
  expect(row('101').textContent).toContain('chụp riêng đồng hồ này');
  expect(row('104').textContent).toContain('Đồng hồ chưa đăng ký');
  expect(row('106').textContent).toContain('Chưa xác định hợp đồng');
  expect(row('201').textContent).toContain('Tem thuộc tòa khác');
  expect(within(row('201')).getByText('Không có ảnh cắt')).toBeTruthy();
  expect(screen.getByAltText('Ảnh cắt P101').getAttribute('src')).toBe('/private/crop-0');
  // Matched children reuse the single-capture review; everything else without a child can be assigned except duplicates.
  expect(screen.getAllByRole('article')).toHaveLength(3);
  expect(within(row('P101')).getByRole('article').textContent).toContain('Tòa A · 101 · E-101');
  expect(screen.getAllByRole('button', { name: 'Gán' })).toHaveLength(5);
  expect(within(row('101')).queryByRole('button', { name: 'Gán' })).toBeNull();
  expect(within(row('P101')).queryByRole('button', { name: 'Gán' })).toBeNull();
});

it('offers only registered meters of the panel building, assigns by hand and keeps the row on a conflict', async () => {
  const view = show({ ...basePanel, detections: [matched(0, 'P101', 'c101', 'm101'), det(1, { label: 'P105' })] }, [child('c101', 'm101')]);
  fireEvent.click(screen.getByRole('button', { name: 'Xem từng đồng hồ' }));
  const picker = screen.getByLabelText('Đồng hồ cho P105') as HTMLSelectElement;
  const options = [...picker.options].map(option => [option.value, option.textContent, option.disabled]);
  expect(options).toEqual([['', 'Chọn đồng hồ của Tòa A', false], ['m101', '101 · E-101 (đã có trong bảng)', true], ['m102', '102 · E-102', false],
    ['m103', '103 · E-103', false], ['m104', '104 · E-104 (chưa đăng ký)', true]]);
  const assign = within(row('P105')).getByRole('button', { name: 'Gán' });
  expect(assign.hasAttribute('disabled')).toBe(true);
  api.assign.mockRejectedValueOnce(new Error('Dữ liệu đã thay đổi hoặc đã được lưu. Tải lại để đối chiếu trước khi tiếp tục.'));
  fireEvent.change(picker, { target: { value: 'm102' } });
  fireEvent.click(assign);
  await waitFor(() => expect(within(row('P105')).getByRole('alert').textContent).toContain('Dữ liệu đã thay đổi'));
  expect(view.onChanged).not.toHaveBeenCalled();
  api.assign.mockResolvedValueOnce(basePanel);
  fireEvent.click(within(row('P105')).getByRole('button', { name: 'Gán' }));
  await waitFor(() => expect(view.onChanged).toHaveBeenCalledOnce());
  expect(api.assign).toHaveBeenLastCalledWith({ orgId: 'org-a', panelId: 'panel-a', detectionIndex: 1, meterId: 'm102' });
  expect(within(row('P105')).queryByRole('alert')).toBeNull();
});

it('confirms only eligible children, one after another with the shared reason, and reports each row without retrying', async () => {
  const captures = [child('c1', 'm101'), child('c2', 'm102', { proposedValue: '200', previousValue: '150.5', version: 4 }),
    child('c3', 'm103', { issues: ['PANEL_SINGLE_READER', 'ABNORMAL_INCREASE'] }), child('c4', 'm104', { previousValue: null }),
    child('c5', 'm201', { status: 'CONFIRMED' })];
  const view = show({ ...basePanel, detections: [matched(0, 'A1', 'c1', 'm101'), matched(1, 'A2', 'c2', 'm102'), matched(2, 'A3', 'c3', 'm103'),
    matched(3, 'A4', 'c4', 'm104'), matched(4, 'A5', 'c5', 'm201'), det(5, { label: 'A6' })] }, captures);
  fireEvent.click(screen.getByRole('button', { name: 'Xem từng đồng hồ' }));
  expect(screen.getByText('2/5 dòng đủ điều kiện; các dòng còn lại xác nhận từng dòng.')).toBeTruthy();
  expect(within(row('A1')).getByText('Xác nhận chung được: 110.5 → 120.5 kWh')).toBeTruthy();
  expect(within(row('A3')).queryByText(/Xác nhận chung được/)).toBeNull();
  const confirmAll = screen.getByRole('button', { name: 'Xác nhận tất cả' });
  expect(confirmAll.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Tôi đã xem ảnh từng đồng hồ và đối chiếu số, phần thập phân.' }));
  expect(confirmAll.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Lý do xác nhận chung (bắt buộc)'), { target: { value: 'Abc' } });
  expect(confirmAll.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Lý do xác nhận chung (bắt buộc)'), { target: { value: '  Đối chiếu ảnh cắt từng đồng hồ  ' } });
  let releaseFirst!: () => void;
  api.confirm.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = () => resolve(captures[0]); }))
    .mockRejectedValueOnce(new Error('Dữ liệu đã thay đổi hoặc đã được lưu. Tải lại để đối chiếu trước khi tiếp tục.'));
  fireEvent.click(confirmAll);
  await waitFor(() => expect(api.confirm).toHaveBeenCalledOnce());
  expect(api.confirm).toHaveBeenCalledWith({ orgId: 'org-a', captureId: 'c1', expectedVersion: 1, expectedPreviousValue: '110.5', value: '120.5', reason: 'Đối chiếu ảnh cắt từng đồng hồ' });
  expect(screen.getByRole('button', { name: 'Đang chốt…' }).hasAttribute('disabled')).toBe(true);
  releaseFirst();
  await waitFor(() => expect(screen.getByText('Đã chốt 1/2 dòng. 1 dòng chưa chốt; xem lỗi ở từng dòng.')).toBeTruthy());
  expect(view.onChanged).toHaveBeenCalledOnce();
  expect(api.confirm).toHaveBeenCalledTimes(2);
  expect(api.confirm).toHaveBeenLastCalledWith({ orgId: 'org-a', captureId: 'c2', expectedVersion: 4, expectedPreviousValue: '150.5', value: '200', reason: 'Đối chiếu ảnh cắt từng đồng hồ' });
  expect(within(row('A1')).getByRole('status').textContent).toBe('Đã chốt trong lượt xác nhận chung.');
  expect(within(row('A2')).getByRole('alert').textContent).toContain('Chưa chốt: Dữ liệu đã thay đổi');
  expect((screen.getByRole('checkbox', { name: /Tôi đã xem ảnh từng đồng hồ/ }) as HTMLInputElement).checked).toBe(false);
});

it('asks for the acknowledgement again when polling changes an eligible reading', () => {
  const view = show({ ...basePanel, detections: [matched(0, 'A1', 'c1', 'm101')] }, [child('c1', 'm101')]);
  fireEvent.click(screen.getByRole('button', { name: 'Xem từng đồng hồ' }));
  const acknowledgement = () => screen.getByRole('checkbox', { name: /Tôi đã xem ảnh từng đồng hồ/ }) as HTMLInputElement;
  fireEvent.click(acknowledgement());
  expect(acknowledgement().checked).toBe(true);
  view.update([child('c1', 'm101', { version: 2, proposedValue: '121.5' })]);
  expect(acknowledgement().checked).toBe(false);
  expect(api.confirm).not.toHaveBeenCalled();
});

it('opens the original panel photo or clip only on request and reports an inaccessible original', async () => {
  api.evidence.mockRejectedValueOnce(new Error('Bạn chưa có quyền thực hiện thao tác này.'))
    .mockResolvedValueOnce({ imageUrl: null, videoUrl: '/private/panel-clip', evidenceFrames: [{ imageUrl: '/private/panel-frame', timestampSeconds: 4 }] });
  show({ ...basePanel, detections: [det(0, { label: 'P105' })] });
  expect(api.evidence).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Xem ảnh/clip gốc' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Không tải được ảnh/clip gốc. Bạn chưa có quyền'));
  expect(api.evidence).toHaveBeenCalledWith('org-a', 'panel-a');
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  // With no single image, the viewer shows the clip's first evidence frame and seeks the clip to it.
  expect((await screen.findByAltText('Ảnh cả bảng đồng hồ nội bộ')).getAttribute('src')).toBe('/private/panel-frame');
  expect(screen.getByRole('button', { name: 'Ảnh tại 0:04.0' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Xem clip tại 0:04.0' })).toBeTruthy();
});

it('shows a panel that is still being read without rows or bulk confirmation', () => {
  show({ ...basePanel, status: 'QUEUED', mediaValidated: null, aiStatus: null, detections: [] });
  expect(screen.getByRole('region').textContent).toContain('2026-10-22 · Kỳ tháng · Chờ đọc');
  expect(screen.queryByRole('button', { name: 'Xem từng đồng hồ' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Xác nhận tất cả' })).toBeNull();
});

it('explains a panel where the reader found no meter', () => {
  show({ ...basePanel, aiStatus: 'unreadable', issues: ['NO_METERS_DETECTED', 'qr_outside_meters'], detections: [] });
  const text = screen.getByRole('region').textContent ?? '';
  expect(text).toContain('Cần xem lại: Không phát hiện đồng hồ nào · Có tem QR không nằm trên đồng hồ nào');
  expect(text).toContain('AI chưa đọc rõ bảng này');
});
