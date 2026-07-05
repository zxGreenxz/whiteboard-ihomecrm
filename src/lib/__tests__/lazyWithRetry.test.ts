import { describe, it, expect, vi } from 'vitest';
import { retryImport } from '../lazyWithRetry';

const CHUNK_ERR = new Error(
  'Failed to fetch dynamically imported module: https://ptcrm.vercel.app/assets/InvoicesPage-Ab12.js'
);

describe('retryImport', () => {
  it('retry lỗi chunk-load rồi thành công ở lần thử kế (mạng vừa tỉnh)', async () => {
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(CHUNK_ERR)
      .mockResolvedValueOnce('ok');

    // delay nhỏ để test nhanh; retries mặc định = 2.
    await expect(retryImport(factory, 2, 1)).resolves.toBe('ok');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('KHÔNG retry lỗi thường (component throw) — ném ngay, gọi factory đúng 1 lần', async () => {
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('Cannot read properties of undefined'));

    await expect(retryImport(factory, 2, 1)).rejects.toThrow('Cannot read properties');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('chunk lỗi mãi (chunk mất thật) → ném lại sau khi cạn retry để ErrorBoundary reload', async () => {
    const factory = vi.fn<() => Promise<string>>().mockRejectedValue(CHUNK_ERR);

    await expect(retryImport(factory, 2, 1)).rejects.toThrow('Failed to fetch dynamically imported module');
    // 1 lần đầu + 2 lần retry = 3.
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('thành công ngay lần đầu → không delay, không retry thừa', async () => {
    const factory = vi.fn<() => Promise<string>>().mockResolvedValue('first');
    await expect(retryImport(factory, 2, 1)).resolves.toBe('first');
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
