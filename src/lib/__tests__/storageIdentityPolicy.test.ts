import { createRequire } from 'node:module';
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import QRCode from 'qrcode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  upload: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: storage.upload,
        getPublicUrl: (path: string) => ({ data: { publicUrl: `stored:${path}` } }),
      }),
    },
  },
}));

vi.mock('../signedUrlBatcher', () => ({ createSignedUrlBatched: vi.fn() }));
vi.mock('../storage/r2Client', () => ({ uploadToR2: vi.fn(), signR2: vi.fn() }));

import { uploadFile } from '../storage';

interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

interface PngCodec {
  new (options: { width: number; height: number }): PngImage;
  sync: {
    read(bytes: Buffer): PngImage;
    write(image: PngImage, options?: { deflateLevel?: number }): Buffer;
  };
}

const nodeRequire = createRequire(import.meta.url);
const { PNG } = nodeRequire('pngjs') as { PNG: PngCodec };
const PAYLOAD = '001099999993||NGUYEN TEST STORAGE|01011990|Nam|Dia chi gia|01012024';

function makeCardWithSmallQr(): Buffer {
  const width = 800;
  const height = 500;
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = 245;
    image.data[offset + 1] = 245;
    image.data[offset + 2] = 245;
    image.data[offset + 3] = 255;
  }

  const qr = QRCode.create(PAYLOAD, { errorCorrectionLevel: 'M' });
  const quiet = 4;
  const scale = 5;
  const qrSize = (qr.modules.size + quiet * 2) * scale;
  const left = width - qrSize - 36;
  const top = height - qrSize - 36;
  for (let y = 0; y < qrSize; y += 1) {
    for (let x = 0; x < qrSize; x += 1) {
      const moduleX = Math.floor(x / scale) - quiet;
      const moduleY = Math.floor(y / scale) - quiet;
      const dark = moduleX >= 0
        && moduleY >= 0
        && moduleX < qr.modules.size
        && moduleY < qr.modules.size
        && qr.modules.get(moduleX, moduleY);
      const value = dark ? 0 : 255;
      const offset = ((top + y) * width + left + x) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(image, { deflateLevel: 0 });
}

function decodeQr(pngBytes: Uint8Array): string {
  const image = PNG.sync.read(Buffer.from(pngBytes));
  const luminance = new Uint8ClampedArray(image.width * image.height);
  for (let pixel = 0; pixel < luminance.length; pixel += 1) {
    const offset = pixel * 4;
    luminance[pixel] = Math.round(
      image.data[offset] * 0.299
      + image.data[offset + 1] * 0.587
      + image.data[offset + 2] * 0.114,
    );
  }
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(luminance, image.width, image.height)),
  );
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  return new MultiFormatReader().decode(bitmap, hints).getText();
}

function installBeneficialCompression(): void {
  vi.stubGlobal('createImageBitmap', async () => ({ width: 800, height: 500, close() {} }));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() {
      return { drawImage() {} };
    }
    async convertToBlob() {
      return new Blob([new Uint8Array([8, 2, 1])], { type: 'image/webp' });
    }
  });
}

describe('uploadFile image policy', () => {
  beforeEach(() => {
    storage.upload.mockReset();
    storage.upload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores a decodable identity card image byte-for-byte even when compression would be beneficial', async () => {
    installBeneficialCompression();
    const originalBytes = makeCardWithSmallQr();
    expect(originalBytes.byteLength).toBeGreaterThan(200 * 1024);
    expect(decodeQr(originalBytes)).toBe(PAYLOAD);
    const original = new File([originalBytes], 'cccd-front.png', { type: 'image/png' });

    await uploadFile(
      'customer-images',
      'customer/cccd-front.png',
      original,
      { imagePolicy: 'identity-original' },
    );

    const [uploadedPath, uploadedFile] = storage.upload.mock.calls[0] as [string, File];
    const uploadedBytes = new Uint8Array(await uploadedFile.arrayBuffer());
    expect(uploadedPath).toBe('customer/cccd-front.png');
    expect(uploadedFile.type).toBe('image/png');
    expect(uploadedBytes.byteLength).toBe(originalBytes.byteLength);
    // Compare every byte natively: deep equality enumerates this 1.6 MB array
    // in JavaScript and can exhaust the unchanged 5-second CI test deadline.
    expect(Buffer.from(uploadedBytes.buffer, uploadedBytes.byteOffset, uploadedBytes.byteLength).equals(originalBytes)).toBe(true);
    expect(decodeQr(uploadedBytes)).toBe(PAYLOAD);
  });

  it('keeps the existing compression behavior when callers omit options', async () => {
    installBeneficialCompression();
    const original = new File(
      [new Uint8Array(300 * 1024)],
      'room-photo.png',
      { type: 'image/png' },
    );

    await uploadFile('room-images', 'room/room-photo.png', original);

    const [uploadedPath, uploadedFile] = storage.upload.mock.calls[0] as [string, File];
    expect(uploadedPath).toBe('room/room-photo.webp');
    expect(uploadedFile.type).toBe('image/webp');
    expect(new Uint8Array(await uploadedFile.arrayBuffer())).toEqual(new Uint8Array([8, 2, 1]));
  });

  it.each([
    ['a non-image payload', new File(['not an image'], 'identity.pdf', { type: 'application/pdf' })],
    [
      'an oversized image',
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'identity.png', { type: 'image/png' }),
    ],
  ])('rejects %s instead of resizing it under identity-original', async (_case, file) => {
    await expect(uploadFile(
      'customer-images',
      `customer/${file.name}`,
      file,
      { imagePolicy: 'identity-original' },
    )).rejects.toThrow();
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
