import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from '@zxing/library';
import QRCode from 'qrcode';

const PAYLOAD = '000000000001|TEST01|Nguyễn An|01011990|Nam|Phường Thử Nghiệm|01012022';

function pixelsFor(payload: string, rgba: boolean) {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const quiet = 4;
  const scale = 5;
  const size = (qr.modules.size + quiet * 2) * scale;
  const channels = rgba ? 4 : 1;
  const pixels = new Uint8ClampedArray(size * size * channels).fill(255);
  for (let y = 0; y < qr.modules.size; y++) for (let x = 0; x < qr.modules.size; x++) {
    if (!qr.modules.get(x, y)) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const p = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * channels;
      pixels[p] = 0;
      if (rgba) pixels[p + 1] = pixels[p + 2] = 0;
    }
  }
  return { pixels, size };
}

function installCanvasGlobals(payload = PAYLOAD) {
  const { pixels, size } = pixelsFor(payload, true);
  class SyntheticImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(dataOrWidth: Uint8ClampedArray | number, width?: number, height?: number) {
      if (typeof dataOrWidth === 'number') {
        this.width = dataOrWidth;
        this.height = width ?? dataOrWidth;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else {
        this.data = dataOrWidth;
        this.width = width!;
        this.height = height!;
      }
    }
  }
  const imageData = new SyntheticImageData(pixels, size, size);
  const canvas = { width: size, height: size, getContext: () => ({ drawImage() {}, getImageData: () => imageData }) };
  vi.stubGlobal('window', {});
  vi.stubGlobal('HTMLVideoElement', class {});
  vi.stubGlobal('HTMLImageElement', class {});
  vi.stubGlobal('HTMLCanvasElement', class {});
  vi.stubGlobal('ImageBitmap', class {});
  vi.stubGlobal('ImageData', SyntheticImageData);
  vi.stubGlobal('document', { createElement: () => canvas });
  return canvas as unknown as HTMLCanvasElement;
}

afterEach(() => {
  vi.doUnmock('@zxing/library');
  vi.doUnmock('jsqr');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('legacy ZXing fixture', () => {
  it('real ZXing decodes the independently declared synthetic payload with QR hints', () => {
    const { pixels, size } = pixelsFor(PAYLOAD, false);
    const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, size, size)));
    const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]], [DecodeHintType.TRY_HARDER, true]]);
    expect(new MultiFormatReader().decode(bitmap, hints).getText()).toBe(PAYLOAD);
  });
});
