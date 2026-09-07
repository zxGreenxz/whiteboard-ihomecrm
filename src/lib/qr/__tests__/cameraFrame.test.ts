import { describe, expect, it } from 'vitest';
import { mapObjectCoverRectToVideo, nextCameraScan } from '../cameraFrame';

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
