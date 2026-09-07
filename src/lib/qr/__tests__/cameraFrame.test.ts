import { describe, expect, it, vi } from 'vitest';
import {
  mapObjectCoverRectToVideo,
  measureLaplacianSharpness,
  nextCameraScan,
  selectSharpCameraFrame,
} from '../cameraFrame';

describe('camera frame geometry', () => {
  it('maps a square portrait container through landscape object-cover cropping', () => {
    expect(mapObjectCoverRectToVideo(
      { width: 1920, height: 1080 },
      { width: 360, height: 640 },
      { x: 50, y: 190, width: 260, height: 260 },
    )).toEqual({ x: 741, y: 321, width: 439, height: 439 });
  });

  it('maps a landscape container through portrait object-cover cropping', () => {
    expect(mapObjectCoverRectToVideo(
      { width: 1080, height: 1920 },
      { width: 640, height: 360 },
      { x: 190, y: 50, width: 260, height: 260 },
    )).toEqual({ x: 321, y: 741, width: 439, height: 439 });
  });

  it('recomputes the source ROI after a container resize', () => {
    expect(mapObjectCoverRectToVideo(
      { width: 1920, height: 1080 },
      { width: 720, height: 720 },
      { x: 100, y: 100, width: 520, height: 520 },
    )).toEqual({ x: 570, y: 150, width: 780, height: 780 });
  });
});

describe('camera scan cadence', () => {
  it('uses fast ROI scans until the measured deep interval is due', () => {
    expect(nextCameraScan(899, 0, false)).toEqual({ mode: 'camera-fast', fullFrame: false, budgetMs: 250 });
  });

  it('alternates deep ROI and full-frame scans without changing the deep budget', () => {
    expect(nextCameraScan(900, 0, false)).toEqual({ mode: 'camera-deep', fullFrame: false, budgetMs: 1500 });
    expect(nextCameraScan(1800, 900, true)).toEqual({ mode: 'camera-deep', fullFrame: true, budgetMs: 1500 });
  });
});

function bitmap(name: string) {
  return { name, width: 16, height: 16, close: vi.fn() } as unknown as ImageBitmap & { name: string };
}

describe('bounded sharp-frame selection', () => {
  it('measures crisp alternating edges above a flat or gradual frame', () => {
    const rgba = (values: number[]) => new Uint8ClampedArray(values.flatMap((value) => [value, value, value, 255]));
    const flat = rgba(Array(25).fill(120));
    const gradual = rgba(Array.from({ length: 25 }, (_, index) => index * 8));
    const crisp = rgba(Array.from({ length: 25 }, (_, index) => (index + Math.floor(index / 5)) % 2 ? 255 : 0));
    expect(measureLaplacianSharpness(crisp, 5, 5)).toBeGreaterThan(measureLaplacianSharpness(gradual, 5, 5));
    expect(measureLaplacianSharpness(gradual, 5, 5)).toBeGreaterThanOrEqual(measureLaplacianSharpness(flat, 5, 5));
  });

  it('retains only the sharpest bounded candidate and closes every discarded bitmap', async () => {
    const blurred = bitmap('blurred');
    const sharp = bitmap('sharp');
    const middling = bitmap('middling');
    const candidates = [blurred, sharp, middling];
    const selected = await selectSharpCameraFrame(
      async () => candidates.shift()!,
      { samples: 3, intervalMs: 0, score: (candidate) => ({ blurred: 1, sharp: 9, middling: 4 })[(candidate as typeof blurred).name] ?? 0 },
    );
    expect(selected).toBe(sharp);
    expect(blurred.close).toHaveBeenCalledTimes(1);
    expect(middling.close).toHaveBeenCalledTimes(1);
    expect(sharp.close).not.toHaveBeenCalled();
  });

  it('closes the retained candidate when selection is cancelled', async () => {
    vi.useFakeTimers();
    const retained = bitmap('retained');
    const controller = new AbortController();
    const selecting = selectSharpCameraFrame(async () => retained, {
      samples: 3,
      intervalMs: 50,
      signal: controller.signal,
      score: () => 1,
    });
    await Promise.resolve();
    controller.abort();
    await expect(selecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(retained.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
