import { createQrScanner } from '@/lib/qr/client';

export const MAX_CAPTURE_BYTES = 100 * 1024 * 1024;
export const MAX_CLIP_SECONDS = 60;
const ALLOWED_MEDIA = /^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime))$/;

export function validateCaptureMedia(file: Pick<Blob, 'size' | 'type'>, durationSeconds?: number): void {
  if (!file.size) throw new Error('Tệp trống. Chụp hoặc quay lại.');
  if (file.size > MAX_CAPTURE_BYTES) throw new Error('Ảnh/clip tối đa 100 MB.');
  if (!ALLOWED_MEDIA.test(file.type.split(';')[0])) throw new Error('Chọn ảnh JPEG/PNG/WebP hoặc clip MP4/WebM/MOV. Ảnh HEIC cần đổi sang JPEG trước khi gửi.');
  if (file.type.startsWith('video/') && durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_CLIP_SECONDS)) {
    throw new Error('Clip cần có thời lượng từ 1 đến 60 giây.');
  }
}

export async function sha256Media(file: Blob): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function singleCaptureQr(candidates: string[]): string | null {
  const unique = [...new Set(candidates)];
  if (unique.length > 1) throw new Error('Có nhiều mã QR trong ảnh/clip. Quay hoặc chụp riêng một đồng hồ.');
  return unique[0] ?? null;
}

async function loadVideo(file: Blob): Promise<{ video: HTMLVideoElement; dispose: () => void }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const dispose = () => { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); };
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Không mở được clip trên thiết bị. Chọn clip MP4 hoặc quay lại.')), 15000);
      video.onloadeddata = () => { clearTimeout(timeout); resolve(); };
      video.onerror = () => { clearTimeout(timeout); reject(new Error('Thiết bị không đọc được định dạng clip này.')); };
      video.src = url;
    });
    return { video, dispose };
  } catch (error) { dispose(); throw error; }
}

/** Browser hints never authorize identity: the server checks originals again. */
export async function inspectCaptureMedia(file: File, recordedDurationSeconds?: number): Promise<{ qrText: string | null; durationSeconds?: number }> {
  validateCaptureMedia(file);
  const scanner = createQrScanner();
  try {
    if (!file.type.startsWith('video/')) {
      const result = await scanner.scan(file, { mode: 'image', budgetMs: 3500 });
      return { qrText: result.status === 'decoded' ? singleCaptureQr(result.candidates.map(candidate => candidate.text)) : null };
    }
    const { video, dispose } = await loadVideo(file);
    try {
      // Browser-generated WebM may omit duration metadata. Recording duration is only
      // an admission hint; the server probes the original container independently.
      const duration = Number.isFinite(video.duration) ? video.duration : recordedDurationSeconds;
      if (duration === undefined) throw new Error('Không đọc được thời lượng clip. Quay lại trong web hoặc chọn clip MP4.');
      validateCaptureMedia(file, duration);
      const candidates: string[] = [];
      // The worker checks every sampled frame; browser preview is just a quick identification hint.
      for (const time of [0, Math.min(1, duration / 2), Math.max(0, duration - 0.2)]) {
        if (Math.abs(video.currentTime - time) > 0.01) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Không đọc được khung hình clip.')), 5000);
          video.onseeked = () => { clearTimeout(timer); resolve(); };
          video.currentTime = time;
        });
        const bitmap = await createImageBitmap(video);
        const result = await scanner.scan(bitmap, { mode: 'image', budgetMs: 2000 });
        if (result.status === 'decoded') candidates.push(...result.candidates.map(candidate => candidate.text));
      }
      return { qrText: singleCaptureQr(candidates), durationSeconds: duration };
    } finally { dispose(); }
  } finally { scanner.dispose(); }
}
