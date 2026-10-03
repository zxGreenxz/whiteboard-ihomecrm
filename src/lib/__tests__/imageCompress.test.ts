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

  it('giải mã theo đúng chiều ảnh: ảnh camera iPhone có cờ xoay EXIF 6, vẽ lại qua canvas là mất cờ', async () => {
    installCanvas({ webp: false });
    const decode = vi.fn(async () => ({ width: 4032, height: 3024, close() {} }));
    vi.stubGlobal('createImageBitmap', decode);
    const photo = cameraJpeg();
    await compressImage(photo);
    expect(decode).toHaveBeenCalledWith(photo, { imageOrientation: 'from-image' });
  });

  it('trình duyệt cũ chưa biết "from-image": ảnh JPEG giữ nguyên bản — giải mã theo mặc định cũ có thể bỏ cờ xoay', async () => {
    installCanvas({ webp: false });
    vi.stubGlobal('createImageBitmap', async (_f: File, opts?: { imageOrientation?: string }) => {
      if (opts?.imageOrientation) throw new TypeError("The provided value 'from-image' is not a valid enum value");
      return { width: 4032, height: 3024, close() {} };
    });
    const photo = cameraJpeg();
    await expect(compressImage(photo)).resolves.toBe(photo);
  });

  it('trình duyệt cũ chưa biết "from-image": ảnh PNG (không có cờ xoay) vẫn giải mã lại và nén', async () => {
    installCanvas({ webp: false, pngFallbackBytes: 225_000 });
    vi.stubGlobal('createImageBitmap', async (_f: File, opts?: { imageOrientation?: string }) => {
      if (opts?.imageOrientation) throw new TypeError("The provided value 'from-image' is not a valid enum value");
      return { width: 1290, height: 2796, close() {} };
    });
    const png = new File([new Uint8Array(900_000)], 'IMG_1083.png', { type: 'image/png' });
    const out = await compressImage(png);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('IMG_1083.jpg');
  });

  // Chủ chốt 03/10/2026: bill chụp màn hình nén mạnh (1024 px, 0,5) vẫn đọc rõ trên bill
  // thật; ảnh camera chụp giấy tờ xuống 1024 px là mất chữ nhỏ ⇒ chỉ nén mạnh loại đầu.
  describe('ảnh chứng từ (profile evidence)', () => {
    function ghiCanvas(w: number, h: number) {
      // Ghi cỡ lúc TẠO: nén xong hàm trả bộ nhớ canvas (đặt width/height = 0).
      const sizes: Array<[number, number]> = [];
      const qualities: number[] = [];
      vi.stubGlobal('createImageBitmap', async () => ({ width: w, height: h, close() {} }));
      vi.stubGlobal('OffscreenCanvas', class {
        constructor(public width: number, public height: number) { sizes.push([width, height]); }
        getContext() { return { fillStyle: '', fillRect() {}, drawImage() {} }; }
        async convertToBlob({ type, quality }: { type: string; quality: number }) {
          if (this.width > 1) qualities.push(quality);
          return new Blob([new Uint8Array(30_000)], { type });
        }
      });
      const drawn = () => sizes.filter(([cw]) => cw > 1);
      return { drawn, qualities };
    }
    const png = (bytes: number) => new File([new Uint8Array(bytes)], 'Screenshot.png', { type: 'image/png' });

    it('ảnh chụp màn hình điện thoại (PNG dựng đứng): cạnh dài 1024 px, chất lượng 0,5', async () => {
      const { drawn, qualities } = ghiCanvas(1080, 2400);
      const out = await compressImage(png(900_000), { profile: 'evidence' });
      expect(drawn()).toEqual([[461, 1024]]);
      expect(qualities).toEqual([0.5]);
      expect(out.size).toBe(30_000);
    });

    it('ảnh camera (JPEG) — kể cả chụp giấy tờ dọc: giữ 1600 px, chất lượng thường', async () => {
      const { drawn, qualities } = ghiCanvas(3024, 4032);
      await compressImage(new File([new Uint8Array(2_900_000)], 'image.jpg', { type: 'image/jpeg' }), { profile: 'evidence' });
      expect(drawn()).toEqual([[1200, 1600]]);
      expect(qualities).toEqual([0.82]);
    });

    it('ảnh chụp màn hình máy tính (PNG nằm ngang, chữ nhỏ) và iPad (4:3): giữ 1600 px', async () => {
      const mayTinh = ghiCanvas(2560, 1440);
      await compressImage(png(900_000), { profile: 'evidence' });
      expect(mayTinh.drawn()).toEqual([[1600, 900]]);
      const iPad = ghiCanvas(2048, 2732);
      await compressImage(png(900_000), { profile: 'evidence' });
      expect(iPad.drawn()).toEqual([[1199, 1600]]);
    });

    it('bill PNG 100–200 KB vẫn được nén (mức bỏ qua của chứng từ là 48 KB, không phải 200 KB)', async () => {
      const { drawn } = ghiCanvas(1080, 2400);
      const out = await compressImage(png(150_000), { profile: 'evidence' });
      expect(drawn()).toHaveLength(1);
      expect(out.size).toBe(30_000);
      const nho = png(40_000);
      await expect(compressImage(nho, { profile: 'evidence' })).resolves.toBe(nho);
    });

    it('không truyền profile: ảnh chụp màn hình vẫn nén mức cũ (các trang khác không đổi)', async () => {
      const { drawn, qualities } = ghiCanvas(1080, 2400);
      await compressImage(png(900_000));
      expect(drawn()).toEqual([[720, 1600]]);
      expect(qualities).toEqual([0.82]);
    });
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
