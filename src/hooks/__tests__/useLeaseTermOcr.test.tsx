// @vitest-environment jsdom
// Đọc hạn trên ảnh hợp đồng: dùng lại hạn đã lưu, đọc ảnh khi chưa có, và
// KHÔNG bịa hạn khi ảnh mờ — lúc đó nút DVC phải quay về số tháng người dùng chọn.
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ sign: vi.fn(), luu: vi.fn() }));
vi.mock('@/lib/storage', () => ({
  createSignedUrlFromStored: boundary.sign,
  getPublicUrl: (b: string, p: string) => `https://x/${b}/${p}`,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn() }));
vi.mock('@/lib/residenceDossierFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/residenceDossierFiles')>()),
  luuHanHopDong: boundary.luu,
}));

import { useLeaseTermOcr } from '@/hooks/useLeaseTermOcr';
import type { OcrScanner } from '@/lib/ocr/types';
import type { ResidenceDossierFile } from '@/lib/residenceDossierFiles';

const anh = (over: Partial<ResidenceDossierFile> = {}): ResidenceDossierFile => ({
  id: 'l1', kind: 'LEASE', organization_id: 'o', building_id: 'b', customer_id: 'c', contract_id: 'ct',
  bucket_id: 'residence-docs', object_name: 'u/l1.jpg', file_name: 'hopdong1.jpg', content_type: 'image/jpeg',
  size_bytes: 1, sort_order: 0, created_at: '2026-09-16T00:00:00Z',
  lease_term_from: null, lease_term_to: null, lease_term_source: null, ...over,
});

const dong = (texts: string[]) => texts.map((text) => ({ text, confidence: 0.99, box: [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][] }));

function scannerGia(ket: unknown): { tao: () => OcrScanner; readText: ReturnType<typeof vi.fn> } {
  const readText = vi.fn().mockResolvedValue(ket);
  return { tao: () => ({ read: vi.fn(), readText, dispose: vi.fn() }) as unknown as OcrScanner, readText };
}

beforeEach(() => {
  boundary.sign.mockReset().mockResolvedValue('https://signed/anh.jpg');
  boundary.luu.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) }));
});
afterEach(() => vi.unstubAllGlobals());

describe('useLeaseTermOcr', () => {
  it('đọc hạn trên ảnh rồi lưu lại để lần sau khỏi đọc', async () => {
    const gia = scannerGia({ status: 'lines', size: { width: 10, height: 10 }, elapsedMs: 1,
      lines: dong(['Thời hạn mượn: 24 tháng (từ 14/09/2026 đến 14/09/2028)']) });
    const { result } = renderHook(() => useLeaseTermOcr(anh(), true, gia.tao));
    await waitFor(() => expect(result.current.trangThai).toBe('xong'));
    expect(result.current.han).toMatchObject({ from: '14/09/2026', to: '14/09/2028' });
    await waitFor(() => expect(boundary.luu).toHaveBeenCalledWith('l1', '14/09/2026', '14/09/2028'));
  });

  it('đã có hạn lưu sẵn thì không đọc ảnh nữa', async () => {
    const gia = scannerGia({ status: 'lines', size: { width: 1, height: 1 }, elapsedMs: 1, lines: [] });
    const { result } = renderHook(() => useLeaseTermOcr(anh({ lease_term_from: '2026-09-14', lease_term_to: '2028-09-14' }), true, gia.tao));
    await waitFor(() => expect(result.current.han).toEqual({ from: '14/09/2026', to: '14/09/2028', nguon: 'cap-ngay' }));
    expect(gia.readText).not.toHaveBeenCalled();
    expect(boundary.sign).not.toHaveBeenCalled();
  });

  it('ảnh không đọc được thì báo rõ và KHÔNG bịa hạn', async () => {
    const gia = scannerGia({ status: 'lines', size: { width: 1, height: 1 }, elapsedMs: 1, lines: dong(['HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ']) });
    const { result } = renderHook(() => useLeaseTermOcr(anh(), true, gia.tao));
    await waitFor(() => expect(result.current.trangThai).toBe('khong-doc-duoc'));
    expect(result.current.han).toBeNull();
    expect(boundary.luu).not.toHaveBeenCalled();
  });

  it('hạn đã qua thì coi như không đọc được', async () => {
    const gia = scannerGia({ status: 'lines', size: { width: 1, height: 1 }, elapsedMs: 1,
      lines: dong(['Thời hạn mượn: 12 tháng (từ 01/01/2020 đến 01/01/2021)']) });
    const { result } = renderHook(() => useLeaseTermOcr(anh(), true, gia.tao));
    await waitFor(() => expect(result.current.trangThai).toBe('khong-doc-duoc'));
    expect(result.current.han).toBeNull();
  });

  it('không có ảnh hợp đồng thì nằm im', async () => {
    const gia = scannerGia({ status: 'lines', size: { width: 1, height: 1 }, elapsedMs: 1, lines: [] });
    const { result } = renderHook(() => useLeaseTermOcr(undefined, true, gia.tao));
    expect(result.current.trangThai).toBe('nghi');
    expect(gia.readText).not.toHaveBeenCalled();
  });

  it('tải ảnh hỏng thì báo lỗi, không kẹt ở trạng thái đang đọc', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const gia = scannerGia({ status: 'lines', size: { width: 1, height: 1 }, elapsedMs: 1, lines: [] });
    const { result } = renderHook(() => useLeaseTermOcr(anh(), true, gia.tao));
    await waitFor(() => expect(result.current.trangThai).toBe('loi'));
  });
});
