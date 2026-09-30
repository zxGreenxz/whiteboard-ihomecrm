// uploadFile — ảnh chứng từ từ iPhone (30/09/2026).
//
// Chủ bấm "Duyệt và Chi" lúc 11:48, nút kẹt "Đang tải..." tới khi tắt app; kho
// không có file nào từ 10:30 tới 12:06:55 (lần thử sau khi mở lại app). Không
// bước nào trong đường tải có hạn chờ: một request kẹt trên mạng điện thoại là
// treo mãi. Nay quá hạn thì báo lỗi rõ để người dùng thử lại, và file lỡ tải
// xong SAU hạn thì bị xoá cho khỏi rác.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ upload: vi.fn(), remove: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: storage.upload,
        remove: storage.remove,
        getPublicUrl: (path: string) => ({ data: { publicUrl: `stored:${path}` } }),
      }),
    },
  },
}));
vi.mock('../signedUrlBatcher', () => ({ createSignedUrlBatched: vi.fn() }));
vi.mock('../storage/r2Client', () => ({ uploadToR2: vi.fn(), signR2: vi.fn() }));

import { uploadFile, uploadDeadlineMs } from '../storage';

/** Safari: xin WebP thì nhận PNG; JPEG thì mã hoá được. */
function installSafariCanvas() {
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1290, height: 2796, close() {} }));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() { return { fillStyle: '', fillRect() {}, drawImage() {} }; }
    async convertToBlob({ type }: { type: string }) {
      if (type === 'image/webp') return new Blob([new Uint8Array(225_000)], { type: 'image/png' });
      return new Blob([new Uint8Array(120_000)], { type });
    }
  });
}

const screenshot = () => new File([new Uint8Array(940_000)], 'IMG_1083.png', { type: 'image/png' });

beforeEach(() => {
  storage.upload.mockReset();
  storage.remove.mockReset();
  storage.remove.mockResolvedValue({ data: [], error: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('uploadFile trên iPhone', () => {
  it('ảnh nén ra JPEG thì key đổi đuôi .jpg cho khớp nội dung', async () => {
    installSafariCanvas();
    storage.upload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
    const url = await uploadFile('income-expense-attachments', 'u/1790744814798-IMG_1083.png', screenshot());
    const [path, file] = storage.upload.mock.calls[0] as [string, File];
    expect(path).toBe('u/1790744814798-IMG_1083.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(url).toBe('stored:u/1790744814798-IMG_1083.jpg');
  });

  it('request tải lên kẹt: quá hạn thì báo lỗi rõ, không treo "Đang tải..." mãi', async () => {
    vi.useFakeTimers();
    storage.upload.mockImplementation(() => new Promise(() => {}));
    const pdf = new File([new Uint8Array(300_000)], 'bill.pdf', { type: 'application/pdf' });
    const pending = uploadFile('income-expense-attachments', 'u/1-bill.pdf', pdf);
    const settled = pending.then(() => 'xong', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(uploadDeadlineMs(pdf.size));
    await expect(settled).resolves.toMatch(/quá lâu/);
  });

  it('request xong SAU hạn: xoá đúng file đó, không để rác trong kho', async () => {
    vi.useFakeTimers();
    let finish!: (v: { data: { path: string }; error: null }) => void;
    storage.upload.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pdf = new File([new Uint8Array(300_000)], 'bill.pdf', { type: 'application/pdf' });
    const settled = uploadFile('income-expense-attachments', 'u/1-bill.pdf', pdf).catch(() => 'loi');
    await vi.advanceTimersByTimeAsync(uploadDeadlineMs(pdf.size));
    await expect(settled).resolves.toBe('loi');
    finish({ data: { path: 'u/1-bill.pdf' }, error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.remove).toHaveBeenCalledWith(['u/1-bill.pdf']);
  });

  it('hạn chờ tăng theo cỡ file: ảnh nhỏ không phải đợi như PDF lớn', () => {
    expect(uploadDeadlineMs(120_000)).toBeLessThan(uploadDeadlineMs(5 * 1024 * 1024));
    expect(uploadDeadlineMs(120_000)).toBeGreaterThanOrEqual(20_000);
  });
});
