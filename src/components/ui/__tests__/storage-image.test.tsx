// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageImage } from '../storage-image';

const signing = vi.hoisted(() => ({ sign: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/signedUrlBatcher', () => ({ createSignedUrlBatched: signing.sign }));
vi.mock('@/lib/storage/r2Client', () => ({
  signR2: vi.fn(), uploadToR2: vi.fn(),
}));

const stored = 'https://storage.test/object/public/attachments/receipt.png';
const signed = 'https://storage.test/object/sign/attachments/receipt.png?token=fresh';
const clients: QueryClient[] = [];
function show(value = stored, ttl = 3600) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>
    <StorageImage value={value} alt="Biên nhận" ttl={ttl} />
  </QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.useRealTimers();
  signing.sign.mockReset();
});

describe('StorageImage URL recovery', () => {
  it('retries signing failure instead of rendering/caching the private public URL', async () => {
    signing.sign.mockResolvedValueOnce(null).mockResolvedValue(signed);
    const { container } = show();
    expect(container.querySelector('img')).toBeNull();
    await waitFor(() => expect(screen.getByAltText('Biên nhận').getAttribute('src')).toBe(signed));
    expect(signing.sign).toHaveBeenCalledTimes(2);
  });

  it('shows an error after signing fails twice without emitting a broken img', async () => {
    signing.sign.mockResolvedValue(null);
    const { container } = show();
    await screen.findByRole('img', { name: 'Không tải được ảnh: Biên nhận' });
    expect(container.querySelector('img')).toBeNull();
    expect(signing.sign).toHaveBeenCalledTimes(2);
  });

  it('refreshes a failed image once and stops on a missing file', async () => {
    signing.sign.mockResolvedValueOnce(signed).mockResolvedValue(`${signed}2`);
    show();
    fireEvent.error(await screen.findByAltText('Biên nhận'));
    await waitFor(() => expect(screen.getByAltText('Biên nhận').getAttribute('src')).toBe(`${signed}2`));
    fireEvent.error(screen.getByAltText('Biên nhận'));
    expect(screen.getByRole('img', { name: 'Không tải được ảnh: Biên nhận' })).toBeTruthy();
    expect(signing.sign).toHaveBeenCalledTimes(2);
  });

  it('keeps external URLs unsigned and displays a fallback when they fail', () => {
    show('https://external.test/receipt.png');
    fireEvent.error(screen.getByAltText('Biên nhận'));
    expect(screen.getByRole('img', { name: 'Không tải được ảnh: Biên nhận' })).toBeTruthy();
    expect(signing.sign).not.toHaveBeenCalled();
  });

  it('retries the download even if signing returns the same URL, without looping', async () => {
    signing.sign.mockResolvedValue(signed);
    show();
    fireEvent.error(await screen.findByAltText('Biên nhận'));
    await waitFor(() => expect(screen.getByAltText('Biên nhận').getAttribute('src')).toBe(signed));
    fireEvent.error(screen.getByAltText('Biên nhận'));
    expect(screen.getByRole('img', { name: 'Không tải được ảnh: Biên nhận' })).toBeTruthy();
    expect(signing.sign).toHaveBeenCalledTimes(2);
  });

  it('accepts a newly signed URL identical to the stored signed URL', async () => {
    signing.sign.mockResolvedValue(signed);
    show(signed);
    await waitFor(() => expect(screen.getByAltText('Biên nhận').getAttribute('src')).toBe(signed));
    expect(signing.sign).toHaveBeenCalledTimes(1);
  });

  it('renews mounted images before their URL expires', async () => {
    vi.useFakeTimers();
    signing.sign.mockResolvedValueOnce(signed).mockResolvedValue(`${signed}2`);
    show(stored, 2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByAltText('Biên nhận').getAttribute('src')).toBe(signed);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(signing.sign).toHaveBeenCalledTimes(2);
    expect(screen.getByAltText('Biên nhận').getAttribute('src')).toBe(`${signed}2`);
  });
});
