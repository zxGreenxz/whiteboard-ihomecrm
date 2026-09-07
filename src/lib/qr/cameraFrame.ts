import type { QrMode, Roi } from './types';

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type CameraScanPlan = { mode: QrMode; fullFrame: boolean; budgetMs: number };

export const CAMERA_FAST_BUDGET_MS = 250;
export const CAMERA_DEEP_BUDGET_MS = 1500;
export const CAMERA_DEEP_INTERVAL_MS = 900;
export const CAMERA_SHARP_SAMPLES = 3;
export const CAMERA_SHARP_SAMPLE_INTERVAL_MS = 70;

function boundedRound(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

/** Maps a visible rectangle back to source pixels for a centered object-cover video. */
export function mapObjectCoverRectToVideo(
  video: Size,
  container: Size,
  visible: Rect,
): Roi {
  if (video.width <= 0 || video.height <= 0 || container.width <= 0 || container.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.max(container.width / video.width, container.height / video.height);
  const croppedX = (video.width * scale - container.width) / 2;
  const croppedY = (video.height * scale - container.height) / 2;
  const x = boundedRound((visible.x + croppedX) / scale, 0, video.width);
  const y = boundedRound((visible.y + croppedY) / scale, 0, video.height);
  const width = boundedRound(visible.width / scale, 0, video.width - x);
  const height = boundedRound(visible.height / scale, 0, video.height - y);
  return { x, y, width, height };
}

export function nextCameraScan(
  now: number,
  lastDeepAt: number,
  fullFrame: boolean,
): CameraScanPlan {
  if (now - lastDeepAt >= CAMERA_DEEP_INTERVAL_MS) {
    return { mode: 'camera-deep', fullFrame, budgetMs: CAMERA_DEEP_BUDGET_MS };
  }
  return { mode: 'camera-fast', fullFrame: false, budgetMs: CAMERA_FAST_BUDGET_MS };
}

export async function captureVideoBitmap(
  video: HTMLVideoElement,
  container: HTMLElement,
  fullFrame: boolean,
): Promise<ImageBitmap> {
  if (fullFrame) return createImageBitmap(video);
  const bounds = container.getBoundingClientRect();
  const side = Math.min(bounds.width, bounds.height) * 0.72;
  const roi = mapObjectCoverRectToVideo(
    { width: video.videoWidth, height: video.videoHeight },
    { width: bounds.width, height: bounds.height },
    { x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side },
  );
  if (!roi.width || !roi.height) throw new Error('Camera frame is not ready');
  return createImageBitmap(video, roi.x, roi.y, roi.width, roi.height);
}

export function measureLaplacianSharpness(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3 || rgba.length < width * height * 4) return 0;
  const gray = (pixel: number) => {
    const offset = pixel * 4;
    return rgba[offset]! * 0.299 + rgba[offset + 1]! * 0.587 + rgba[offset + 2]! * 0.114;
  };
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x;
      const laplacian = gray(pixel) * 4
        - gray(pixel - 1)
        - gray(pixel + 1)
        - gray(pixel - width)
        - gray(pixel + width);
      sum += laplacian;
      squares += laplacian * laplacian;
      count += 1;
    }
  }
  const mean = sum / count;
  return squares / count - mean * mean;
}

export function measureBitmapSharpness(bitmap: ImageBitmap): number {
  const maximum = 96;
  const scale = Math.min(1, maximum / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(3, Math.round(bitmap.width * scale));
  const height = Math.max(3, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return 0;
  context.drawImage(bitmap, 0, 0, width, height);
  return measureLaplacianSharpness(context.getImageData(0, 0, width, height).data, width, height);
}

type SharpFrameOptions = {
  samples?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  score?: (bitmap: ImageBitmap) => number | Promise<number>;
};

function aborted(): DOMException {
  return new DOMException('Camera frame selection cancelled', 'AbortError');
}

function waitForCandidate(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(aborted());
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** Samples at most three current frames and owns every bitmap except the returned winner. */
export async function selectSharpCameraFrame(
  capture: () => Promise<ImageBitmap>,
  options: SharpFrameOptions = {},
): Promise<ImageBitmap> {
  const samples = Math.min(CAMERA_SHARP_SAMPLES, Math.max(1, options.samples ?? CAMERA_SHARP_SAMPLES));
  const intervalMs = Math.max(0, options.intervalMs ?? CAMERA_SHARP_SAMPLE_INTERVAL_MS);
  const score = options.score ?? measureBitmapSharpness;
  let retained: { bitmap: ImageBitmap; score: number } | null = null;
  try {
    for (let index = 0; index < samples; index += 1) {
      if (options.signal?.aborted) throw aborted();
      const candidate = await capture();
      if (options.signal?.aborted) { candidate.close(); throw aborted(); }
      let candidateScore: number;
      try { candidateScore = await score(candidate); }
      catch (error) { candidate.close(); throw error; }
      if (options.signal?.aborted) { candidate.close(); throw aborted(); }
      if (!retained || candidateScore > retained.score) {
        retained?.bitmap.close();
        retained = { bitmap: candidate, score: candidateScore };
      } else {
        candidate.close();
      }
      if (index + 1 < samples) await waitForCandidate(intervalMs, options.signal);
    }
    if (!retained) throw new Error('No camera frame was captured');
    const selected = retained.bitmap;
    retained = null;
    return selected;
  } catch (error) {
    retained?.bitmap.close();
    throw error;
  }
}

export function captureFullFrameFile(video: HTMLVideoElement): Promise<File> {
  if (!video.videoWidth || !video.videoHeight) return Promise.reject(new Error('Camera frame is not ready'));
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('Không thể chụp khung hình camera'));
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('Không thể chụp khung hình camera')); return; }
      resolve(new File([blob], 'cccd-camera.jpg', { type: 'image/jpeg', lastModified: Date.now() }));
    }, 'image/jpeg', 0.95);
  });
}
