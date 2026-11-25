// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  uploadFile: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({ uploadFile: boundary.uploadFile }));
vi.mock('@/lib/authSession', () => ({
  getSessionUser: vi.fn(async () => ({ id: 'test-user' })),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/components/ui/storage-image', () => ({ StorageImage: () => null }));

import ImageUploadZone from '../ImageUploadZone';

describe('ImageUploadZone upload policy', () => {
  beforeEach(() => {
    boundary.uploadFile.mockReset();
    boundary.uploadFile.mockResolvedValue('stored:image');
  });

  afterEach(cleanup);

  it('forwards identity-original for an identity field', async () => {
    const view = render(
      <ImageUploadZone
        label="CCCD mặt trước"
        onChange={vi.fn()}
        imagePolicy="identity-original"
      />,
    );
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['image'], 'front.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(boundary.uploadFile).toHaveBeenCalledOnce());
    expect(boundary.uploadFile.mock.calls[0][3]).toEqual({ imagePolicy: 'identity-original' });
  });

  it('keeps legacy ImageUploadZone consumers on the optionless default call', async () => {
    const view = render(<ImageUploadZone label="Ảnh phòng" onChange={vi.fn()} />);
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['image'], 'room.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(boundary.uploadFile).toHaveBeenCalledOnce());
    expect(boundary.uploadFile.mock.calls[0]).toHaveLength(3);
  });

  const ROOM_ACCEPT = 'image/png,image/jpeg,image/jpg,image/webp';
  const pick = (view: ReturnType<typeof render>, file: File) =>
    fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
  const webp = () => new File(['RIFF0000WEBP'], 'zalo.webp', { type: 'image/webp' });

  it('ảnh phòng khai WebP thì nhận ảnh WebP lưu từ Zalo/Android', async () => {
    const view = render(<ImageUploadZone label="Thêm ảnh" bucket="room-sale-images" accept={ROOM_ACCEPT} onChange={vi.fn()} />);
    pick(view, webp());
    await waitFor(() => expect(boundary.uploadFile).toHaveBeenCalledOnce());
    expect(boundary.uploadFile.mock.calls[0][2].type).toBe('image/webp');
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('ô mặc định (CCCD, xe…) vẫn chỉ nhận PNG/JPEG và báo đúng định dạng nhận', async () => {
    const view = render(<ImageUploadZone label="CCCD mặt sau" onChange={vi.fn()} />);
    pick(view, webp());
    expect((await view.findByRole('alert')).textContent).toContain('zalo.webp: Chỉ chấp nhận file PNG, JPG, JPEG');
    expect(boundary.uploadFile).not.toHaveBeenCalled();
  });

  it('ô giấy tờ giữ nguyên bytes không nhận WebP kể cả khi nơi gọi lỡ khai accept có WebP', async () => {
    const view = render(<ImageUploadZone label="CCCD mặt trước" imagePolicy="identity-original" accept={ROOM_ACCEPT} onChange={vi.fn()} />);
    pick(view, webp());
    expect((await view.findByRole('alert')).textContent).toContain('Chỉ chấp nhận file PNG, JPG, JPEG');
    expect(boundary.uploadFile).not.toHaveBeenCalled();
    pick(view, new File(['image'], 'front.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(boundary.uploadFile).toHaveBeenCalledOnce());
  });

  it('ảnh phòng vẫn chặn định dạng ngoài danh sách (HEIC) và ảnh quá 10 MB', async () => {
    const view = render(<ImageUploadZone label="Thêm ảnh" bucket="room-sale-images" accept={ROOM_ACCEPT} maxSizeMB={5} onChange={vi.fn()} />);
    pick(view, new File(['x'], 'iphone.heic', { type: 'image/heic' }));
    expect((await view.findByRole('alert')).textContent).toContain('Chỉ chấp nhận file PNG, JPG, JPEG, WEBP');
    const big = new File(['x'], 'big.webp', { type: 'image/webp' });
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    pick(view, big);
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('big.webp: Kích thước file tối đa 5MB'));
    expect(boundary.uploadFile).not.toHaveBeenCalled();
  });
});
