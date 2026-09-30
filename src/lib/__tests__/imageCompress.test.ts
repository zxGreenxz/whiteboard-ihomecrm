// Nén ảnh trước khi tải — các ca đo được trên production 30/09/2026.
//
// Safari trên iPhone KHÔNG mã hoá được WebP: xin `image/webp` thì nó lặng lẽ trả
// PNG. Soi byte đầu hai file `IMG_2758.webp`, `IMG_1077.webp` trong kho
// income-expense-attachments: cả hai là PNG 740×1600 mang nhãn WebP. Với ảnh
// chụp camera, PNG thu nhỏ còn nặng hơn bản gốc nên hàm cũ trả nguyên ảnh gốc —
// 36 file JPEG 1,6–2,8 MB (vd 4032×3024) đã đi thẳng lên kho qua mạng điện thoại.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressImage } from '../imageCompress';

interface FakeCtx {
  fillStyle: string;
  calls: string[];
  fillRect: (x: number, y: number, w: number, h: number) => void;
  drawImage: () => void;
}

/**
 * Giả OffscreenCanvas; `webp` = trình duyệt có mã hoá được WebP hay không.
 * `pngFallbackBytes` = cỡ PNG Safari trả về khi bị xin WebP (ảnh chụp camera
 * ~4 MB; ảnh chụp màn hình thu nhỏ ~225 KB như file thật trong kho).
 */
function installCanvas({ webp, pngFallbackBytes = 4_000_000 }: { webp: boolean; pngFallbackBytes?: number }) {
  const requested: string[] = [];
  const contexts: FakeCtx[] = [];
  vi.stubGlobal('createImageBitmap', async () => ({ width: 4032, height: 3024, close() {} }));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() {
      const ctx: FakeCtx = {
        fillStyle: '',
        calls: [],
        fillRect() { ctx.calls.push(`fillRect:${ctx.fillStyle}`); },
        drawImage() { ctx.calls.push('drawImage'); },
      };
      contexts.push(ctx);
      return ctx;
    }
    async convertToBlob({ type }: { type: string }) {
      requested.push(type);
      // Safari: không hỗ trợ WebP ⇒ trả PNG (to hơn cả ảnh gốc với ảnh chụp camera).
      if (type === 'image/webp' && !webp) return new Blob([new Uint8Array(pngFallbackBytes)], { type: 'image/png' });
      return new Blob([new Uint8Array(250_000)], { type });
    }
  });
  return { requested, contexts };
}

const cameraJpeg = () => new File([new Uint8Array(2_900_000)], 'image.jpg', { type: 'image/jpeg' });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('compressImage', () => {
  it('Safari không mã hoá được WebP: nén sang JPEG thay vì trả nguyên ảnh gốc 2,9 MB', async () => {
    const { requested } = installCanvas({ webp: false });
    const out = await compressImage(cameraJpeg());
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('image.jpg');
    expect(out.size).toBe(250_000);
    expect(requested).toContain('image/jpeg');
  });

  it('ảnh chụp màn hình: không bao giờ dán nhãn WebP lên byte PNG, ra JPEG đúng nhãn', async () => {
    installCanvas({ webp: false, pngFallbackBytes: 225_000 });
    const png = new File([new Uint8Array(900_000)], 'IMG_1083.png', { type: 'image/png' });
    const out = await compressImage(png);
    expect(out.type).not.toBe('image/webp');
    expect(out.name.endsWith('.webp')).toBe(false);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('IMG_1083.jpg');
  });

  it('JPEG không có nền trong suốt: tô trắng TRƯỚC khi vẽ để ảnh PNG trong suốt không hoá đen', async () => {
    const { contexts } = installCanvas({ webp: false });
    const png = new File([new Uint8Array(900_000)], 'con-dau.png', { type: 'image/png' });
    await compressImage(png);
    const drawn = contexts.find((c) => c.calls.includes('drawImage'))!;
    expect(drawn.calls).toEqual(['fillRect:#fff', 'drawImage']);
  });

  it('trình duyệt mã hoá được WebP: giữ WebP như cũ, không tô nền', async () => {
    const { contexts } = installCanvas({ webp: true });
    const out = await compressImage(cameraJpeg());
    expect(out.type).toBe('image/webp');
    expect(out.name).toBe('image.webp');
    const drawn = contexts.find((c) => c.calls.includes('drawImage'))!;
    expect(drawn.calls).toEqual(['drawImage']);
  });

  it('bước nén bị treo: quá hạn thì trả ảnh gốc để việc tải vẫn đi tiếp, không kẹt "Đang tải..."', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('createImageBitmap', () => new Promise(() => {}));
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { drawImage() {}, fillRect() {} }; }
      async convertToBlob({ type }: { type: string }) { return new Blob([new Uint8Array(1)], { type }); }
    });
    const original = cameraJpeg();
    const pending = compressImage(original, { timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe(original);
  });
});
