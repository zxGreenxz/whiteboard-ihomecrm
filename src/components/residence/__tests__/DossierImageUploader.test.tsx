// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/storage-image', () => ({ StorageImage: ({ alt }: { alt: string }) => <img alt={alt} /> }));
vi.mock('@/lib/storage', () => ({ getPublicUrl: (b: string, p: string) => `${b}/${p}` }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn() }));

import DossierImageUploader from '../DossierImageUploader';
import type { ResidenceDossierFile } from '@/lib/residenceDossierFiles';

const file = (id: string): ResidenceDossierFile => ({
  id, kind: 'CT01', organization_id: 'o', building_id: 'b', customer_id: 'c', contract_id: 'ct',
  bucket_id: 'residence-docs', object_name: `u/${id}.webp`, file_name: `${id}.jpg`, content_type: 'image/webp',
  size_bytes: 1, sort_order: 0, created_at: '2026-09-15T00:00:00Z',
});

afterEach(cleanup);

describe('DossierImageUploader', () => {
  it('có nút chụp ảnh (camera) và chọn tệp; tải từng tệp theo thứ tự', async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    render(<DossierImageUploader kind="CT01" files={[]} canEdit contractId="ct1" onUpload={onUpload} onRemove={vi.fn()} />);
    expect(screen.getByRole('button', { name: /chụp ảnh/i })).toBeTruthy();
    const capture = screen.getByLabelText(/chụp ảnh tờ khai/i) as HTMLInputElement;
    expect(capture.getAttribute('capture')).toBe('environment');
    expect(capture.getAttribute('accept')).toBe('image/*');

    const pick = screen.getByLabelText(/chọn tệp tờ khai/i) as HTMLInputElement;
    const a = new File(['a'], 'a.jpg', { type: 'image/jpeg' });
    const b = new File(['b'], 'b.png', { type: 'image/png' });
    fireEvent.change(pick, { target: { files: [a, b] } });

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload.mock.calls[0][0]).toEqual({ kind: 'CT01', contractId: 'ct1', file: a });
    expect(onUpload.mock.calls[1][0]).toEqual({ kind: 'CT01', contractId: 'ct1', file: b });
  });

  it('hiện thumbnail và xoá được khi có quyền', async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<DossierImageUploader kind="LEASE" files={[file('f1'), file('f2')]} canEdit onUpload={vi.fn()} onRemove={onRemove} />);
    expect(screen.getByText(/2 ảnh/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Xoá ảnh' })[1]);
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith('f2'));
  });

  it('không có quyền thì chỉ xem', () => {
    render(<DossierImageUploader kind="OWNERSHIP" files={[file('f1')]} canEdit={false} onUpload={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /chụp ảnh/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Xoá ảnh' })).toBeNull();
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });
});
