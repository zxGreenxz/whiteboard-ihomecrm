// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/hooks/useSignedUrl', () => ({ useSignedUrl: (url?: string | null) => url }));
vi.mock('@/components/ui/storage-image', () => ({ StorageImage: ({ value, alt }: { value?: string | null; alt: string }) => <img src={value ?? undefined} alt={alt} /> }));
import { MeterEvidenceViewer } from './MeterEvidenceViewer';

const frames = [{ imageUrl: '/private/frame-4', timestampSeconds: 4.2 }, { imageUrl: '/private/frame-9', timestampSeconds: 9.6 }];
afterEach(cleanup);

it('lets the manager compare distinct full frames and opens the clip at the selected timestamp', () => {
  const view = render(<MeterEvidenceViewer imageUrl={frames[0].imageUrl} videoUrl="/private/clip" evidenceFrames={frames} />);
  expect(view.container.querySelector('video')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ảnh tại 0:09.6' }));
  expect(screen.getByAltText('Ảnh đối chiếu đồng hồ nội bộ').getAttribute('src')).toBe('/private/frame-9');
  fireEvent.click(screen.getByRole('button', { name: 'Xem clip tại 0:09.6' }));
  const video = screen.getByLabelText('Clip đối chiếu đồng hồ') as HTMLVideoElement;
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(9.6);
  expect(video.getAttribute('src')).toBe('/private/clip');
  fireEvent.click(screen.getByRole('button', { name: 'Ảnh tại 0:04.2' }));
  expect(view.container.querySelector('video')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Xem clip tại 0:04.2' }));
  const earlier = screen.getByLabelText('Clip đối chiếu đồng hồ') as HTMLVideoElement;
  fireEvent.loadedMetadata(earlier);
  expect(earlier.currentTime).toBe(4.2);
});

it('uses the approved evidence timestamp for an existing invoice without multiple frames', () => {
  render(<MeterEvidenceViewer imageUrl="/private/image" videoUrl="/private/clip" timestampSeconds={12.4} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xem clip tại 0:12.4' }));
  const video = screen.getByLabelText('Clip đối chiếu đồng hồ') as HTMLVideoElement;
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(12.4);
});

it('shows only an image for a photo capture and limits evidence gallery to six frames', () => {
  const view = render(<MeterEvidenceViewer imageUrl="/private/photo" />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByAltText('Ảnh đối chiếu đồng hồ nội bộ').getAttribute('src')).toBe('/private/photo');
  view.rerender(<MeterEvidenceViewer evidenceFrames={Array.from({ length: 10 }, (_, index) => ({ imageUrl: `/private/${index}`, timestampSeconds: index }))} />);
  expect(screen.getAllByRole('button')).toHaveLength(6);
});
