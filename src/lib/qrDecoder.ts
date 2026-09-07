import { createQrScanner } from './qr/client';

type DecodeSource = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | ImageBitmap;
export interface Roi { x: number; y: number; width: number; height: number }

const scanner = createQrScanner();

async function firstCandidate(source: Blob | ImageBitmap, mode: 'image' | 'camera-fast') {
  const result = await scanner.scan(source, { mode, budgetMs: mode === 'image' ? 3000 : 100 });
  return result.status === 'decoded' ? result.candidates[0]?.text ?? null : null;
}

export async function decodeQr(source: DecodeSource): Promise<string | null> {
  try { return firstCandidate(await createImageBitmap(source), 'image'); }
  catch { return null; }
}

export async function decodeQrFromRoi(source: DecodeSource, roi: Roi): Promise<string | null> {
  const width = Math.max(1, Math.min(2048, Math.round(roi.width)));
  const height = Math.max(1, Math.min(2048, Math.round(roi.height)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(source, roi.x, roi.y, roi.width, roi.height, 0, 0, width, height);
  try { return firstCandidate(await createImageBitmap(canvas), 'camera-fast'); }
  catch { return null; }
}

export async function decodeQrFromFile(file: File): Promise<string | null> {
  if (file.size > 20 * 1024 * 1024) return null;
  return firstCandidate(file, 'image');
}
