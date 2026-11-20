// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DetailSheet } from '../PhongTrongSheet';
import { SAMPLE_BUILDINGS } from '../sampleData';

afterEach(() => vi.unstubAllGlobals());

it('shows videos before the original photos and only prefetches photos for sharing', () => {
  const fetchFile = vi.fn().mockResolvedValue(new Response(new Blob(['photo'], { type: 'image/jpeg' })));
  vi.stubGlobal('fetch', fetchFile);
  const photos = ['/cover.jpg', '/detail.jpg'];
  const video = '/tour.MP4?version=2';
  const room = { ...SAMPLE_BUILDINGS[0].rooms[0], images: [photos[0], video, photos[1]] };
  const props = { room, buildings: SAMPLE_BUILDINGS, onClose: vi.fn(), onToast: vi.fn(), saved: [], toggleSave: vi.fn(), onGo: vi.fn() };
  const { container, rerender } = render(<DetailSheet {...props} show />);
  const items = [...container.querySelectorAll('.gallery video, .gallery img')];
  expect(items.map(item => item.getAttribute('src'))).toEqual([video, ...photos]);
  expect(items[0].tagName).toBe('VIDEO');
  expect(items[0].hasAttribute('controls')).toBe(true);
  expect(fetchFile.mock.calls.map(([url]) => url)).toEqual(photos);
  fireEvent.click(items[1]);
  expect(container.querySelector('.lb-slide video')).toBeTruthy();
  rerender(<DetailSheet {...props} show={false} />);
  expect(container.querySelector('video')).toBeNull();
});
