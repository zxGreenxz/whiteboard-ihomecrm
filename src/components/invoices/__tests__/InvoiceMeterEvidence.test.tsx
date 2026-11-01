// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const api = vi.hoisted(() => ({ read: vi.fn(), org: 'org-a' }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: api.org }) }));
vi.mock('@/lib/meter-capture/service', () => ({ readDocumentEvidence: api.read }));
vi.mock('@/components/meter-readings/MeterEvidenceThumb', () => ({ MeterEvidenceThumb: ({ captureId, label }: { captureId?: string | null; label: string }) => captureId ? <button data-capture={captureId}>{label}</button> : null }));
import { InvoiceMeterEvidence } from '../InvoiceMeterEvidence';
function show(invoiceId = 'invoice-a') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><InvoiceMeterEvidence invoiceId={invoiceId} /></QueryClientProvider>);
}
beforeEach(() => { api.org = 'org-a'; vi.clearAllMocks(); });
afterEach(cleanup);
it('loads authenticated evidence only on request and binds both endpoints of the saved invoice', async () => {
  api.read.mockResolvedValue([
    { meterId: 'm1', meterName: 'Điện chính', startCaptureId: 'old-photo', endCaptureId: 'clip-frame', previousReading: '120.25', currentReading: '120.25' },
    { meterId: 'm2', meterName: 'Điện phụ', startCaptureId: null, endCaptureId: 'other-photo', previousReading: '50', currentReading: '80' },
  ]);
  show(); expect(api.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Xem ảnh / clip đồng hồ' }));
  await waitFor(() => expect(api.read).toHaveBeenCalledWith('org-a', 'invoice-a'));
  expect(await screen.findByText('Điện chính')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ảnh số đầu Điện chính' }).getAttribute('data-capture')).toBe('old-photo');
  expect(screen.getByRole('button', { name: 'Ảnh số cuối Điện chính' }).getAttribute('data-capture')).toBe('clip-frame');
  expect(screen.getByRole('button', { name: 'Ảnh số cuối Điện phụ' }).getAttribute('data-capture')).toBe('other-photo');
  expect(screen.queryByRole('button', { name: 'Ảnh số đầu Điện phụ' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Chứng cứ chỉ số nội bộ' }).className).toContain('print:hidden');
});
it('distinguishes unavailable evidence from an empty attachment list', async () => {
  api.read.mockRejectedValue(new Error('access denied'));
  show(); fireEvent.click(screen.getByRole('button', { name: 'Xem ảnh / clip đồng hồ' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Không tải được chứng cứ'));
  expect(screen.queryByText('Hóa đơn này chưa có chỉ số liên kết ảnh/clip.')).toBeNull();
});
