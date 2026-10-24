// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MeterCapture } from '@/lib/meter-capture/types';
const api = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('@/lib/meter-capture/service', () => ({ confirmMeterCapture: api.confirm }));
vi.mock('@/hooks/useSignedUrl', () => ({ useSignedUrl: (url: string | null) => url }));
vi.mock('@/components/ui/storage-image', () => ({ StorageImage: ({ alt }: { alt: string }) => <img alt={alt} /> }));
import { MeterCaptureReview } from './MeterCaptureReview';

const capture: MeterCapture = { id: 'capture-a', clientId: 'client-a', orgId: 'org-a', meterId: 'meter-a', version: 3,
  status: 'REVIEW', proposedValue: '120.25', issues: [], serverResult: { value: '120.25', registerCode: '1.8.0', unit: 'kWh', status: 'read' },
  aiResult: { value: '120.25', registerCode: '1.8.0', unit: 'kWh', status: 'read' }, evidenceUrl: '/private/image', videoUrl: null,
  previousValue: '110.25', evidenceFrames: [], replacement: null, supersedesCaptureId: null, supersededBy: null,
  confirmedReadingId: null, readingDate: '2026-10-22', month: '2026-10', purpose: 'MONTHLY', capturedAt: '2026-10-22T10:00:00Z', sha256: 'hash', mediaReceived: true, mediaValidated: true };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('waits for actual server media validation before offering confirmation', () => {
  render(<MeterCaptureReview capture={{ ...capture, mediaValidated: false }} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xem / xác nhận' }));
  expect(screen.queryByRole('button', { name: 'Xác nhận chốt chỉ số' })).toBeNull();
  expect(screen.getByText(/Chờ máy chủ kiểm tra ảnh\/clip gốc đọc được/)).toBeTruthy();
  expect(api.confirm).not.toHaveBeenCalled();
});

it('never confirms without explicit evidence acknowledgement and sends the current version', async () => {
  const changed = vi.fn().mockResolvedValue(undefined);
  api.confirm.mockResolvedValue({ ...capture, status: 'CONFIRMED' });
  render(<MeterCaptureReview capture={capture} onChanged={changed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xem / xác nhận' }));
  const confirm = screen.getByRole('button', { name: 'Xác nhận chốt chỉ số' });
  expect(confirm.hasAttribute('disabled')).toBe(true);
  expect(api.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(confirm);
  await waitFor(() => expect(api.confirm).toHaveBeenCalledWith({ orgId: 'org-a', captureId: 'capture-a', expectedVersion: 3, expectedPreviousValue: '110.25', value: '120.25', reason: undefined }));
  expect(changed).toHaveBeenCalledOnce();
});

it('requires a reason when OCR and AI disagree and retains the form on concurrency failure', async () => {
  api.confirm.mockRejectedValue(new Error('Chỉ số đã thay đổi. Tải lại.'));
  render(<MeterCaptureReview capture={{ ...capture, issues: ['Hai bộ đọc khác nhau'] }} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xem / xác nhận' }));
  fireEvent.click(screen.getByRole('checkbox'));
  const confirm = screen.getByRole('button', { name: 'Xác nhận chốt chỉ số' });
  expect(confirm.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText(/Lý do xác nhận/), { target: { value: 'Đối chiếu ảnh gốc' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('đã thay đổi'));
  expect(screen.getByLabelText('Chỉ số xác nhận (kWh)')).toBeTruthy();
});

it('shows the stored baseline and allows an explicitly verified zero-usage capture', async () => {
  api.confirm.mockResolvedValue({ ...capture, status: 'CONFIRMED' });
  render(<MeterCaptureReview capture={{ ...capture, previousValue: '120.25' }} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xem / xác nhận' }));
  expect(screen.getByText('0 kWh')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chốt chỉ số' }));
  await waitFor(() => expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ value: '120.25', reason: undefined })));
});

it('requires review for a decrease without substituting the stored reading for the proposed value', () => {
  render(<MeterCaptureReview capture={{ ...capture, previousValue: '125.25' }} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xem / xác nhận' }));
  expect(screen.getByRole('alert').textContent).toContain('nhỏ hơn chỉ số trước');
  expect((screen.getByLabelText('Chỉ số xác nhận (kWh)') as HTMLInputElement).value).toBe('120.25');
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('button', { name: 'Xác nhận chốt chỉ số' }).hasAttribute('disabled')).toBe(true);
  expect(api.confirm).not.toHaveBeenCalled();
});

it('keeps confirmed evidence read-only even when an engine result is different', () => {
  render(<MeterCaptureReview capture={{ ...capture, status: 'CONFIRMED', aiResult: { ...capture.aiResult!, value: '999.99' } }} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xem / xác nhận' }));
  expect(screen.queryByRole('button', { name: 'Xác nhận chốt chỉ số' })).toBeNull();
  expect(screen.getByText('Chỉ số đã chốt: 120.25 kWh')).toBeTruthy();
  expect(api.confirm).not.toHaveBeenCalled();
});


it('requires an explicit replacement acknowledgement and reason, and submits both baseline and target versions', async () => {
  api.confirm.mockResolvedValue({ ...capture, status: 'CONFIRMED' });
  render(<MeterCaptureReview capture={{ ...capture, replacement: { id: 'old-capture', version: 6, value: '119.25' } }} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xem / xác nhận' }));
  expect(screen.getByText(/Ngày này đã chốt 119.25 kWh/)).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: /Tôi đã đối chiếu/ }));
  fireEvent.change(screen.getByLabelText(/Lý do xác nhận/), { target: { value: 'Bản trước đọc nhầm chữ số; kiểm tra lại clip gốc' } });
  expect(screen.getByRole('button', { name: 'Xác nhận chốt chỉ số' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /Tôi xác nhận thay thế/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận chốt chỉ số' }));
  await waitFor(() => expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ expectedPreviousValue: '110.25', supersedesCaptureId: 'old-capture', expectedSupersededVersion: 6 })));
});

it('requires acknowledgement again when polling changes the displayed baseline without changing capture version', () => {
  const changed = vi.fn();
  const view = render(<MeterCaptureReview capture={capture} onChanged={changed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xem / xác nhận' }));
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('button', { name: 'Xác nhận chốt chỉ số' }).hasAttribute('disabled')).toBe(false);
  view.rerender(<MeterCaptureReview capture={{ ...capture, previousValue: '115.25' }} onChanged={changed} />);
  expect(screen.getByRole('button', { name: 'Xác nhận chốt chỉ số' }).hasAttribute('disabled')).toBe(true);
  expect(api.confirm).not.toHaveBeenCalled();
});
