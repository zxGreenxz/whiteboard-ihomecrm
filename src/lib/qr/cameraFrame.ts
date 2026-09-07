import type { QrMode, Roi } from './types';

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type CameraScanPlan = { mode: QrMode; fullFrame: boolean; budgetMs: number };

export const CAMERA_FAST_BUDGET_MS = 250;
export const CAMERA_DEEP_BUDGET_MS = 1500;
export const CAMERA_DEEP_INTERVAL_MS = 900;

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
