import { afterEach, describe, expect, it, vi } from 'vitest';
import QRCode from 'qrcode';
import { readFile } from 'node:fs/promises';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('native QR engine availability', () => {
  it('shares one pending supported-formats check across concurrent callers', async () => {
    let release!: (formats: string[]) => void;
    const formats = new Promise<string[]>((resolve) => { release = resolve; });
    const getSupportedFormats = vi.fn(() => formats);
    const detect = vi.fn(async () => [{ rawValue: 'native', cornerPoints: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }] }]);
    vi.stubGlobal('BarcodeDetector', class { static getSupportedFormats = getSupportedFormats; detect = detect; });
    const { scanNative } = await import('../engines');
    const source = {} as ImageBitmap;
    const one = scanNative(source);
    const two = scanNative(source);
    release(['qr_code']);
    await expect(Promise.all([one, two])).resolves.toEqual([
      [{ text: 'native', engine: 'native', corners: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }] }],
      [{ text: 'native', engine: 'native', corners: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }] }],
    ]);
    expect(getSupportedFormats).toHaveBeenCalledOnce();
  });

  it('does not construct a detector when qr_code is unsupported', async () => {
    const constructor = vi.fn();
    vi.stubGlobal('BarcodeDetector', class { static async getSupportedFormats() { return ['code_128']; } constructor() { constructor(); } });
    const { scanNative } = await import('../engines');
    await expect(scanNative({} as ImageBitmap)).resolves.toEqual([]);
    expect(constructor).not.toHaveBeenCalled();
  });

  it.each(['hit', 'miss'] as const)('rejects an oversized bitmap before a native %s', async (outcome) => {
    const detect = vi.fn(async () => outcome === 'hit' ? [{ rawValue: 'oversized' }] : []);
    vi.stubGlobal('ImageBitmap', class {});
    vi.stubGlobal('BarcodeDetector', class { static async getSupportedFormats() { return ['qr_code']; } detect = detect; });
    const { QrImageError, scanWithWorkerEngines } = await import('../engines');
    const bitmap = Object.assign(new ImageBitmap(), { width: 8000, height: 6000, close: vi.fn() });
    await expect(scanWithWorkerEngines(bitmap, 'image')).rejects.toBeInstanceOf(QrImageError);
    expect(detect).not.toHaveBeenCalled();
  });
});

describe('ZXing WASM engine', () => {
  it('decodes an independently generated synthetic QR raster', async () => {
    const wasm = await readFile(new URL('../../../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url));
    vi.stubGlobal('fetch', async () => new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } }));
    const payload = '001099999999|TASK2|ZXING-WASM';
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const quiet = 4;
    const scale = 5;
    const size = (qr.modules.size + quiet * 2) * scale;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < qr.modules.size; y++) for (let x = 0; x < qr.modules.size; x++) {
      if (!qr.modules.get(x, y)) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const offset = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
      }
    }
    vi.stubGlobal('BarcodeDetector', undefined);
    vi.stubGlobal('OffscreenCanvas', undefined);
    class SyntheticImageData { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} }
    vi.stubGlobal('ImageData', SyntheticImageData);
    const { scanWithWorkerEngines } = await import('../engines');
    await expect(scanWithWorkerEngines(new SyntheticImageData(pixels, size, size) as ImageData, 'image'))
      .resolves.toMatchObject([{ text: payload, engine: 'zxing-wasm' }]);
  });
});
