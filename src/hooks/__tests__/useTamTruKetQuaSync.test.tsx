// @vitest-environment jsdom
// Ghi mã hồ sơ vào sổ NGAY khi extension gõ cửa, không chờ người dùng chuyển tab.
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ lay: vi.fn(), xacNhan: vi.fn(), ghi: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/tamTruBridge', () => ({ layKetQuaNop: boundary.lay, xacNhanDaGhiSo: boundary.xacNhan }));
vi.mock('@/lib/residenceRegistrations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/residenceRegistrations')>()),
  ghiHoSoTamTru: boundary.ghi,
}));
vi.mock('sonner', () => ({ toast: { success: boundary.toast, error: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn() }));

import { TAM_TRU_TIN_HIEU, TamTruKetQuaSync } from '@/hooks/useTamTruKetQuaSync';

const ketQua = (over: Record<string, unknown> = {}) => ({
  submCode: 'G01.899.909-260916-890028', customerId: 'c1', buildingId: 'b1', organizationId: 'o1',
  contractId: 'ct1', receiveOrg: 'Công an Phường Hạnh Thông',
  tempResidentFrom: '16/09/2026', tempResidentTo: '14/09/2028', submittedAt: '2026-09-16T02:25:16.000Z', ...over,
});

function dung() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TamTruKetQuaSync /></QueryClientProvider>);
}

const goCua = () => window.postMessage({ type: TAM_TRU_TIN_HIEU }, '*');

beforeEach(() => {
  boundary.lay.mockReset().mockResolvedValue([]);
  boundary.xacNhan.mockReset().mockResolvedValue(undefined);
  boundary.ghi.mockReset().mockResolvedValue({ id: 'r1' });
  boundary.toast.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('TamTruKetQuaSync', () => {
  it('ghi ngay khi extension gõ cửa, rồi mới báo extension xoá', async () => {
    boundary.lay.mockResolvedValue([ketQua()]);
    dung();
    goCua();
    await waitFor(() => expect(boundary.ghi).toHaveBeenCalledTimes(1));
    expect(boundary.ghi.mock.calls[0][0]).toMatchObject({
      customerId: 'c1', buildingId: 'b1', organizationId: 'o1', contractId: 'ct1',
      submCode: 'G01.899.909-260916-890028', tempResidentTo: '14/09/2028',
    });
    await waitFor(() => expect(boundary.xacNhan).toHaveBeenCalledWith(['G01.899.909-260916-890028']));
    expect(boundary.toast).toHaveBeenCalled();
  });

  it('ghi hụt thì KHÔNG báo xoá — mã phải còn để lần sau ghi lại', async () => {
    boundary.lay.mockResolvedValue([ketQua()]);
    boundary.ghi.mockRejectedValue(new Error('mất mạng'));
    dung();
    goCua();
    await waitFor(() => expect(boundary.ghi).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(boundary.xacNhan).not.toHaveBeenCalled();
    expect(boundary.toast).not.toHaveBeenCalled();
  });

  it('bỏ qua gói thiếu khoá ghi sổ hoặc mã rác', async () => {
    boundary.lay.mockResolvedValue([
      ketQua({ buildingId: undefined }),
      ketQua({ submCode: 'rác', customerId: 'c2' }),
      ketQua({ customerId: '' }),
    ]);
    dung();
    goCua();
    await new Promise((r) => setTimeout(r, 20));
    expect(boundary.ghi).not.toHaveBeenCalled();
  });

  it('extension chưa cài thì im lặng, không toast lỗi', async () => {
    boundary.lay.mockRejectedValue(new Error('chưa sẵn sàng'));
    dung();
    goCua();
    await new Promise((r) => setTimeout(r, 20));
    expect(boundary.ghi).not.toHaveBeenCalled();
    expect(boundary.toast).not.toHaveBeenCalled();
  });

  it('bỏ qua tin trên window không phải tín hiệu của extension', async () => {
    boundary.lay.mockResolvedValue([ketQua()]);
    dung();
    await waitFor(() => expect(boundary.lay).toHaveBeenCalled());
    boundary.lay.mockClear();
    window.postMessage({ type: 'CAI_GI_DO_KHAC' }, '*');
    await new Promise((r) => setTimeout(r, 20));
    expect(boundary.lay).not.toHaveBeenCalled();
  });
});
