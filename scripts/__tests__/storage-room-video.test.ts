import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../../infra/cloudflare-worker/src/index';

const put = vi.fn();
const env = {
  FILES: { head: vi.fn().mockResolvedValue(null), put },
  SUPABASE_URL: 'https://auth.example.test',
  R2_PUBLIC_BASE: 'https://media.example.test',
} as unknown as Env;

function upload(key: string, bytes: Uint8Array<ArrayBuffer>, length = bytes.length) {
  return worker.fetch(new Request('https://storage.example.test/upload?key=' + key, {
    method: 'PUT', body: bytes, headers: {
      Authorization: 'Bearer test', 'content-type': 'video/mp4', 'content-length': String(length),
    },
  }), env);
}

beforeEach(() => {
  put.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'actor' })));
});
afterEach(() => vi.unstubAllGlobals());

const key = 'room-sale-images/actor/tour.mp4';
it('stores an MP4 larger than the previous photo limit', async () => {
  const bytes = new Uint8Array(9 * 1024 * 1024);
  bytes.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  expect((await upload(key, bytes)).status).toBe(200);
  expect(put).toHaveBeenCalledWith(key, expect.any(ArrayBuffer), expect.objectContaining({
    httpMetadata: expect.objectContaining({ contentType: 'video/mp4' }),
  }));
});

it('rejects oversized or mislabeled videos and writes outside the current user folder', async () => {
  const bytes = new Uint8Array(20);
  expect((await upload(key, bytes, 33 * 1024 * 1024)).status).toBe(413);
  expect((await upload(key, bytes)).status).toBe(415);
  expect((await upload(key, bytes, 12)).status).toBe(413);
  expect((await upload(key.replace('.mp4', '.jpg'), bytes)).status).toBe(415);
  expect((await upload(key.replace('/actor/', '/other/'), bytes)).status).toBe(403);
  expect(put).not.toHaveBeenCalled();
});
