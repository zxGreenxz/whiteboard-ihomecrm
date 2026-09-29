import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyContractQrToClipboard,
  copyImageDataUrlToClipboard,
  dataUrlToBlob,
} from '../contractQrImage';

// PNG signature followed by binary boundary bytes: conversion must preserve both.
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoA/w==';
const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10, 0, 255];

class ClipboardItemDouble {
  constructor(readonly data: Record<string, Blob | Promise<Blob>>) {}
}

describe('contract QR clipboard', () => {
  let userActivation: boolean;
  let copiedImages: Blob[];

  beforeEach(() => {
    userActivation = true;
    copiedImages = [];
    // Production CSP permits data: images, but not fetch(data:) connections.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Blocked by connect-src'))));
    vi.stubGlobal('ClipboardItem', ClipboardItemDouble);
    vi.stubGlobal('window', {
      location: { origin: 'https://crm.example.test' },
      ClipboardItem: ClipboardItemDouble,
    });
    vi.stubGlobal('navigator', {
      clipboard: {
        write: async (items: ClipboardItemDouble[]) => {
          if (!userActivation) throw new DOMException('User activation expired', 'NotAllowedError');
          copiedImages = await Promise.all(items.map((item) => item.data['image/png']));
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('converts a PNG data URL without a CSP-blocked network request or byte loss', async () => {
    const blob = await dataUrlToBlob(PNG_DATA_URL);

    expect(blob.type).toBe('image/png');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(PNG_BYTES);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['https://crm.example.test/qr.png', 'data:image/png,not-base64'])(
    'rejects unsupported image input without fetching it: %s',
    async (input) => {
      await expect(dataUrlToBlob(input)).rejects.toThrow('Dữ liệu ảnh không hợp lệ');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('copies an existing QR while the click still has user activation', async () => {
    const copying = copyImageDataUrlToClipboard(PNG_DATA_URL);
    userActivation = false;
    await copying;

    expect(copiedImages).toHaveLength(1);
    expect(copiedImages[0].type).toBe('image/png');
    expect(Array.from(new Uint8Array(await copiedImages[0].arrayBuffer()))).toEqual(PNG_BYTES);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('starts clipboard writing before lazy QR generation finishes', async () => {
    const copying = copyContractQrToClipboard({ publicCode: 'contract-qr-fixture' });
    userActivation = false;
    await copying;

    expect(copiedImages).toHaveLength(1);
    expect(copiedImages[0].type).toBe('image/png');
    const pngBytes = new Uint8Array(await copiedImages[0].arrayBuffer());
    expect(Array.from(pngBytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(pngBytes.length).toBeGreaterThan(8);
    expect(fetch).not.toHaveBeenCalled();
  });
});
