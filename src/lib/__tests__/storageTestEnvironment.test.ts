import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ sign: vi.fn(), upload: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: () => ({
  upload: io.upload,
  getPublicUrl: (path: string) => ({ data: { publicUrl: `https://hzulujxgonszuleqticb.supabase.co/storage/v1/object/public/avatars/${path}` } }),
}) } } }));
vi.mock('../signedUrlBatcher', () => ({ createSignedUrlBatched: io.sign }));
vi.mock('../imageCompress', () => ({ compressImage: async (file: File) => file }));

const prod = 'https://tryymsxyyckgbrmmvozx.supabase.co';
const test = 'https://hzulujxgonszuleqticb.supabase.co';
const stored = `${prod}/storage/v1/object/public/income-expense-attachments/u/proof.png`;
const signed = `${test}/storage/v1/object/sign/income-expense-attachments/u/proof.png?token=test`;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_APP_ENV', 'test');
  vi.stubEnv('VITE_SUPABASE_URL', test);
  io.sign.mockReset().mockResolvedValue(signed);
  io.upload.mockReset().mockImplementation(async (path: string) => ({ data: { path }, error: null }));
});
afterEach(() => vi.unstubAllEnvs());

describe('media sao chép vào TEST', () => {
  it.each(['public', 'sign', 'authenticated'])('không ký lại hoặc trả URL production dạng %s', async (access) => {
    const { createSignedUrlFromStored } = await import('../storage');
    const url = await createSignedUrlFromStored(stored.replace('/public/', `/${access}/`));
    expect(url).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(url)).toContain('TEST');
    expect(io.sign).not.toHaveBeenCalled();
  });

  it('file tải mới trên TEST vẫn nhận URL của TEST và được ký để đọc', async () => {
    const { uploadFile, createSignedUrlFromStored } = await import('../storage');
    const url = await uploadFile('avatars', 'u/new.png', new File(['image'], 'new.png', { type: 'image/png' }));
    expect(url).toBe(`${test}/storage/v1/object/public/avatars/u/new.png`);
    expect(io.upload).toHaveBeenCalledWith('u/new.png', expect.any(File), expect.objectContaining({ upsert: false }));
    expect(await createSignedUrlFromStored(url)).toBe(signed);
    expect(io.sign).toHaveBeenCalledWith('avatars', 'u/new.png', 3600);
  });

  it.each(['blob:local-photo', 'data:image/png;base64,aGVsbG8=', 'https://external.example/photo.png'])('giữ URL không phải Supabase: %s', async (url) => {
    const { createSignedUrlFromStored } = await import('../storage');
    expect(await createSignedUrlFromStored(url)).toBe(url);
    expect(io.sign).not.toHaveBeenCalled();
  });

  it('production vẫn ký URL cũ và giữ fallback đang có', async () => {
    vi.stubEnv('VITE_APP_ENV', 'production');
    vi.stubEnv('VITE_SUPABASE_URL', prod);
    const { createSignedUrlFromStored } = await import('../storage');
    expect(await createSignedUrlFromStored(stored)).toBe(signed);
    io.sign.mockResolvedValueOnce(null);
    expect(await createSignedUrlFromStored(stored)).toBe(stored);
  });
});
