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
});
