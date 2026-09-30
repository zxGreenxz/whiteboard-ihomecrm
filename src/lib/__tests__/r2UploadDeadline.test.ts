// uploadToR2 (ảnh phòng trống qua Worker) từng không có hạn chờ — cùng lớp lỗi
// "kẹt Đang tải... tới khi tắt app" như kho Supabase (30/09/2026). Khác Supabase,
// fetch tới Worker huỷ được thật: quá hạn thì abort request và báo lỗi rõ.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

async function loadR2() {
  vi.stubEnv('VITE_STORAGE_GATEWAY', 'https://storage.example.test');
  vi.stubEnv('VITE_R2_PUBLIC_BASE', 'https://img.example.test');
  vi.resetModules();
  const client = await import('../storage/r2Client');
  const deadline = await import('../uploadDeadline');
  return { ...client, ...deadline };
}

describe('uploadToR2', () => {
  it('request tới Worker kẹt: quá hạn thì huỷ request và báo UploadTimeoutError', async () => {
    const { uploadToR2, uploadDeadlineMs, UploadTimeoutError } = await loadR2();
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      seenSignal = init.signal ?? undefined;
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const photo = new File([new Uint8Array(150_000)], 'phong.webp', { type: 'image/webp' });
    const settled = uploadToR2('room-sale-images', 'r/1-phong.webp', photo).then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(uploadDeadlineMs(photo.size));
    const loi = await settled;
    expect(loi).toBeInstanceOf(UploadTimeoutError);
    expect((loi as { ms?: number }).ms).toBe(20_000); // để câu báo nói đúng số giây đã chờ
    expect(seenSignal?.aborted).toBe(true);
  });

  it('tải bình thường: trả URL công khai như cũ', async () => {
    const { uploadToR2 } = await loadR2();
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
    const photo = new File([new Uint8Array(10)], 'phong.webp', { type: 'image/webp' });
    await expect(uploadToR2('room-sale-images', 'r/1-phong.webp', photo)).resolves.toBe(
      'https://img.example.test/room-sale-images/r/1-phong.webp',
    );
  });
});
