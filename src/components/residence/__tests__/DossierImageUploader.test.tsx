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
  lease_term_from: null, lease_term_to: null, lease_term_source: null,
});

afterEach(cleanup);

/** Giả lập Ctrl+V: jsdom không có ClipboardEvent kèm clipboardData, gắn tay như test QR CCCD. */
function paste(files: File[]) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { files, items: [] } });
  window.dispatchEvent(event);
  return event;
}

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

  it('dán ảnh bằng Ctrl+V khi con trỏ đang ở trên khối, bỏ qua tệp không phải ảnh', async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    render(<DossierImageUploader kind="LEASE" files={[]} canEdit contractId="ct1" onUpload={onUpload} onRemove={vi.fn()} />);
    const zone = document.querySelector('[data-dossier-kind="LEASE"]') as HTMLElement;
    const anh = new File(['x'], 'man-hinh.png', { type: 'image/png' });
    // Chưa đưa chuột vào khối: để yên, kẻo nuốt Ctrl+V của ô khác trên trang.
    expect(paste([anh]).defaultPrevented).toBe(false);
    expect(onUpload).not.toHaveBeenCalled();
    fireEvent.mouseEnter(zone);
    expect(zone.getAttribute('data-clipboard-image-paste-active')).toBe('true');
    const ev = paste([anh, new File(['t'], 'ghi-chu.txt', { type: 'text/plain' })]);
    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(onUpload.mock.calls[0][0]).toEqual({ kind: 'LEASE', contractId: 'ct1', file: anh });
    fireEvent.mouseLeave(zone);
    expect(zone.getAttribute('data-clipboard-image-paste-active')).toBe('false');
  });

  it('không có quyền thì không nhận dán; có nội dung con thì hiện dưới hàng ảnh', () => {
    const onUpload = vi.fn();
    render(
      <DossierImageUploader kind="LEASE" files={[file('f1')]} canEdit={false} onUpload={onUpload} onRemove={vi.fn()}>
        <p>Hợp đồng ghi đến 14/09/2028</p>
      </DossierImageUploader>,
    );
    const zone = document.querySelector('[data-dossier-kind="LEASE"]') as HTMLElement;
    fireEvent.mouseEnter(zone);
    expect(paste([new File(['x'], 'a.png', { type: 'image/png' })]).defaultPrevented).toBe(false);
    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.getByText(/Hợp đồng ghi đến 14\/09\/2028/)).toBeTruthy();
  });

  it('không có quyền thì chỉ xem', () => {
    render(<DossierImageUploader kind="OWNERSHIP" files={[file('f1')]} canEdit={false} onUpload={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /chụp ảnh/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Xoá ảnh' })).toBeNull();
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });
});
