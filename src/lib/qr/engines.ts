import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import type { Candidate, Point, QrMode, WorkerScanSource } from './types';

type NativeBarcode = { rawValue: string; cornerPoints?: Point[] };
type NativeDetector = { detect(source: ImageBitmapSource): Promise<NativeBarcode[]> };
type NativeDetectorCtor = {
  new (options?: { formats?: string[] }): NativeDetector;
  getSupportedFormats?: () => Promise<string[]>;
};

let nativeDetectorPromise: Promise<NativeDetector | null> | null = null;

function nativeDetector(): Promise<NativeDetector | null> {
  if (nativeDetectorPromise) return nativeDetectorPromise;
  nativeDetectorPromise = (async () => {
    const Ctor = (globalThis as typeof globalThis & { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
    if (!Ctor) return null;
    const formats = Ctor.getSupportedFormats ? await Ctor.getSupportedFormats() : ['qr_code'];
    if (!formats.includes('qr_code')) return null;
    return new Ctor({ formats: ['qr_code'] });
  })().catch((error) => {
    nativeDetectorPromise = null;
    throw error;
  });
  return nativeDetectorPromise;
}

export async function scanNative(source: ImageBitmap): Promise<Candidate[]> {
  const detector = await nativeDetector();
  if (!detector) return [];
  const results = await detector.detect(source);
  return results.filter((result) => result.rawValue).map((result) => ({
    text: result.rawValue,
    engine: 'native' as const,
    corners: result.cornerPoints?.length === 4
      ? result.cornerPoints as [Point, Point, Point, Point]
      : undefined,
  }));
}

let zxingInitPromise: Promise<void> | null = null;

export async function initializeZxing(): Promise<void> {
  if (zxingInitPromise) return zxingInitPromise;
  zxingInitPromise = import('zxing-wasm/reader').then(async ({ prepareZXingModule }) => {
    await prepareZXingModule({
      overrides: { locateFile: (name, prefix) => name.endsWith('.wasm') ? wasmUrl : prefix + name },
      fireImmediately: true,
    });
  }).catch((error) => {
    zxingInitPromise = null;
    throw error;
  });
  return zxingInitPromise;
}

export async function scanZxing(source: Blob | ArrayBuffer | ImageData): Promise<Candidate[]> {
  await initializeZxing();
  const { readBarcodes } = await import('zxing-wasm/reader');
  const results = await readBarcodes(source, {
    formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: true,
    tryDownscale: true, maxNumberOfSymbols: 4, textMode: 'Plain', returnErrors: false,
  });
  return results.filter((result) => result.isValid && result.text).map((result) => ({
    text: result.text,
    engine: 'zxing-wasm' as const,
    corners: [result.position.topLeft, result.position.topRight,
      result.position.bottomRight, result.position.bottomLeft],
  }));
}

export class QrImageError extends Error {}
const MAX_DECODE_PIXELS = 24_000_000;

async function bitmapToImageData(bitmap: ImageBitmap): Promise<ImageData> {
  if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_DECODE_PIXELS) {
    throw new QrImageError('Image dimensions exceed the QR decoder limit');
  }
  if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas unavailable');
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D canvas unavailable');
  try {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally { canvas.width = canvas.height = 0; }
}

export async function sourceToImageData(source: WorkerScanSource): Promise<ImageData> {
  if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
    if (!source.width || !source.height || source.width * source.height > MAX_DECODE_PIXELS) throw new QrImageError('Image dimensions exceed the QR decoder limit');
    return source;
  }
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return bitmapToImageData(source);
  if (source instanceof Blob) {
    if (source.size > 20 * 1024 * 1024) throw new QrImageError('Image file exceeds the QR decoder limit');
    const bitmap = await createImageBitmap(source);
    try { return await bitmapToImageData(bitmap); } finally { bitmap.close(); }
  }
  if (source instanceof ArrayBuffer) return sourceToImageData(new Blob([source]));
  throw new QrImageError('Unsupported image source');
}

export async function scanWithWorkerEngines(source: WorkerScanSource, _mode: QrMode): Promise<Candidate[]> {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    if (!source.width || !source.height || source.width * source.height > MAX_DECODE_PIXELS) throw new QrImageError('Image dimensions exceed the QR decoder limit');
    try {
      const native = await scanNative(source);
      if (native.length) return native;
    } catch { /* WASM remains authoritative fallback. */ }
    const image = await bitmapToImageData(source);
    return scanZxing(image);
  }
  if (source instanceof Blob || source instanceof ArrayBuffer) {
    const blob = source instanceof Blob ? source : new Blob([source]);
    if (blob.size > 20 * 1024 * 1024) throw new QrImageError('Image file exceeds the QR decoder limit');
    const bitmap = await createImageBitmap(blob);
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_DECODE_PIXELS) throw new QrImageError('Image dimensions exceed the QR decoder limit');
      try {
        const native = await scanNative(bitmap);
        if (native.length) return native;
      } catch { /* WASM remains authoritative fallback. */ }
      const image = await bitmapToImageData(bitmap);
      return scanZxing(image);
    } finally { bitmap.close(); }
  }
  const image = await sourceToImageData(source);
  return scanZxing(image);
}
