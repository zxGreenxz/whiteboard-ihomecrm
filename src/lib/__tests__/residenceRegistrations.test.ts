// Sổ hồ sơ tạm trú: kiểm mã, đổi ngày, và hình dạng dữ liệu ghi xuống.
import { afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ from: vi.fn(), user: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: boundary.from } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: boundary.user }));

import { ghiHoSoTamTru, maHoSoHopLe, ngayIso, ngayVn, RegistrationError } from '@/lib/residenceRegistrations';

afterEach(() => vi.clearAllMocks());

describe('maHoSoHopLe', () => {
  it('nhận mã thật của cổng', () => {
    expect(maHoSoHopLe('G01.899.909-260916-890028')).toBe(true);
    expect(maHoSoHopLe(' G01.899.909-260916-890025 ')).toBe(true);
  });
  it('từ chối rác, mã quá ngắn và thứ không phải chuỗi', () => {
    expect(maHoSoHopLe('')).toBe(false);
    expect(maHoSoHopLe('abc')).toBe(false);
    expect(maHoSoHopLe('<script>alert(1)</script>')).toBe(false);
    expect(maHoSoHopLe(null)).toBe(false);
    expect(maHoSoHopLe(12345)).toBe(false);
  });
});

describe('đổi ngày', () => {
  it('ngayIso nhận dd/mm/yyyy, còn lại trả null cho cột date', () => {
    expect(ngayIso('14/09/2028')).toBe('2028-09-14');
    expect(ngayIso('')).toBeNull();
    expect(ngayIso('2028-09-14')).toBeNull();
    expect(ngayIso(undefined)).toBeNull();
  });
  it('ngayVn đổi ngược để hiện lên giao diện', () => {
    expect(ngayVn('2028-09-14')).toBe('14/09/2028');
    expect(ngayVn('2026-09-16T02:25:16Z')).toBe('16/09/2026');
    expect(ngayVn(null)).toBe('');
  });
});

describe('ghiHoSoTamTru', () => {
  const dungChuoi = (ket: { data?: unknown; error?: { code?: string } | null }) => {
    const single = vi.fn().mockResolvedValue(ket);
    const select = vi.fn().mockReturnValue({ single });
    const upsert = vi.fn().mockReturnValue({ select });
    boundary.from.mockReturnValue({ upsert });
    return { upsert, select, single };
  };

  it('ghi đúng trường và chốt trùng theo (công ty, mã hồ sơ)', async () => {
    boundary.user.mockResolvedValue({ id: 'u1' });
    const { upsert } = dungChuoi({ data: { id: 'r1', subm_code: 'G01.899.909-260916-890028' }, error: null });
    await ghiHoSoTamTru({
      customerId: 'c1', buildingId: 'b1', organizationId: 'o1', contractId: 'ct1',
      submCode: ' G01.899.909-260916-890028 ', receiveOrg: 'Công an Phường Hạnh Thông',
      tempResidentFrom: '16/09/2026', tempResidentTo: '14/09/2028', submittedAt: '2026-09-16T02:25:16.000Z',
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'c1', building_id: 'b1', organization_id: 'o1', contract_id: 'ct1',
      subm_code: 'G01.899.909-260916-890028',
      temp_resident_from: '2026-09-16', temp_resident_to: '2028-09-14',
      submitted_at: '2026-09-16T02:25:16.000Z', created_by: 'u1',
    }), { onConflict: 'organization_id,subm_code' });
  });

  it('chặn mã rác trước khi chạm cơ sở dữ liệu', async () => {
    boundary.user.mockResolvedValue({ id: 'u1' });
    await expect(ghiHoSoTamTru({ customerId: 'c1', buildingId: 'b1', organizationId: 'o1', submCode: 'rác!!' }))
      .rejects.toBeInstanceOf(RegistrationError);
    expect(boundary.from).not.toHaveBeenCalled();
  });

  it('thiếu quyền thì nói rõ là thiếu quyền', async () => {
    boundary.user.mockResolvedValue({ id: 'u1' });
    dungChuoi({ data: null, error: { code: '42501' } });
    await expect(ghiHoSoTamTru({ customerId: 'c1', buildingId: 'b1', organizationId: 'o1', submCode: 'G01.899.909-260916-890028' }))
      .rejects.toThrow(/không có quyền/i);
  });

  it('mất phiên đăng nhập thì không ghi', async () => {
    boundary.user.mockResolvedValue(null);
    await expect(ghiHoSoTamTru({ customerId: 'c1', buildingId: 'b1', organizationId: 'o1', submCode: 'G01.899.909-260916-890028' }))
      .rejects.toThrow(/đăng nhập/i);
    expect(boundary.from).not.toHaveBeenCalled();
  });
});
