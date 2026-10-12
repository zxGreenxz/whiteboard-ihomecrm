import { describe, it, expect, vi } from 'vitest';
vi.mock('../lib/ctx.js', () => ({ sb: null, SUPABASE_URL: 'https://storage.example.test' }));
import { chuanBiAnhPhong } from '../lib/automation-room-image.js';

const png = () => { const b = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(b); b.writeUInt32BE(640,16); b.writeUInt32BE(480,20); return b; };
function fixture(url = 'https://images.example.test/room-sale-images/u/photo.webp') {
  const storage = { upload: vi.fn().mockResolvedValue({ error: null }),
    createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.example.test/storage/v1/object/sign/room-sale-images/u/photo.png?token=temporary' } }),
    getPublicUrl: path => ({ data: { publicUrl: `https://storage.example.test/storage/v1/object/public/zalo-media/${path}` } }) };
  const db = { rpc: vi.fn().mockResolvedValue({ data: true }), storage: { from: vi.fn(() => storage) } };
  const fetchImpl = vi.fn().mockImplementation(async () => new Response(png(), { headers: { 'content-type': 'image/png' } }));
  const room = { id: 'room', images: url ? [url] : [] };
  const options = { accountId: 'account', orgId: 'org', db, fetchImpl, r2Base: 'https://images.example.test' };
  return { room, options, db, storage, fetchImpl, run: () => chuanBiAnhPhong(room, options) };
}

describe('automation room photo goes through guarded existing media storage', () => {
  it('copies a public R2 photo once under the sending account with the actual image format', async () => {
    const f = fixture(); const [photo] = await f.run();
    expect(photo).toMatchObject({ bucket: 'zalo-media', mime: 'image/png', width: 640, height: 480, size: 32 });
    expect(photo.path).toMatch(/^account\/automation\/phong-[a-f0-9]{64}\.png$/);
    expect(f.storage.upload).toHaveBeenCalledWith(photo.path, png(), { contentType: 'image/png', upsert: true });
    expect(f.fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(f.fetchImpl.mock.calls[0][1].headers).toBeUndefined();
    expect(await f.run()).toEqual([photo]); // retry keeps the content-addressed storage key
  });
  it('does not substitute building photos or fetch anything when the room has no photo', async () => {
    const f = fixture(null); expect(await f.run()).toEqual([]);
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.storage.upload).not.toHaveBeenCalled();
  });
  it('prepares every source in order and preserves receipt identity after reordering or refreshing signed query parameters', async () => {
    const f = fixture();
    f.room.images = Array.from({ length: 8 }, (_, i) => `https://images.example.test/room-sale-images/u/${i}.jpg?token=old`);
    const first = await f.run();
    expect(first).toHaveLength(8);
    expect(f.fetchImpl.mock.calls.map(c => c[0])).toEqual(f.room.images);
    expect(new Set(first.map(p => p.sourceKey)).size).toBe(8); // even when bytes are identical
    f.room.images = f.room.images.reverse().map(u => u.replace('token=old', 'token=new'));
    expect((await f.run()).map(p => p.sourceKey)).toEqual(first.map(p => p.sourceKey).reverse());
  });
  it('rejects the room if a later photo fails instead of returning an incomplete set', async () => {
    const f = fixture(); f.room.images.push('https://images.example.test/room-sale-images/u/missing.jpg');
    f.fetchImpl.mockImplementation(async url => url.includes('missing') ? new Response(null, { status: 404 }) : new Response(png()));
    await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([
    'http://images.example.test/room-sale-images/u/a.jpg',
    'https://images.example.test.evil.test/room-sale-images/u/a.jpg',
    'https://images.example.test/private/u/a.jpg',
    'https://images.example.test/room-sale-images/u/%252e%252e/a.jpg',
    'https://name:secret@images.example.test/room-sale-images/u/a.jpg',
    'https://127.0.0.1/room-sale-images/u/a.jpg',
  ])('rejects an unexpected source before fetching: %s', async url => {
    const f = fixture(url); await expect(f.run()).rejects.toThrow();
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.storage.upload).not.toHaveBeenCalled();
  });
  it.each(['https://photo.zdn.vn/image', 'https://images.example.test/private/secret', 'http://127.0.0.1/a'])('rejects a redirect out of the configured sale bucket: %s', async location => {
    const f = fixture(); f.fetchImpl.mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    await expect(f.run()).rejects.toThrow(); expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.storage.upload).not.toHaveBeenCalled();
  });
  it('requires configuration, not a guessed host, for R2', async () => {
    const f = fixture(); f.options.r2Base = '';
    await expect(f.run()).rejects.toThrow('Chưa cấu hình'); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('signs legacy Supabase sale photos only after the existing organization ownership RPC allows them', async () => {
    const f = fixture('https://storage.example.test/storage/v1/object/public/room-sale-images/u/photo.png');
    await f.run();
    expect(f.db.rpc).toHaveBeenCalledWith('zalo_worker_attachment_allowed_v1', {
      p_org: 'org', p_account: 'account', p_bucket: 'room-sale-images', p_path: 'u/photo.png',
    });
    expect(f.fetchImpl.mock.calls[0][0]).toContain('/object/sign/room-sale-images/');
  });
  it('does not read a Supabase photo belonging to another organization', async () => {
    const f = fixture('https://storage.example.test/storage/v1/object/public/room-sale-images/u/photo.png');
    f.db.rpc.mockResolvedValue({ data: false });
    await expect(f.run()).rejects.toThrow('không thuộc công ty'); expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.storage.createSignedUrl).not.toHaveBeenCalled();
  });
  it.each([
    () => new Response(null, { status: 404 }),
    () => new Response('html', { headers: { 'content-type': 'text/html' } }),
    () => new Response('not an image', { headers: { 'content-type': 'image/png' } }),
    () => new Response(png(), { headers: { 'content-length': String(26 * 1024 * 1024) } }),
  ])('reports download/content errors instead of silently returning no photo', async response => {
    const f = fixture(); f.fetchImpl.mockImplementation(async () => response());
    await expect(f.run()).rejects.toThrow(); expect(f.storage.upload).not.toHaveBeenCalled();
  });
  it('reports upload failure without returning an unusable attachment', async () => {
    const f = fixture(); f.storage.upload.mockResolvedValue({ error: { message: 'unavailable' } });
    await expect(f.run()).rejects.toThrow('Không lưu được');
  });
});
