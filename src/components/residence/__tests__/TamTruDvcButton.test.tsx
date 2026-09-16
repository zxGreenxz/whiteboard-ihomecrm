// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  detect: vi.fn(), send: vi.fn(), sign: vi.fn(), toastError: vi.fn(), toastSuccess: vi.fn(),
}));
vi.mock('@/lib/tamTruBridge', () => ({
  detectTamTruExtension: boundary.detect, sendTamTruPayload: boundary.send, TAM_TRU_EXT_FOLDER: 'extensions/tam-tru',
}));
vi.mock('@/lib/storage', () => ({
  createSignedUrlFromStored: boundary.sign,
  getPublicUrl: (b: string, p: string) => `https://x/${b}/${p}`,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: boundary.toastError, success: boundary.toastSuccess } }));

import TamTruDvcButton from '../TamTruDvcButton';
import { pickDossierFilesForContract, type ResidenceDossierFile } from '@/lib/residenceDossierFiles';
import type { CT01Tenancy } from '@/lib/ct01DownloadService';

const file = (id: string, kind: ResidenceDossierFile['kind'], contract: string | null = 'ct1'): ResidenceDossierFile => ({
  id, kind, organization_id: 'o', building_id: 'b1', customer_id: kind === 'OWNERSHIP' ? null : 'c1', contract_id: contract,
  bucket_id: 'residence-docs', object_name: `u/${id}.webp`, file_name: `${id}.jpg`, content_type: 'image/webp',
  size_bytes: 1, sort_order: 0, created_at: '2026-09-15T00:00:00Z',
  lease_term_from: null, lease_term_to: null, lease_term_source: null,
});
const customer = { id: 'c1', full_name: 'Nguyễn Gia Bình', date_of_birth: '2008-10-18', gender: 'Nam', id_number: '034208012538', phone: '0843181008', email: '' };
const tenancy: CT01Tenancy = {
  roomId: 'r1', roomNumber: 'MADRID 4', contractId: 'ct1',
  building: { id: 'b1', name: '950NK', street_address: '950/65 Nguyễn Kiệm, Khu Phố 14, Phường Hạnh Thông, TP Hồ Chí Minh', ward: 'Phường 3', district: 'Quận Gò Vấp', province: 'Thành phố Hồ Chí Minh' },
};
const customerFiles = [file('a', 'CT01'), file('b', 'LEASE')];
const ownershipFiles = [file('g1', 'OWNERSHIP', null), file('g2', 'OWNERSHIP', null)];

beforeEach(() => {
  boundary.detect.mockReset().mockReturnValue('1.0.0');
  boundary.send.mockReset().mockResolvedValue(undefined);
  boundary.sign.mockReset().mockImplementation(async (v: string) => `${v}?signed`);
  boundary.toastError.mockReset();
  boundary.toastSuccess.mockReset();
});
afterEach(cleanup);

describe('pickDossierFilesForContract', () => {
  it('ưu tiên ảnh đúng hợp đồng, không có thì lấy mọi ảnh của khách', () => {
    const files = [file('old', 'CT01', 'ct0'), file('new', 'CT01', 'ct1'), file('l', 'LEASE', 'ct0')];
    expect(pickDossierFilesForContract(files, ownershipFiles, 'ct1').map(f => f.id)).toEqual(['new', 'l', 'g1', 'g2']);
  });
});

describe('TamTruDvcButton', () => {
  it('chưa cài extension thì hiện hướng dẫn, không gửi', async () => {
    boundary.detect.mockReturnValue(null);
    render(<TamTruDvcButton customer={customer} tenancy={tenancy} customerFiles={customerFiles} ownershipFiles={ownershipFiles} />);
    fireEvent.click(screen.getByRole('button', { name: /đăng ký tạm trú trên dvc/i }));
    await waitFor(() => expect(screen.getByText(/Load unpacked/)).toBeTruthy());
    expect(boundary.send).not.toHaveBeenCalled();
  });

  it('ký URL, dựng gói và gửi cho extension', async () => {
    render(<TamTruDvcButton customer={customer} tenancy={tenancy} customerFiles={customerFiles} ownershipFiles={ownershipFiles} />);
    fireEvent.change(screen.getByLabelText(/hạn tạm trú trên dvc/i), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /đăng ký tạm trú trên dvc/i }));
    await waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
    const payload = boundary.send.mock.calls[0][0];
    expect(payload.person.idNumber).toBe('034208012538');
    expect(payload.receive).toEqual({ provinceName: 'Thành phố Hồ Chí Minh', wardName: 'Phường Hạnh Thông' });
    expect(payload.attachments.map((a: { kind: string; url: string }) => [a.kind, a.url])).toEqual([
      ['CT01', 'https://x/residence-docs/u/a.webp?signed'], ['LEASE', 'https://x/residence-docs/u/b.webp?signed'],
      ['OWNERSHIP', 'https://x/residence-docs/u/g1.webp?signed'], ['OWNERSHIP', 'https://x/residence-docs/u/g2.webp?signed'],
    ]);
    expect(payload.tempResidentTo).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(boundary.toastSuccess).toHaveBeenCalled();
  });

  it('có hạn đọc từ hợp đồng thì khai đúng ngày đó, giấu ô chọn số tháng', async () => {
    render(<TamTruDvcButton customer={customer} tenancy={tenancy} customerFiles={customerFiles}
      ownershipFiles={ownershipFiles} tempResidentTo="14/09/2028" />);
    expect(screen.queryByLabelText(/hạn tạm trú trên dvc/i)).toBeNull();
    expect(screen.getByText(/14\/09\/2028/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /đăng ký tạm trú trên dvc/i }));
    await waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
    expect(boundary.send.mock.calls[0][0].tempResidentTo).toBe('14/09/2028');
  });

  it('hạn đọc được đã quá hạn thì bỏ qua, quay về số tháng người dùng chọn', async () => {
    render(<TamTruDvcButton customer={customer} tenancy={tenancy} customerFiles={customerFiles}
      ownershipFiles={ownershipFiles} tempResidentTo="01/01/2020" />);
    // Ô chọn số tháng phải hiện lại, kẻo người dùng không còn đường sửa.
    expect(screen.getByLabelText(/hạn tạm trú trên dvc/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /đăng ký tạm trú trên dvc/i }));
    await waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
    expect(boundary.send.mock.calls[0][0].tempResidentTo).not.toBe('01/01/2020');
  });

  it('thiếu ảnh chủ quyền thì báo lỗi rõ và không gửi', async () => {
    render(<TamTruDvcButton customer={customer} tenancy={tenancy} customerFiles={customerFiles} ownershipFiles={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /đăng ký tạm trú trên dvc/i }));
    await waitFor(() => expect(boundary.toastError).toHaveBeenCalledWith(expect.stringMatching(/chỗ ở hợp pháp/i)));
    expect(boundary.send).not.toHaveBeenCalled();
  });

  it('extension không phản hồi thì toast lỗi của cầu nối', async () => {
    boundary.send.mockRejectedValue(new Error('Extension iHome Tạm trú không phản hồi.'));
    render(<TamTruDvcButton customer={customer} tenancy={tenancy} customerFiles={customerFiles} ownershipFiles={ownershipFiles} />);
    fireEvent.click(screen.getByRole('button', { name: /đăng ký tạm trú trên dvc/i }));
    await waitFor(() => expect(boundary.toastError).toHaveBeenCalledWith(expect.stringMatching(/không phản hồi/i)));
  });
});
