// @vitest-environment jsdom
// Nút "Huỷ đăng ký tạm trú trên DVC": chỉ gửi gói xoá (version 2) cho extension đủ mới,
// bản cũ thì chỉ cách nạp lại thay vì để nó điền nhầm sang form đăng ký.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ detect: vi.fn(), send: vi.fn(), sign: vi.fn(), toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/lib/tamTruBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tamTruBridge')>()),
  detectTamTruExtension: boundary.detect, sendTamTruPayload: boundary.send,
}));
vi.mock('@/lib/storage', () => ({
  createSignedUrlFromStored: boundary.sign,
  getPublicUrl: (b: string, p: string) => `https://x/${b}/${p}`,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: boundary.toastError, success: boundary.toastSuccess } }));

import TamTruXoaDvcButton from '../TamTruXoaDvcButton';
import type { ResidenceDossierFile } from '@/lib/residenceDossierFiles';
import type { CT01XoaTenancy } from '@/lib/ct01DownloadService';

const file = (id: string, kind: ResidenceDossierFile['kind']): ResidenceDossierFile => ({
  id, kind, organization_id: 'o1', building_id: 'b1', customer_id: 'c1', contract_id: 'ct1',
  bucket_id: 'residence-docs', object_name: `u/${id}.jpg`, file_name: `${id}.jpg`, content_type: 'image/jpeg',
  size_bytes: 1, sort_order: 0, created_at: '2026-10-07T00:00:00Z',
  lease_term_from: null, lease_term_to: null, lease_term_source: null,
});
const customer = { id: 'c1', full_name: 'Lê Quốc Duy', date_of_birth: '2006-05-23', gender: 'MALE', id_number: '072206008594', phone: '0919859134', email: null };
const tenancy: CT01XoaTenancy = {
  roomId: 'r1', roomNumber: '401', contractId: 'ct1', contractStatus: 'TERMINATED', endDate: '2026-10-05',
  building: { id: 'b1', name: '32PVC', organization_id: 'o1', street_address: '32/28/4 Phạm Văn Chiêu, Khu Phố 21, Phường Thông Tây Hội, TP. Hồ Chí Minh', ward: 'Phường 8', district: 'Gò Vấp', province: 'Hồ Chí Minh' },
};
const files = [file('ct01', 'CT01'), file('huy', 'CT01_XOA'), file('tl', 'THANH_LY')];

beforeEach(() => {
  boundary.detect.mockReset().mockReturnValue('1.1.0');
  boundary.send.mockReset().mockResolvedValue(undefined);
  boundary.sign.mockReset().mockImplementation(async (v: string) => `${v}?signed`);
  boundary.toastError.mockReset();
  boundary.toastSuccess.mockReset();
});
afterEach(cleanup);

it('extension bản cũ (chỉ biết đăng ký) thì hướng dẫn nạp lại, không gửi gì', async () => {
  boundary.detect.mockReturnValue('1.0.0');
  render(<TamTruXoaDvcButton customer={customer} tenancy={tenancy} customerFiles={files} />);
  fireEvent.click(screen.getByRole('button', { name: 'Huỷ đăng ký tạm trú trên DVC' }));
  await waitFor(() => expect(screen.getByText('Cập nhật extension iHome Tạm trú')).toBeTruthy());
  expect(screen.getByText(/bản 1\.0\.0/)).toBeTruthy();
  expect(boundary.send).not.toHaveBeenCalled();
});

it('chưa cài extension thì hiện hướng dẫn cài', async () => {
  boundary.detect.mockReturnValue(null);
  render(<TamTruXoaDvcButton customer={customer} tenancy={tenancy} customerFiles={files} />);
  fireEvent.click(screen.getByRole('button', { name: 'Huỷ đăng ký tạm trú trên DVC' }));
  await waitFor(() => expect(screen.getByText(/Load unpacked/)).toBeTruthy());
  expect(boundary.send).not.toHaveBeenCalled();
});

it('gửi gói xoá version 2 với đúng hai ảnh đã ký', async () => {
  render(<TamTruXoaDvcButton customer={customer} tenancy={tenancy} customerFiles={files} />);
  fireEvent.click(screen.getByRole('button', { name: 'Huỷ đăng ký tạm trú trên DVC' }));
  await waitFor(() => expect(boundary.send).toHaveBeenCalledTimes(1));
  const payload = boundary.send.mock.calls[0]?.[0];
  expect(payload).toMatchObject({
    version: 2, procedure: 'TAMTRU_06', caseCode: 'TAT-XOA-14', customerId: 'c1', buildingId: 'b1', organizationId: 'o1', contractId: 'ct1',
    receive: { provinceName: 'Thành phố Hồ Chí Minh', wardName: 'Phường Thông Tây Hội' },
    person: { fullName: 'Lê Quốc Duy', dob: '23/05/2006', genderCode: '2', idNumber: '072206008594' },
  });
  expect(payload.attachments.map((a: { kind: string; fileName: string }) => `${a.kind}:${a.fileName}`)).toEqual(['CT01_XOA:huy.jpg', 'THANH_LY:tl.jpg']);
  expect(boundary.toastSuccess).toHaveBeenCalled();
});

it('thiếu biên bản thanh lý thì báo rõ, không gửi', async () => {
  render(<TamTruXoaDvcButton customer={customer} tenancy={tenancy} customerFiles={[file('huy', 'CT01_XOA')]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Huỷ đăng ký tạm trú trên DVC' }));
  await waitFor(() => expect(boundary.toastError).toHaveBeenCalledWith(expect.stringMatching(/biên bản thanh lý/)));
  expect(boundary.send).not.toHaveBeenCalled();
});
