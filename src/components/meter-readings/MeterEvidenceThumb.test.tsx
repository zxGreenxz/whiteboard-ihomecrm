// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ evidence: vi.fn() }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/hooks/useSignedUrl', () => ({ useSignedUrl: (url?: string | null) => url }));
vi.mock('@/lib/meter-capture/service', () => ({ readMeterEvidence: api.evidence }));
vi.mock('@/components/ui/storage-image', () => ({ StorageImage: ({ value, alt }: { value?: string | null; alt: string }) => <img src={value ?? undefined} alt={alt} /> }));
import { MeterEvidenceThumb } from './MeterEvidenceThumb';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MeterEvidenceThumb captureId="capture-a" label="Ảnh số cuối đồng hồ A" /></QueryClientProvider>);
}

it('opens the approved capture evidence from invoice or settlement and seeks the selected frame', async () => {
  api.evidence.mockResolvedValue({ captureId: 'capture-a', imageUrl: '/private/frame-6', videoUrl: '/private/clip', timestampSeconds: 6,
    evidenceFrames: [{ imageUrl: '/private/frame-6', timestampSeconds: 6 }, { imageUrl: '/private/frame-8', timestampSeconds: 8 }] });
  const view = show();
  await waitFor(() => expect(api.evidence).toHaveBeenCalledWith('org-a', 'capture-a'));
  fireEvent.click(screen.getByRole('button', { name: 'Mở ảnh số cuối đồng hồ a' }));
  await screen.findByRole('button', { name: 'Ảnh tại 0:08.0' });
  expect(view.container.querySelector('video')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ảnh tại 0:08.0' }));
  fireEvent.click(screen.getByRole('button', { name: 'Xem clip tại 0:08.0' }));
  const video = screen.getByLabelText('Clip đối chiếu đồng hồ') as HTMLVideoElement;
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(8);
  expect(screen.getByRole('heading', { name: 'Ảnh số cuối đồng hồ A · Nội bộ' })).toBeTruthy();
});

it('shows a recoverable evidence error instead of treating inaccessible media as absent', async () => {
  api.evidence.mockRejectedValue(new Error('permission denied'));
  show();
  await screen.findByText('Lỗi ảnh');
  fireEvent.click(screen.getByRole('button', { name: 'Mở ảnh số cuối đồng hồ a' }));
  expect(screen.getByRole('alert').textContent).toContain('Không tải được chứng cứ');
  expect(screen.queryByLabelText('Clip đối chiếu đồng hồ')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  await waitFor(() => expect(api.evidence).toHaveBeenCalledTimes(2));
});
