// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const io = vi.hoisted(() => ({ sign: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: vi.fn() } } }));
vi.mock('@/lib/signedUrlBatcher', () => ({ createSignedUrlBatched: io.sign }));
const oldImage = 'https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/income-expense-attachments/u/old.png';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_APP_ENV', 'test');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://hzulujxgonszuleqticb.supabase.co');
  io.sign.mockReset().mockResolvedValue('https://hzulujxgonszuleqticb.supabase.co/missing-file');
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

it('ảnh clone có trạng thái TEST rõ ràng, không gửi URL vào img hay gọi ký', async () => {
  const { StorageImage } = await import('../storage-image');
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><StorageImage value={oldImage} alt="Chứng từ" /></QueryClientProvider>);
  expect(screen.getByText(/không có.*TEST/i)).toBeTruthy();
  expect(document.querySelector('img')).toBeNull();
  expect(io.sign).not.toHaveBeenCalled();
  client.clear();
});

it('PDF clone hiển thị thông báo TEST thay vì iframe trống hoặc tải production', async () => {
  const { AttachmentLightbox } = await import('../attachment-lightbox');
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><AttachmentLightbox attachments={[oldImage.replace('.png', '.pdf')]} index={0} onIndexChange={() => {}} /></QueryClientProvider>);
  expect(screen.getByText(/không có.*TEST/i)).toBeTruthy();
  expect(document.querySelector('iframe')).toBeNull();
  expect(io.sign).not.toHaveBeenCalled();
  client.clear();
});

it('avatar clone không đưa production URL vào bộ tải ảnh của Radix', async () => {
  const { Avatar, AvatarImage, AvatarFallback } = await import('../avatar');
  const imageSource = vi.spyOn(window.HTMLImageElement.prototype, 'src', 'set');
  render(<Avatar><AvatarImage src={oldImage.replace('income-expense-attachments', 'avatars')} alt="Nhân viên" /><AvatarFallback>NV</AvatarFallback></Avatar>);
  expect(imageSource.mock.calls.some(([url]) => String(url).includes('tryymsxyyckgbrmmvozx'))).toBe(false);
  imageSource.mockRestore();
});

it('mở file clone không tạo cửa sổ hay điều hướng đến production', async () => {
  const { openStoredFile } = await import('@/lib/storage');
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  await openStoredFile(oldImage);
  expect(open).not.toHaveBeenCalled();
  open.mockRestore();
});
