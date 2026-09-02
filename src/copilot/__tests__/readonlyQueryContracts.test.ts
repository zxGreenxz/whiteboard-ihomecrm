// Customer and expiring-contract tools use the typed server RPC boundary.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc, from } }));

const { buildRegistryDefinitions } = await import('../tools/registry');
const { COPILOT_ROLLOUT_CONTRACTS } = await import('../featureFlags');
import type { PermissionsMap } from '@/lib/permissions';

const SUPER = { __superadmin: true } as unknown as PermissionsMap;
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const ctx = { perms: SUPER, organizationId: ORG };

const tool = (name: string) => {
  const found = buildRegistryDefinitions().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

describe('tim_khach_hang - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_customer_search_v1 with selected org and search text', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await tool('tim_khach_hang').execute({ tu_khoa: 'An' }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_customer_search_v1', {
      p_organization_id: ORG,
      p_search: 'An',
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('formats flat safe rows and masks the phone', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          customer_id: 'c1',
          customer_name: 'Nguyen An',
          phone: '0901234567',
          room_name: 'A101',
          building_name: 'Toa A',
        },
      ],
      error: null,
    });
    const result = await tool('tim_khach_hang').execute({ tu_khoa: 'An' }, ctx);
    expect(result).toContain('Nguyen An');
    expect(result).toContain('A101');
    expect(result).toContain('Toa A');
    expect(result).not.toContain('0901234567');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(tool('tim_khach_hang').execute({ tu_khoa: 'none' }, ctx)).resolves.toMatch(/kh.ng t.m th.y/i);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('tim_khach_hang').execute({ tu_khoa: 'An' }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('hop_dong_sap_het_han - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_expiring_contracts_v1 with local date and window', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await tool('hop_dong_sap_het_han').execute({ so_ngay: 30 }, ctx);
    expect(rpc).toHaveBeenCalledWith(
      'copilot_expiring_contracts_v1',
      expect.objectContaining({ p_organization_id: ORG, p_window_days: 30 }),
    );
    expect(rpc.mock.calls[0][1].p_as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(from).not.toHaveBeenCalled();
  });

  it('formats flat rows with representative name and links', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          contract_id: 'h1',
          contract_number: 'HD001',
          customer_name: 'Nguoi Dai Dien',
          end_date: '2026-09-01',
          effective_end_date: '2026-09-01',
          room_name: 'B202',
          building_name: 'Toa B',
        },
      ],
      error: null,
    });
    const result = await tool('hop_dong_sap_het_han').execute({ so_ngay: 30 }, ctx);
    expect(result).toContain('Nguoi Dai Dien');
    expect(result).toContain('B202');
    expect(result).toContain('Toa B');
    expect(result).toContain('/contracts/h1');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(tool('hop_dong_sap_het_han').execute({ so_ngay: 7 }, ctx)).resolves.toContain('7');
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('hop_dong_sap_het_han').execute({ so_ngay: 7 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('tim_hop_dong - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_contract_search_v1 with org, folded filters and the row cap', async () => {
    rpc.mockResolvedValue({ data: { gioi_han: 20, so_luong: 0, hop_dong: [] }, error: null });
    await tool('tim_hop_dong').execute({ tu_khoa: ' HD001 ', trang_thai: 'dang_thue', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_contract_search_v1', {
      p_organization_id: ORG,
      p_query: 'HD001',
      // The tool sends the DB enum, never the user-facing Vietnamese key.
      p_status: 'ACTIVE',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('sends null instead of an empty filter', async () => {
    rpc.mockResolvedValue({ data: { gioi_han: 20, so_luong: 0, hop_dong: [] }, error: null });
    await tool('tim_hop_dong').execute({ tu_khoa: '   ', so_luong: 20 }, ctx);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_query: null, p_status: null });
  });

  it('formats safe flat rows with a deep link', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 1,
        hop_dong: [
          {
            hop_dong_id: 'h1',
            so_hop_dong: 'HD001',
            khach_hang: 'Nguyen An',
            phong: 'A101',
            toa_nha: 'Toa A',
            ngay_bat_dau: '2026-01-01',
            ngay_ket_thuc: '2026-12-31',
            trang_thai: 'ACTIVE',
            tien_thue: 5000000,
            tien_coc: 5000000,
            coc_da_thu: 5000000,
          },
        ],
      },
      error: null,
    });
    const result = await tool('tim_hop_dong').execute({ so_luong: 20 }, ctx);
    expect(result).toContain('HD001');
    expect(result).toContain('Nguyen An');
    expect(result).toContain('A101');
    expect(result).toContain('/contracts/h1');
    expect(result).toContain('đang thuê');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({ data: { gioi_han: 20, so_luong: 0, hop_dong: [] }, error: null });
    await expect(tool('tim_hop_dong').execute({ tu_khoa: 'none', so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng t.m th.y/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('tim_hop_dong').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('chi_tiet_hop_dong - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_contract_detail_v1 with the selected org and the contract id', async () => {
    rpc.mockResolvedValue({ data: { tim_thay: false, hop_dong: null, hoa_don: [] }, error: null });
    await tool('chi_tiet_hop_dong').execute(
      { hop_dong_id: 'aaaa4000-0000-4000-8000-000000000011' },
      ctx,
    );
    expect(rpc).toHaveBeenCalledWith('copilot_contract_detail_v1', {
      p_organization_id: ORG,
      p_contract_id: 'aaaa4000-0000-4000-8000-000000000011',
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('answers not-found and out-of-scope the same way', async () => {
    rpc.mockResolvedValue({ data: { tim_thay: false, hop_dong: null, hoa_don: [] }, error: null });
    const result = await tool('chi_tiet_hop_dong').execute(
      { hop_dong_id: 'aaaa4000-0000-4000-8000-000000000011' },
      ctx,
    );
    expect(result).toMatch(/kh.ng t.m th.y/i);
    expect(result).not.toMatch(/kh.ng c. quy.n|permission/i);
  });

  it('renders the deposit ledger and the latest invoices', async () => {
    rpc.mockResolvedValue({
      data: {
        tim_thay: true,
        hop_dong: {
          hop_dong_id: 'h1',
          so_hop_dong: 'HD001',
          khach_hang: 'Nguyen An',
          so_nguoi_o: 2,
          phong: 'A101',
          toa_nha: 'Toa A',
          ngay_ky: '2025-12-20',
          ngay_bat_dau: '2026-01-01',
          ngay_ket_thuc: '2026-12-31',
          ngay_ket_thuc_thuc_te: null,
          ngay_du_kien_tra_phong: null,
          trang_thai: 'ACTIVE',
          chu_ky_thanh_toan: 'MONTHLY',
          tien_thue: 5000000,
          tien_coc: 5000000,
          coc_da_thu: 3000000,
          coc_con_thieu: 2000000,
        },
        hoa_don: [
          {
            hoa_don_id: 'i1',
            so_hoa_don: 'HD-2026-07',
            ky: '2026-07',
            han_thanh_toan: '2026-07-05',
            tong_tien: 5500000,
            da_tra: 5500000,
            con_lai: 0,
            trang_thai: 'PAID',
          },
        ],
      },
      error: null,
    });
    const result = await tool('chi_tiet_hop_dong').execute(
      { hop_dong_id: 'aaaa4000-0000-4000-8000-000000000011' },
      ctx,
    );
    expect(result).toContain('HD001');
    expect(result).toContain('HD-2026-07');
    expect(result).toMatch(/c.n thi.u/i);
    expect(result).toContain('/contracts/h1');
  });
});

describe('tim_phieu_thu_chi - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_income_expense_search_v1 with mapped enums and the row cap', async () => {
    rpc.mockResolvedValue({ data: { gioi_han: 20, so_luong: 0, phieu: [] }, error: null });
    await tool('tim_phieu_thu_chi').execute(
      { tu_khoa: 'dien', tu_ngay: '2026-07-01', den_ngay: '2026-07-31', loai: 'chi', trang_thai: 'cho_xet', so_luong: 20 },
      ctx,
    );
    expect(rpc).toHaveBeenCalledWith('copilot_income_expense_search_v1', {
      p_organization_id: ORG,
      p_query: 'dien',
      p_tu: '2026-07-01',
      p_den: '2026-07-31',
      p_loai: 'EXPENSE',
      p_trang_thai: 'UNAPPROVED',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('masks the cashbook name because account numbers live inside it', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 1,
        phieu: [
          {
            phieu_id: 'p1',
            ma_phieu: 'PC-0001',
            loai: 'EXPENSE',
            ten: 'Tien dien thang 7',
            so_tien: 1200000,
            ngay: '2026-07-10',
            hang_muc: 'Dien nuoc',
            so_quy: 'TK 19036789456013 VCB',
            trang_thai: 'UNAPPROVED',
            trang_thai_ghi_nhan: 'UNPOSTED',
            nguoi_tao: 'Ke toan A',
            toa_nha: 'Toa A',
          },
        ],
      },
      error: null,
    });
    const result = await tool('tim_phieu_thu_chi').execute({ so_luong: 20 }, ctx);
    expect(result).toContain('PC-0001');
    expect(result).toContain('Dien nuoc');
    expect(result).not.toContain('19036789456013');
    expect(result).toContain('/income-expense');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({ data: { gioi_han: 20, so_luong: 0, phieu: [] }, error: null });
    await expect(tool('tim_phieu_thu_chi').execute({ so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng t.m th.y/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('tim_phieu_thu_chi').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('hop_cho_duyet - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_pending_requests_v1 with the selected org and the row cap', async () => {
    rpc.mockResolvedValue({ data: { gioi_han: 20, so_luong: 0, hop_cho: [] }, error: null });
    await tool('hop_cho_duyet').execute({ so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_pending_requests_v1', {
      p_organization_id: ORG,
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('lists what is waiting and points at the human screen', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 1,
        hop_cho: [
          {
            yeu_cau_id: 'r1',
            gui_luc: '2026-07-10T03:00:00Z',
            so_tien: 1200000,
            phieu_id: 'p1',
            ma_phieu: 'PC-0001',
            ten_phieu: 'Tien dien thang 7',
            loai: 'EXPENSE',
            nguoi_lap: 'Ke toan A',
            buoc: 1,
          },
        ],
      },
      error: null,
    });
    const result = await tool('hop_cho_duyet').execute({ so_luong: 20 }, ctx);
    expect(result).toContain('PC-0001');
    expect(result).toContain('Ke toan A');
    expect(result).toContain('/approvals');
  });

  it('says the inbox is empty instead of returning nothing', async () => {
    rpc.mockResolvedValue({ data: { gioi_han: 20, so_luong: 0, hop_cho: [] }, error: null });
    await expect(tool('hop_cho_duyet').execute({ so_luong: 20 }, ctx)).resolves.toMatch(/kh.ng c. phi.u/i);
  });
});

describe('tim_khach_hen - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_lead_search_v1 with the DB enum, never the Vietnamese key', async () => {
    rpc.mockResolvedValue({ data: { gioi_han: 20, so_luong: 0, khach_hen: [] }, error: null });
    await tool('tim_khach_hen').execute({ tu_khoa: '  An  ', trang_thai: 'da_hen', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_lead_search_v1', {
      p_organization_id: ORG,
      p_query: 'An',
      p_trang_thai: 'B2_APPOINTMENT',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('sends null instead of an empty filter', async () => {
    rpc.mockResolvedValue({ data: { gioi_han: 20, so_luong: 0, khach_hen: [] }, error: null });
    await tool('tim_khach_hen').execute({ tu_khoa: '   ', so_luong: 20 }, ctx);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_query: null, p_trang_thai: null });
  });

  it('masks the phone the same way the customer tool does', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 1,
        khach_hen: [
          {
            khach_hen_id: 'l1',
            khach_hang: 'Nguyen An',
            dien_thoai: '0901234567',
            trang_thai: 'B2_APPOINTMENT',
            nguon: 'ZALO',
            toa_nha: 'Toa A',
            phong: 'A101',
            ngay_hen: '2026-09-05',
            lien_he_cuoi: null,
            hen_lien_he_toi: '2026-09-04',
            ngan_sach_tu: 3000000,
            ngan_sach_den: 5000000,
            ngay_tao: '2026-09-01',
          },
        ],
      },
      error: null,
    });
    const result = await tool('tim_khach_hen').execute({ so_luong: 20 }, ctx);
    expect(result).toContain('Nguyen An');
    expect(result).toContain('A101');
    expect(result).not.toContain('0901234567');
    expect(result).toContain('/leads');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({ data: { gioi_han: 20, so_luong: 0, khach_hen: [] }, error: null });
    await expect(tool('tim_khach_hen').execute({ tu_khoa: 'none', so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng t.m th.y/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('tim_khach_hen').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('chi_so_cong_to - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_meter_readings_v1 with the settlement month and the row cap', async () => {
    rpc.mockResolvedValue({
      data: { ky: '2026-07', gioi_han: 20, so_luong: 0, tong_hop: [], chi_so: [] },
      error: null,
    });
    await tool('chi_so_cong_to').execute({ ky: '2026-07', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_meter_readings_v1', {
      p_organization_id: ORG,
      p_ky: '2026-07',
      p_building_id: null,
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('reports the period total from tong_hop, not from the capped list', async () => {
    // The list is one row; the period total says 75. A formatter that counted the
    // rows it printed would answer 20 here and be wrong by construction.
    rpc.mockResolvedValue({
      data: {
        ky: '2026-07',
        gioi_han: 1,
        so_luong: 1,
        tong_hop: [{ loai: 'ELECTRICITY', so_dong: 3, tong_tieu_thu: 75 }],
        chi_so: [
          {
            chi_so_id: 'm1',
            ma_phieu: 'CS-001',
            toa_nha: 'Toa A',
            phong: 'A101',
            loai: 'ELECTRICITY',
            chi_so_dau: 100,
            chi_so_cuoi: 120,
            tieu_thu: 20,
            ngay_ghi: '2026-07-31',
            trang_thai: 'UNAPPROVED',
          },
        ],
      },
      error: null,
    });
    const result = await tool('chi_so_cong_to').execute({ ky: '2026-07', so_luong: 1 }, ctx);
    expect(result).toContain('2026-07');
    expect(result).toContain('75');
    expect(result).toContain('A101');
    expect(result).toContain('/meter-readings');
  });

  it('says the period is empty instead of returning nothing', async () => {
    rpc.mockResolvedValue({
      data: { ky: '2099-01', gioi_han: 20, so_luong: 0, tong_hop: [], chi_so: [] },
      error: null,
    });
    await expect(tool('chi_so_cong_to').execute({ ky: '2099-01', so_luong: 20 }, ctx)).resolves.toContain(
      '2099-01',
    );
  });
});

describe('tim_xe - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_vehicle_search_v1 with the selected org and the row cap', async () => {
    rpc.mockResolvedValue({ data: { gioi_han: 20, so_luong: 0, xe: [] }, error: null });
    await tool('tim_xe').execute({ tu_khoa: '59P1-12345', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_vehicle_search_v1', {
      p_organization_id: ORG,
      p_query: '59P1-12345',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('formats plate, owner and room with a deep link', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 1,
        xe: [
          {
            xe_id: 'v1',
            bien_so: '59P1-12345',
            loai_xe: 'MOTORBIKE',
            mo_ta: 'Honda Vision do',
            chu_xe: 'Nguyen An',
            phong: 'A101',
            toa_nha: 'Toa A',
            phi_gui: 100000,
            ma_the: 'THE-01',
          },
        ],
      },
      error: null,
    });
    const result = await tool('tim_xe').execute({ so_luong: 20 }, ctx);
    expect(result).toContain('59P1-12345');
    expect(result).toContain('Nguyen An');
    expect(result).toMatch(/xe m.y/i);
    expect(result).toContain('/vehicles');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({ data: { gioi_han: 20, so_luong: 0, xe: [] }, error: null });
    await expect(tool('tim_xe').execute({ tu_khoa: 'none', so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng t.m th.y/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('tim_xe').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('cong_viec - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_tasks_v1 with the DB status and the row cap', async () => {
    rpc.mockResolvedValue({ data: { gioi_han: 20, so_luong: 0, cong_viec: [] }, error: null });
    await tool('cong_viec').execute({ trang_thai: 'dang_lam', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_tasks_v1', {
      p_organization_id: ORG,
      p_trang_thai: 'IN_PROGRESS',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('marks the caller own job and flags an overdue one', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 1,
        cong_viec: [
          {
            cong_viec_id: 'j1',
            ma: 'CV-001',
            tieu_de: 'Sua voi nuoc',
            trang_thai: 'IN_PROGRESS',
            muc_do: 'URGENT',
            loai: 'Sua chua',
            nguoi_lam: 'Tho A',
            cua_toi: true,
            han: '2020-01-01T00:00:00Z',
            phong: 'A101',
            toa_nha: 'Toa A',
          },
        ],
      },
      error: null,
    });
    const result = await tool('cong_viec').execute({ so_luong: 20 }, ctx);
    expect(result).toContain('CV-001');
    expect(result).toContain('BẠN làm');
    expect(result).toMatch(/qu. h.n/i);
    expect(result).toContain('/tasks');
  });

  it('says there is nothing instead of returning an empty list', async () => {
    rpc.mockResolvedValue({ data: { gioi_han: 20, so_luong: 0, cong_viec: [] }, error: null });
    await expect(tool('cong_viec').execute({ so_luong: 20 }, ctx)).resolves.toMatch(/kh.ng c. c.ng vi.c/i);
  });
});

describe('ton_kho_vat_tu - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_material_stock_v1 with the selected org and the row cap', async () => {
    rpc.mockResolvedValue({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_mat_hang: 0, so_mat_hang_thieu: 0, gia_tri_ton: 0 }, vat_tu: [] },
      error: null,
    });
    await tool('ton_kho_vat_tu').execute({ tu_khoa: ' bong den ', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_material_stock_v1', {
      p_organization_id: ORG,
      p_query: 'bong den',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('reports the whole-set totals next to the capped list', async () => {
    // 40 matching items, one row shown. The summary line must say 40, because the
    // number the model repeats to a human comes from the server aggregate and not
    // from counting what happened to fit.
    rpc.mockResolvedValue({
      data: {
        gioi_han: 1,
        so_luong: 1,
        tong_hop: { so_mat_hang: 40, so_mat_hang_thieu: 7, gia_tri_ton: 12000000 },
        vat_tu: [
          {
            vat_tu_id: 'm1',
            ma: 'VT-001',
            ten: 'Bong den LED',
            nhom: 'Dien',
            don_vi: 'cai',
            ton_kho: 2,
            muc_dat_lai: 10,
            duoi_muc: true,
            gia_binh_quan: 50000,
            gia_tri_ton: 100000,
          },
        ],
      },
      error: null,
    });
    const result = await tool('ton_kho_vat_tu').execute({ so_luong: 1 }, ctx);
    expect(result).toContain('40');
    expect(result).toContain('7');
    expect(result).toContain('Bong den LED');
    expect(result).toMatch(/d..i m.c/i);
    expect(result).toContain('/materials');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_mat_hang: 0, so_mat_hang_thieu: 0, gia_tri_ton: 0 }, vat_tu: [] },
      error: null,
    });
    await expect(tool('ton_kho_vat_tu').execute({ tu_khoa: 'none', so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng t.m th.y/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('ton_kho_vat_tu').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

// ── G1-C3: mười tool báo cáo ────────────────────────────────────────────────
//
// Mỗi tool được ghim ba thứ: nó gọi ĐÚNG RPC nào với đúng tham số, nó KHÔNG
// chạm `.from()`, và nó in ra con số TỔNG do server tính chứ không cộng lại từ
// danh sách đã bị cắt. Điểm thứ ba là điểm dễ trượt nhất: một formatter cộng
// `rows` thay vì đọc `tong_hop` vẫn "chạy đúng" trên mọi dữ liệu nhỏ hơn trần.

describe('bao_cao_phong_trong - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_report_vacant_rooms_v1 with the selected org and the row cap', async () => {
    rpc.mockResolvedValue({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_phong_trong: 0, tien_thue_bo_lo: 0, so_toa: 0 }, phong: [] },
      error: null,
    });
    await tool('bao_cao_phong_trong').execute({ so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_report_vacant_rooms_v1', {
      p_organization_id: ORG,
      p_building_id: null,
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('prints the whole-scope total, not a sum of the truncated list', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 1,
        so_luong: 1,
        // 9 phòng trong phạm vi, danh sách chỉ trả 1 — con số phải là 9.
        tong_hop: { so_phong_trong: 9, tien_thue_bo_lo: 45000000, so_toa: 2 },
        phong: [
          {
            phong_id: 'r1',
            phong: 'A101',
            toa_nha: 'Toa A',
            tang: 1,
            dien_tich: 25,
            gia_thue: 5000000,
            tinh_trang: 'AVAILABLE',
            trong_tu: '2026-07-01',
            so_ngay_trong: 40,
          },
        ],
      },
      error: null,
    });
    const result = await tool('bao_cao_phong_trong').execute({ so_luong: 1 }, ctx);
    expect(result).toContain('9');
    expect(result).toContain('A101');
    expect(result).toContain('40');
    expect(result).toContain('/reports/real-estate/vacant-rooms');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_phong_trong: 0, tien_thue_bo_lo: 0, so_toa: 0 }, phong: [] },
      error: null,
    });
    await expect(tool('bao_cao_phong_trong').execute({ so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng c. ph.ng n.o/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('bao_cao_phong_trong').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('bao_cao_gia_han - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('turns ky into a full month window instead of sending it raw', async () => {
    rpc.mockResolvedValue({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_su_kien: 0, so_gia_han: 0, so_chuyen_nhuong: 0, tong_tien_thue: 0 }, su_kien: [] },
      error: null,
    });
    await tool('bao_cao_gia_han').execute({ ky: '2026-02', so_luong: 20 }, ctx);
    // Tháng 2 năm nhuận: 29 ngày. Một hằng số 30/31 ở đây sẽ cắt hoặc nới kỳ.
    expect(rpc).toHaveBeenCalledWith('copilot_report_renewals_v1', {
      p_organization_id: ORG,
      p_tu: '2026-02-01',
      p_den: '2026-02-28',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('passes tu/den through when no ky is given', async () => {
    rpc.mockResolvedValue({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_su_kien: 0, so_gia_han: 0, so_chuyen_nhuong: 0, tong_tien_thue: 0 }, su_kien: [] },
      error: null,
    });
    await tool('bao_cao_gia_han').execute({ tu: '2026-01-01', den: '2026-03-31', so_luong: 20 }, ctx);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_tu: '2026-01-01', p_den: '2026-03-31' });
  });

  it('labels the two event kinds in Vietnamese', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 2,
        tong_hop: { so_su_kien: 2, so_gia_han: 1, so_chuyen_nhuong: 1, tong_tien_thue: 9000000 },
        su_kien: [
          {
            loai: 'RENEWAL',
            so_hop_dong: 'HD001',
            khach_hang: 'Nguyen An',
            phong: 'A101',
            toa_nha: 'Toa A',
            ngay: '2026-08-10',
            tien_thue: 5000000,
            ngay_ket_thuc_moi: '2027-08-10',
          },
          {
            loai: 'TRANSFER',
            so_hop_dong: 'HD002',
            khach_hang: 'Tran Binh',
            phong: 'B202',
            toa_nha: 'Toa B',
            ngay: '2026-08-12',
            tien_thue: 4000000,
            ngay_ket_thuc_moi: null,
          },
        ],
      },
      error: null,
    });
    const result = await tool('bao_cao_gia_han').execute({ ky: '2026-08', so_luong: 20 }, ctx);
    expect(result).toContain('gia hạn');
    expect(result).toContain('chuyển nhượng');
    expect(result).toContain('HD001');
    expect(result).toContain('/reports/real-estate/renewals-transfers');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_su_kien: 0, so_gia_han: 0, so_chuyen_nhuong: 0, tong_tien_thue: 0 }, su_kien: [] },
      error: null,
    });
    await expect(tool('bao_cao_gia_han').execute({ ky: '2099-01', so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng c. h.p ..ng n.o/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('bao_cao_gia_han').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('bao_cao_thanh_ly - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_report_terminations_v1 with the month window', async () => {
    rpc.mockResolvedValue({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_ca: 0, so_thanh_ly: 0, so_het_han: 0, tong_hoan_coc: 0, mau_so_hop_dong: 0, ty_le_phan_tram: 0 }, ca: [] },
      error: null,
    });
    await tool('bao_cao_thanh_ly').execute({ ky: '2026-08', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_report_terminations_v1', {
      p_organization_id: ORG,
      p_tu: '2026-08-01',
      p_den: '2026-08-31',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('reports the rate the SERVER computed, with its denominator', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 1,
        so_luong: 1,
        tong_hop: { so_ca: 7, so_thanh_ly: 5, so_het_han: 2, tong_hoan_coc: 12000000, mau_so_hop_dong: 140, ty_le_phan_tram: 5 },
        ca: [
          {
            hop_dong_id: 'h9',
            so_hop_dong: 'HD009',
            khach_hang: 'Le Cuong',
            phong: 'C303',
            toa_nha: 'Toa C',
            ngay_ket_thuc: '2026-08-20',
            trang_thai: 'TERMINATED',
            kieu_ket_thuc: 'EARLY',
            tien_thue: 6000000,
            hoan_coc: 3000000,
            so_ngay_o: 210,
          },
        ],
      },
      error: null,
    });
    const result = await tool('bao_cao_thanh_ly').execute({ ky: '2026-08', so_luong: 1 }, ctx);
    expect(result).toContain('140');
    expect(result).toContain('5.0%');
    expect(result).toContain('đã thanh lý');
    expect(result).toContain('/contracts/h9');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_ca: 0, so_thanh_ly: 0, so_het_han: 0, tong_hoan_coc: 0, mau_so_hop_dong: 0, ty_le_phan_tram: 0 }, ca: [] },
      error: null,
    });
    await expect(tool('bao_cao_thanh_ly').execute({ ky: '2099-01', so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng c. h.p ..ng n.o/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('bao_cao_thanh_ly').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('bao_cao_hop_dong_moi - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_report_new_leases_v1 with the signing window', async () => {
    rpc.mockResolvedValue({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_hop_dong: 0, tong_tien_thue_thang: 0, tong_coc: 0, tong_gia_tri: 0 }, hop_dong: [] },
      error: null,
    });
    await tool('bao_cao_hop_dong_moi').execute({ ky: '2026-08', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_report_new_leases_v1', {
      p_organization_id: ORG,
      p_tu: '2026-08-01',
      p_den: '2026-08-31',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('formats safe flat rows with a deep link', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 1,
        tong_hop: { so_hop_dong: 3, tong_tien_thue_thang: 15000000, tong_coc: 15000000, tong_gia_tri: 180000000 },
        hop_dong: [
          {
            hop_dong_id: 'h5',
            so_hop_dong: 'HD005',
            khach_hang: 'Pham Dung',
            phong: 'D404',
            toa_nha: 'Toa D',
            ngay_ky: '2026-08-02',
            ngay_bat_dau: '2026-08-05',
            ngay_ket_thuc: '2027-08-05',
            trang_thai: 'ACTIVE',
            tien_thue: 5000000,
            tien_coc: 5000000,
            chu_ky_thanh_toan: 'MONTHLY',
            so_thang: 12,
          },
        ],
      },
      error: null,
    });
    const result = await tool('bao_cao_hop_dong_moi').execute({ ky: '2026-08', so_luong: 20 }, ctx);
    expect(result).toContain('HD005');
    expect(result).toContain('Pham Dung');
    expect(result).toContain('đang thuê');
    expect(result).toContain('/contracts/h5');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_hop_dong: 0, tong_tien_thue_thang: 0, tong_coc: 0, tong_gia_tri: 0 }, hop_dong: [] },
      error: null,
    });
    await expect(tool('bao_cao_hop_dong_moi').execute({ ky: '2099-01', so_luong: 20 }, ctx)).resolves.toMatch(
      /ch.a k. h.p ..ng m.i n.o/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('bao_cao_hop_dong_moi').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('bao_cao_ty_le_chi_phi - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_report_expense_ratio_v1 and lets the server pick the default window', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 0,
        tu: '2026-03-01',
        den: '2026-09-02',
        tong_hop: { tong_thu: 0, tong_chi: 0, ty_le_phan_tram: null, phieu_han_che_bi_loai: 0 },
        theo_thang: [],
        hang_muc: [],
      },
      error: null,
    });
    await tool('bao_cao_ty_le_chi_phi').execute({ so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_report_expense_ratio_v1', {
      p_organization_id: ORG,
      p_tu: null,
      p_den: null,
      p_building_id: null,
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('says the total is INCOMPLETE when restricted vouchers were excluded', async () => {
    // Đây là điểm khác biệt giữa "tổng thiếu" và "tổng thiếu mà không ai biết".
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 1,
        tu: '2026-03-01',
        den: '2026-08-31',
        tong_hop: { tong_thu: 100000000, tong_chi: 30000000, ty_le_phan_tram: 30, phieu_han_che_bi_loai: 4 },
        theo_thang: [{ ky: '2026-08', thu: 20000000, chi: 6000000, ty_le_phan_tram: 30 }],
        hang_muc: [{ hang_muc: 'Dien nuoc', chi: 18000000 }],
      },
      error: null,
    });
    const result = await tool('bao_cao_ty_le_chi_phi').execute({ so_luong: 20 }, ctx);
    expect(result).toContain('30.0%');
    expect(result).toContain('Dien nuoc');
    expect(result).toContain('4');
    expect(result).toMatch(/ch.a ..y ../i);
    expect(result).toContain('/reports/real-estate/expense-ratio');
  });

  it('does not print a ratio when there was no income to divide by', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 1,
        tu: '2026-03-01',
        den: '2026-08-31',
        tong_hop: { tong_thu: 0, tong_chi: 7000000, ty_le_phan_tram: null, phieu_han_che_bi_loai: 0 },
        theo_thang: [{ ky: '2026-08', thu: 0, chi: 7000000, ty_le_phan_tram: null }],
        hang_muc: [],
      },
      error: null,
    });
    const result = await tool('bao_cao_ty_le_chi_phi').execute({ so_luong: 20 }, ctx);
    // Một tỉ lệ "0.0%" ở đây là một lời nói dối: mẫu số bằng 0, không phải tử số.
    expect(result).not.toContain('0.0%');
    expect(result).toMatch(/ch.a t.nh ..../i);
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        gioi_han: 20,
        so_luong: 0,
        tu: '2026-03-01',
        den: '2026-08-31',
        tong_hop: { tong_thu: 0, tong_chi: 0, ty_le_phan_tram: null, phieu_han_che_bi_loai: 0 },
        theo_thang: [],
        hang_muc: [],
      },
      error: null,
    });
    await expect(tool('bao_cao_ty_le_chi_phi').execute({ so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng c. phi.u thu chi/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('bao_cao_ty_le_chi_phi').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('bao_cao_thu_chi_theo_ngay - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('always sends a bounded window, even when the user named none', async () => {
    // RPC từ chối `p_tu`/`p_den` NULL. Client phải tự chốt kỳ mặc định, và kỳ đó
    // phải là ngày ĐỊA PHƯƠNG — `toISOString()` lùi một ngày trước 7h sáng giờ VN.
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 0,
        tu: null,
        den: null,
        tong_hop: { so_ngay_co_phat_sinh: 0, tong_thu: 0, tong_chi: 0, rong: 0, phieu_han_che_bi_loai: 0 },
        theo_ngay: [],
      },
      error: null,
    });
    await tool('bao_cao_thu_chi_theo_ngay').execute({ so_luong: 20 }, ctx);
    const args = rpc.mock.calls[0][1];
    expect(rpc.mock.calls[0][0]).toBe('copilot_report_daily_cashbook_v1');
    expect(args.p_tu).toMatch(/^\d{4}-\d{2}-01$/);
    expect(args.p_den).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(args.p_organization_id).toBe(ORG);
    expect(from).not.toHaveBeenCalled();
  });

  it('formats per-day rows and the server period total', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 2,
        tu: '2026-08-01',
        den: '2026-08-31',
        tong_hop: { so_ngay_co_phat_sinh: 12, tong_thu: 90000000, tong_chi: 30000000, rong: 60000000, phieu_han_che_bi_loai: 0 },
        theo_ngay: [
          { ngay: '2026-08-31', thu: 5000000, chi: 1000000, rong: 4000000 },
          { ngay: '2026-08-30', thu: 3000000, chi: 0, rong: 3000000 },
        ],
      },
      error: null,
    });
    const result = await tool('bao_cao_thu_chi_theo_ngay').execute({ ky: '2026-08', so_luong: 20 }, ctx);
    expect(result).toContain('2026-08-31');
    expect(result).toContain('12');
    expect(result).toContain('/reports/finance/daily-cashbook');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        gioi_han: 20,
        so_luong: 0,
        tu: '2026-08-01',
        den: '2026-08-31',
        tong_hop: { so_ngay_co_phat_sinh: 0, tong_thu: 0, tong_chi: 0, rong: 0, phieu_han_che_bi_loai: 0 },
        theo_ngay: [],
      },
      error: null,
    });
    await expect(
      tool('bao_cao_thu_chi_theo_ngay').execute({ ky: '2099-01', so_luong: 20 }, ctx),
    ).resolves.toMatch(/kh.ng c. ph.t sinh/i);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('bao_cao_thu_chi_theo_ngay').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('bao_cao_dong_tien - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('defaults to a twelve-month window and never sends a null bound', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 0,
        tu: null,
        den: null,
        tong_hop: { so_ky: 0, tong_thu: 0, tong_chi: 0, rong: 0, phieu_han_che_bi_loai: 0 },
        theo_thang: [],
      },
      error: null,
    });
    await tool('bao_cao_dong_tien').execute({ so_luong: 20 }, ctx);
    const args = rpc.mock.calls[0][1];
    expect(rpc.mock.calls[0][0]).toBe('copilot_report_cash_flow_v1');
    expect(args.p_tu).toMatch(/^\d{4}-\d{2}-01$/);
    expect(args.p_den).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Mười hai tháng, không phải mười hai ngày.
    expect(new Date(args.p_den).getTime() - new Date(args.p_tu).getTime()).toBeGreaterThan(
      330 * 24 * 3600 * 1000,
    );
  });

  it('formats per-month rows and warns when restricted vouchers were excluded', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 2,
        tu: '2025-09-01',
        den: '2026-08-31',
        tong_hop: { so_ky: 12, tong_thu: 900000000, tong_chi: 300000000, rong: 600000000, phieu_han_che_bi_loai: 2 },
        theo_thang: [
          { ky: '2026-07', thu: 70000000, chi: 20000000, rong: 50000000 },
          { ky: '2026-08', thu: 80000000, chi: 25000000, rong: 55000000 },
        ],
      },
      error: null,
    });
    const result = await tool('bao_cao_dong_tien').execute({ so_luong: 20 }, ctx);
    expect(result).toContain('2026-08');
    expect(result).toMatch(/ch.a ..y ../i);
    expect(result).toContain('/reports/finance/cash-flow');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        gioi_han: 20,
        so_luong: 0,
        tu: '2025-09-01',
        den: '2026-08-31',
        tong_hop: { so_ky: 0, tong_thu: 0, tong_chi: 0, rong: 0, phieu_han_che_bi_loai: 0 },
        theo_thang: [],
      },
      error: null,
    });
    await expect(tool('bao_cao_dong_tien').execute({ ky: '2099-01', so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng c. ph.t sinh/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('bao_cao_dong_tien').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('bao_cao_lich_thu_tien - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_report_payment_schedule_v1 with the look-ahead window', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_ngay: 30,
        so_luong: 0,
        tong_hop: { so_hoa_don: 0, tong_phai_thu: 0, tong_con_lai: 0, so_qua_han: 0, con_lai_qua_han: 0 },
        hoa_don: [],
      },
      error: null,
    });
    await tool('bao_cao_lich_thu_tien').execute({ so_ngay: 30, so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_report_payment_schedule_v1', {
      p_organization_id: ORG,
      p_so_ngay: 30,
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('marks an overdue invoice as overdue instead of "còn -3 ngày"', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_ngay: 30,
        so_luong: 2,
        tong_hop: { so_hoa_don: 11, tong_phai_thu: 120000000, tong_con_lai: 40000000, so_qua_han: 3, con_lai_qua_han: 9000000 },
        hoa_don: [
          {
            hoa_don_id: 'i1',
            so_hoa_don: 'INV-1',
            ky: '2026-07',
            han_thanh_toan: '2026-08-01',
            so_ngay_con_lai: -3,
            tong_tien: 5000000,
            da_tra: 2000000,
            con_lai: 3000000,
            trang_thai: 'PARTIAL_PAID',
            phong: 'A101',
            toa_nha: 'Toa A',
            khach_hang: 'Nguyen An',
          },
          {
            hoa_don_id: 'i2',
            so_hoa_don: 'INV-2',
            ky: '2026-08',
            han_thanh_toan: '2026-09-10',
            so_ngay_con_lai: 7,
            tong_tien: 4000000,
            da_tra: 0,
            con_lai: 4000000,
            trang_thai: 'APPROVED',
            phong: 'B202',
            toa_nha: 'Toa B',
            khach_hang: 'Tran Binh',
          },
        ],
      },
      error: null,
    });
    const result = await tool('bao_cao_lich_thu_tien').execute({ so_ngay: 30, so_luong: 20 }, ctx);
    expect(result).toMatch(/qu. h.n 3 ng.y/i);
    expect(result).toMatch(/c.n 7 ng.y/i);
    expect(result).toContain('11');
    expect(result).toContain('/reports/finance/payment-schedule');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        gioi_han: 20,
        so_ngay: 30,
        so_luong: 0,
        tong_hop: { so_hoa_don: 0, tong_phai_thu: 0, tong_con_lai: 0, so_qua_han: 0, con_lai_qua_han: 0 },
        hoa_don: [],
      },
      error: null,
    });
    await expect(
      tool('bao_cao_lich_thu_tien').execute({ so_ngay: 30, so_luong: 20 }, ctx),
    ).resolves.toMatch(/kh.ng c. kho.n n.o/i);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(
      tool('bao_cao_lich_thu_tien').execute({ so_ngay: 30, so_luong: 20 }, ctx),
    ).rejects.toThrow('rpc failed');
  });
});

describe('bao_cao_thu_thua - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_report_overpayment_v1 with the selected org and the row cap', async () => {
    rpc.mockResolvedValue({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_hoa_don: 0, tong_thu_thua: 0 }, hoa_don: [] },
      error: null,
    });
    await tool('bao_cao_thu_thua').execute({ so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_report_overpayment_v1', {
      p_organization_id: ORG,
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('prints the server total, not the sum of the shown rows', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 1,
        so_luong: 1,
        tong_hop: { so_hoa_don: 6, tong_thu_thua: 7500000 },
        hoa_don: [
          {
            hoa_don_id: 'i7',
            so_hoa_don: 'INV-7',
            ky: '2026-08',
            tong_tien: 5000000,
            da_tra: 6000000,
            thu_thua: 1000000,
            phong: 'A101',
            toa_nha: 'Toa A',
            khach_hang: 'Nguyen An',
          },
        ],
      },
      error: null,
    });
    const result = await tool('bao_cao_thu_thua').execute({ so_luong: 1 }, ctx);
    expect(result).toContain('6');
    expect(result).toContain('INV-7');
    expect(result).toContain('/reports/finance/overpayment');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_hoa_don: 0, tong_thu_thua: 0 }, hoa_don: [] },
      error: null,
    });
    await expect(tool('bao_cao_thu_thua').execute({ so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng c. ho. ..n n.o/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('bao_cao_thu_thua').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('bao_cao_dat_coc - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('sends the DB enum, never the user-facing Vietnamese key', async () => {
    rpc.mockResolvedValue({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_phieu: 0, tong_tien: 0, dang_giu: 0, da_vao_hop_dong: 0 }, coc: [] },
      error: null,
    });
    await tool('bao_cao_dat_coc').execute({ trang_thai: 'da_xac_nhan', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_report_deposits_v1', {
      p_organization_id: ORG,
      p_trang_thai: 'CONFIRMED',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('sends null instead of an empty filter', async () => {
    rpc.mockResolvedValue({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_phieu: 0, tong_tien: 0, dang_giu: 0, da_vao_hop_dong: 0 }, coc: [] },
      error: null,
    });
    await tool('bao_cao_dat_coc').execute({ so_luong: 20 }, ctx);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_trang_thai: null });
  });

  it('labels the deposit state in Vietnamese and reports the held total', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 1,
        tong_hop: { so_phieu: 4, tong_tien: 20000000, dang_giu: 12000000, da_vao_hop_dong: 8000000 },
        coc: [
          {
            coc_id: 'd1',
            ma: 'DC-001',
            khach_hang: 'Hoang Em',
            phong: 'A101',
            toa_nha: 'Toa A',
            so_tien: 3000000,
            ngay_coc: '2026-08-20',
            giu_den: '2026-09-05',
            trang_thai: 'CONFIRMED',
            so_ngay_giu: 13,
          },
        ],
      },
      error: null,
    });
    const result = await tool('bao_cao_dat_coc').execute({ so_luong: 20 }, ctx);
    expect(result).toContain('DC-001');
    expect(result).toContain('đã xác nhận');
    expect(result).toContain('13');
    expect(result).toContain('/reports/finance/deposits');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: { gioi_han: 20, so_luong: 0, tong_hop: { so_phieu: 0, tong_tien: 0, dang_giu: 0, da_vao_hop_dong: 0 }, coc: [] },
      error: null,
    });
    await expect(tool('bao_cao_dat_coc').execute({ so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng c. phi.u ..t c.c/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('bao_cao_dat_coc').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('bao cao — moi tool gac bang CHINH khoa quyen cua trang', () => {
  it('khong tool nao muon quyen rong hon hang rao cua man hinh', () => {
    // Cấp một báo cáo qua Copilot bằng một quyền RỘNG hơn và dễ được cấp hơn là
    // mở cửa sau vòng qua chính hàng rào của trang đó — lỗi đã mắc một lần ở
    // `ty_le_lap_day` (đặt `rooms.view` thay vì `reports_real_estate.occupancy`).
    const MONG_DOI: Record<string, { module: string; action: string }> = {
      bao_cao_phong_trong: { module: 'reports_real_estate', action: 'vacant_rooms' },
      bao_cao_gia_han: { module: 'reports_real_estate', action: 'renewals_transfers' },
      bao_cao_thanh_ly: { module: 'reports_real_estate', action: 'terminations' },
      bao_cao_hop_dong_moi: { module: 'reports_real_estate', action: 'new_leases' },
      bao_cao_ty_le_chi_phi: { module: 'reports_real_estate', action: 'expense_ratio' },
      bao_cao_thu_chi_theo_ngay: { module: 'reports_finance', action: 'daily_cashbook' },
      bao_cao_dong_tien: { module: 'reports_finance', action: 'cash_flow' },
      bao_cao_lich_thu_tien: { module: 'reports_finance', action: 'payment_schedule' },
      bao_cao_thu_thua: { module: 'reports_finance', action: 'overpayment' },
      bao_cao_dat_coc: { module: 'reports_finance', action: 'deposits_report' },
    };
    for (const [ten, quyen] of Object.entries(MONG_DOI)) {
      expect(tool(ten).requiredPermission, ten).toEqual(quyen);
      // Cờ rollout là cờ của trang CANONICAL: chỉ trang canonical được seed cờ
      // (xem 20260902185838), nên trang con dùng cờ của cụm báo cáo của nó.
      expect(tool(ten).rolloutKey, ten).toBe(
        quyen.module === 'reports_finance' ? 'reports.finance' : 'reports.real-estate',
      );
    }
  });
});

// ── G1-C4: bốn miền gác quyền riêng ─────────────────────────────────────────

describe('bang_luong_ky - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_salary_summary_v1 with the selected org and period', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await tool('bang_luong_ky').execute({ ky: '2026-08', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_salary_summary_v1', {
      p_organization_id: ORG,
      p_ky: '2026-08',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('sends a null period when none is asked for, so the server picks it', async () => {
    // Client tự đoán "tháng này" là hai nơi cùng quyết định một việc — và một
    // trong hai chạy ở UTC. Kỳ mặc định do server chọn bằng org_today_v1.
    rpc.mockResolvedValue({ data: null, error: null });
    await tool('bang_luong_ky').execute({ so_luong: 20 }, ctx);
    expect(rpc.mock.calls[0][1].p_ky).toBeNull();
  });

  it('prints the server totals and every pay component', async () => {
    rpc.mockResolvedValue({
      data: {
        ky: '2026-08',
        pham_vi: 'toan_cong_ty',
        gioi_han: 1,
        so_luong: 1,
        tong_hop: {
          so_nhan_vien: 4,
          tong_gross: 40000000,
          tong_thuc_nhan: 33000000,
          tong_thuong: 6000000,
          tong_khau_tru: 7000000,
          tong_da_tra: 20000000,
          so_ky_da_chot: 2,
        },
        bang_luong: [
          {
            nhan_vien_id: 'u1',
            nhan_vien: 'Tran Quan Ly',
            trang_thai: 'LOCKED',
            luong_co_ban: 8000000,
            thuong_viec: 1500000,
            thuong_hop_dong: 500000,
            hoa_hong: 1000000,
            loi_nhuan_dau_tu: 0,
            dieu_chinh: -200000,
            ung_luong: 2000000,
            tien_phong: 1000000,
            tong_gross: 11000000,
            thuc_nhan: 7800000,
            da_tra: 5000000,
          },
        ],
      },
      error: null,
    });
    const result = await tool('bang_luong_ky').execute({ so_luong: 1 }, ctx);
    expect(result).toContain('Tran Quan Ly');
    expect(result).toContain('đã chốt');
    // Tổng LÀ của server, tính trên toàn tập — không phải cộng lại từ 1 dòng
    // vừa bị cắt. `gioi_han: 1` nhưng `so_nhan_vien: 4` chứng minh điều đó.
    expect(result).toContain('4 người');
    expect(result).not.toContain('LOCKED');
  });

  it('says out loud when the answer is only the caller own row', async () => {
    // Không có câu này thì một dòng lương của riêng người hỏi trông y hệt "cả
    // công ty chỉ có một người".
    rpc.mockResolvedValue({
      data: {
        ky: '2026-08',
        pham_vi: 'chi_minh_toi',
        gioi_han: 20,
        so_luong: 1,
        tong_hop: {
          so_nhan_vien: 1,
          tong_gross: 11000000,
          tong_thuc_nhan: 7800000,
          tong_thuong: 3000000,
          tong_khau_tru: 3000000,
          tong_da_tra: 0,
          so_ky_da_chot: 0,
        },
        bang_luong: [
          {
            nhan_vien_id: 'u1',
            nhan_vien: 'Chinh Toi',
            trang_thai: 'DRAFT',
            luong_co_ban: 8000000,
            thuong_viec: 0,
            thuong_hop_dong: 0,
            hoa_hong: 3000000,
            loi_nhuan_dau_tu: 0,
            dieu_chinh: 0,
            ung_luong: 3000000,
            tien_phong: 0,
            tong_gross: 11000000,
            thuc_nhan: 7800000,
            da_tra: 0,
          },
        ],
      },
      error: null,
    });
    const result = await tool('bang_luong_ky').execute({ so_luong: 20 }, ctx);
    expect(result).toMatch(/ch.nh m.nh/i);
    // Và chiều ngược lại: khi phạm vi là toàn công ty thì câu cảnh báo KHÔNG
    // được xuất hiện, nếu không nó chỉ là một câu chú thích luôn-bật vô nghĩa.
    rpc.mockResolvedValueOnce({
      data: {
        ky: '2026-08',
        pham_vi: 'toan_cong_ty',
        gioi_han: 20,
        so_luong: 0,
        tong_hop: null,
        bang_luong: [],
      },
      error: null,
    });
    const toanCongTy = await tool('bang_luong_ky').execute({ so_luong: 20 }, ctx);
    expect(toanCongTy).not.toMatch(/ch.nh m.nh/i);
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: { ky: '2026-08', pham_vi: 'toan_cong_ty', gioi_han: 20, so_luong: 0, tong_hop: null, bang_luong: [] },
      error: null,
    });
    await expect(tool('bang_luong_ky').execute({ so_luong: 20 }, ctx)).resolves.toMatch(
      /ch.a c. b.ng l..ng/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('bang_luong_ky').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('loi_nhuan_co_dong - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_shareholder_profit_v1 with the selected org', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await tool('loi_nhuan_co_dong').execute({ ky: '2026-07', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_shareholder_profit_v1', {
      p_organization_id: ORG,
      p_ky: '2026-07',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('prints per-building and per-shareholder rows, and flags a stale month', async () => {
    rpc.mockResolvedValue({
      data: {
        ky: '2026-07',
        pham_vi: 'toan_cong_ty',
        gioi_han: 1,
        so_luong: 1,
        tong_hop: {
          so_toa: 3,
          loi_nhuan_tinh: 90000000,
          loi_nhuan_sau_dieu_chinh: 88000000,
          luong_quan_ly: 12000000,
          da_chia_co_dong: 60000000,
          chua_chia: 16000000,
          so_toa_da_chot: 2,
          so_toa_can_tinh_lai: 1,
        },
        theo_toa: [
          {
            toa_nha_id: 'b1',
            toa_nha: 'Toa A',
            trang_thai: 'LOCKED',
            loi_nhuan_tinh: 40000000,
            loi_nhuan_sau_dieu_chinh: 39000000,
            luong_quan_ly: 5000000,
            ty_le_co_dong: 70,
            da_chia_co_dong: 27300000,
            chua_chia: 6700000,
            xu_ly_phan_chua_chia: 'RETAIN',
            can_tinh_lai: true,
          },
        ],
        theo_co_dong: [
          { co_dong_id: 's1', co_dong: 'Nguyen Co Dong', so_tien: 27300000, tong_ty_le: 70, so_toa: 1 },
        ],
      },
      error: null,
    });
    const result = await tool('loi_nhuan_co_dong').execute({ so_luong: 1 }, ctx);
    expect(result).toContain('Toa A');
    expect(result).toContain('Nguyen Co Dong');
    expect(result).toContain('giữ lại cho công ty');
    // `is_stale` = nguồn đã đổi sau lần tính gần nhất. Im lặng ở đây là trình bày
    // một con số cũ như số hiện hành.
    expect(result).toMatch(/t.nh l.i/i);
    // Tổng của server trên toàn tập (3 toà) dù danh sách bị cắt còn 1.
    expect(result).toContain('3 toà');
    expect(result).not.toContain('LOCKED');
    expect(result).not.toContain('RETAIN');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ky: '2026-07',
        pham_vi: 'toan_cong_ty',
        gioi_han: 20,
        so_luong: 0,
        tong_hop: null,
        theo_toa: [],
        theo_co_dong: [],
      },
      error: null,
    });
    await expect(tool('loi_nhuan_co_dong').execute({ so_luong: 20 }, ctx)).resolves.toMatch(
      /ch.a c. s. li.u l.i nhu.n/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('loi_nhuan_co_dong').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('hoi_thoai_zalo - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_zalo_conversations_v1 and never touches a zalo table', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await tool('hoi_thoai_zalo').execute({ tu_khoa: 'An', so_luong: 20 }, ctx);
    expect(rpc).toHaveBeenCalledWith('copilot_zalo_conversations_v1', {
      p_organization_id: ORG,
      p_query: 'An',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('normalizes a blank search to null instead of an empty LIKE', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await tool('hoi_thoai_zalo').execute({ tu_khoa: '   ', so_luong: 20 }, ctx);
    expect(rpc.mock.calls[0][1].p_query).toBeNull();
  });

  it('ALWAYS masks the phone number and passes the message through maskPii', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 1,
        so_luong: 1,
        tong_hop: { so_hoi_thoai: 12, so_chua_doc: 3, tong_tin_chua_doc: 7, so_ghim: 1 },
        hoi_thoai: [
          {
            hoi_thoai_id: 'z1',
            nguoi_nhan: 'Le Thi Khach',
            dien_thoai: '0901234567',
            loai: 'user',
            nhom: 'tenant',
            chua_doc: 2,
            danh_dau_chua_doc: false,
            ghim: false,
            phong: 'A101',
            toa_nha: 'Toa A',
            nhan: null,
            tin_cuoi_luc: '2026-09-02T10:00:00Z',
            tin_cuoi_chieu: 'in',
            tin_cuoi: 'Em chuyen khoan roi nhe, so 0912345678 do a',
          },
        ],
      },
      error: null,
    });
    const result = await tool('hoi_thoai_zalo').execute({ so_luong: 1 }, ctx);
    expect(result).toContain('Le Thi Khach');
    expect(result).toContain('090***4567');
    // Số gốc không được lọt ra, kể cả khi nó nằm TRONG nội dung tin nhắn — nội
    // dung là văn bản do người ngoài viết, và nó đi thẳng sang nhà cung cấp mô hình.
    expect(result).not.toContain('0901234567');
    expect(result).not.toContain('0912345678');
    expect(result).toContain('cá nhân/khách trọ');
    expect(result).toContain('12 hội thoại');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: { gioi_han: 20, so_luong: 0, tong_hop: null, hoi_thoai: [] },
      error: null,
    });
    await expect(tool('hoi_thoai_zalo').execute({ so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng c. h.i tho.i/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('hoi_thoai_zalo').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});

describe('trang_thai_mang - server RPC boundary', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it('calls copilot_network_status_v1 with the selected org and optional building', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await tool('trang_thai_mang').execute(
      { toa_nha_id: 'dddd1000-0000-4000-8000-000000000011', so_luong: 20 },
      ctx,
    );
    expect(rpc).toHaveBeenCalledWith('copilot_network_status_v1', {
      p_organization_id: ORG,
      p_building_id: 'dddd1000-0000-4000-8000-000000000011',
      p_limit: 20,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('prints health, incidents and clients, and names a building with no router', async () => {
    rpc.mockResolvedValue({
      data: {
        gioi_han: 2,
        so_luong: 2,
        tong_hop: {
          so_toa: 5,
          so_toa_co_router: 4,
          so_toa_online: 3,
          so_toa_offline: 1,
          tong_su_co_mo: 2,
          tong_thiet_bi_ket_noi: 87,
        },
        toa_nha: [
          {
            toa_nha_id: 'b1',
            toa_nha: 'Toa A',
            router: 'RB-A',
            model: 'hAP ax2',
            vong_doi: 'ACTIVE',
            ket_noi_duoc: false,
            suc_khoe: 'OFFLINE',
            thay_lan_cuoi: '2026-09-02T08:00:00Z',
            phien_ban: '7.14',
            cpu_phan_tram: 12,
            pppoe: 'up',
            so_ket_noi: 40,
            su_co_dang_mo: 2,
            thiet_bi_dang_ket_noi: 51,
            su_co_gan_nhat: {
              tieu_de: 'Router mat ket noi',
              muc_do: 'CRITICAL',
              trang_thai: 'OPEN',
              mo_luc: '2026-09-02T07:30:00Z',
            },
          },
          {
            toa_nha_id: 'b2',
            toa_nha: 'Toa B',
            router: null,
            model: null,
            vong_doi: null,
            ket_noi_duoc: null,
            suc_khoe: null,
            thay_lan_cuoi: null,
            phien_ban: null,
            cpu_phan_tram: null,
            pppoe: null,
            so_ket_noi: null,
            su_co_dang_mo: 0,
            thiet_bi_dang_ket_noi: 0,
            su_co_gan_nhat: null,
          },
        ],
      },
      error: null,
    });
    const result = await tool('trang_thai_mang').execute({ so_luong: 2 }, ctx);
    expect(result).toContain('MẤT KẾT NỐI');
    expect(result).toContain('mất kết nối');
    expect(result).toContain('nguy cấp');
    expect(result).toContain('Router mat ket noi');
    // Toà chưa gắn router phải được NÓI RA. Bỏ nó khỏi danh sách sẽ làm "mạng
    // toà nào đang hỏng" trả về im lặng cho đúng toà chưa được lắp gì.
    expect(result).toContain('Toa B — chưa gắn router');
    expect(result).toContain('5 toà');
    expect(result).not.toContain('OFFLINE');
    expect(result).not.toContain('CRITICAL');
  });

  it('preserves empty and error behavior', async () => {
    rpc.mockResolvedValueOnce({
      data: { gioi_han: 20, so_luong: 0, tong_hop: null, toa_nha: [] },
      error: null,
    });
    await expect(tool('trang_thai_mang').execute({ so_luong: 20 }, ctx)).resolves.toMatch(
      /kh.ng c. to. n.o/i,
    );
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(tool('trang_thai_mang').execute({ so_luong: 20 }, ctx)).rejects.toThrow('rpc failed');
  });
});


describe('nhan zalo phu DUNG tap gia tri ma CHECK constraint cho phep', () => {
  // Nguồn sự thật là hai CHECK constraint của bảng, chép vào đây kèm chỗ đọc:
  //   zalo_conversations_thread_type_check  'user' | 'group'
  //   zalo_conversations_kind_check         'tenant' | 'lead' | 'broker' | 'unknown'
  // (supabase/baseline/schema.sql:116513-116514)
  //
  // Bản đầu khai `User`/`Group` viết hoa và `partner`/`other`: BỐN khoá không
  // dòng nào khớp được. Không test nào đỏ vì mọi nhãn đều có `?? r.loai` phía
  // sau — hỏng kiểu này chỉ lộ ra dưới dạng "sao Copilot đọc `tenant` mà không
  // dịch", tức là không bao giờ lộ ra ở CI.
  const THREAD_TYPE = ['user', 'group'] as const;
  const KIND = ['tenant', 'lead', 'broker', 'unknown'] as const;

  async function inRa(loai: string, nhom: string): Promise<string> {
    rpc.mockReset();
    from.mockReset();
    rpc.mockResolvedValue({
      data: {
        gioi_han: 20,
        so_luong: 1,
        tong_hop: { so_hoi_thoai: 1, so_chua_doc: 0, tong_tin_chua_doc: 0, so_ghim: 0 },
        hoi_thoai: [
          {
            hoi_thoai_id: 'z1',
            nguoi_nhan: 'Khach',
            dien_thoai: null,
            loai,
            nhom,
            chua_doc: 0,
            danh_dau_chua_doc: false,
            ghim: false,
            phong: null,
            toa_nha: null,
            nhan: null,
            tin_cuoi_luc: null,
            tin_cuoi_chieu: 'in',
            tin_cuoi: null,
          },
        ],
      },
      error: null,
    });
    return tool('hoi_thoai_zalo').execute({ so_luong: 20 }, ctx);
  }

  for (const loai of THREAD_TYPE) {
    it(`thread_type "${loai}" co nhan tieng Viet, khong in ma tho`, async () => {
      const ket = await inRa(loai, 'tenant');
      expect(ket, loai).not.toContain(loai);
    });
  }

  for (const nhom of KIND) {
    it(`kind "${nhom}" co nhan tieng Viet, khong in ma tho`, async () => {
      const ket = await inRa('user', nhom);
      expect(ket, nhom).not.toContain(nhom);
    });
  }

  it('khong khai nhan cho gia tri KHONG ton tai trong CHECK constraint', async () => {
    const nguon = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('src/copilot/tools/nghiepVuTools.ts', 'utf8'),
    );
    const khoi = (ten: string) => {
      const i = nguon.indexOf(`const ${ten}: Record<string, string> = {`);
      return nguon.slice(i, nguon.indexOf('};', i));
    };
    for (const cheat of ['User:', 'Group:', 'partner:', 'other:']) {
      expect(khoi('NHAN_LOAI_HOI_THOAI') + khoi('NHAN_NHOM_HOI_THOAI'), cheat).not.toContain(cheat);
    }
  });
});

describe('loi_nhuan_co_dong — pham vi cua chinh minh duoc NOI RA', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  const goi = (phamVi: string) => ({
    data: {
      ky: '2026-07',
      pham_vi: phamVi,
      gioi_han: 20,
      so_luong: 1,
      tong_hop: {
        so_toa: 1,
        loi_nhuan_tinh: 40000000,
        loi_nhuan_sau_dieu_chinh: 39000000,
        luong_quan_ly: 5000000,
        da_chia_co_dong: 27300000,
        chua_chia: 6700000,
        so_toa_da_chot: 1,
        so_toa_can_tinh_lai: 0,
      },
      theo_toa: [
        {
          toa_nha_id: 'b1',
          toa_nha: 'Toa A',
          trang_thai: 'LOCKED',
          loi_nhuan_tinh: 40000000,
          loi_nhuan_sau_dieu_chinh: 39000000,
          luong_quan_ly: 5000000,
          ty_le_co_dong: 70,
          da_chia_co_dong: 27300000,
          chua_chia: 6700000,
          xu_ly_phan_chua_chia: 'RETAIN',
          can_tinh_lai: false,
        },
      ],
      theo_co_dong: [
        { co_dong_id: 's1', co_dong: 'Nguyen Co Dong', so_tien: 27300000, tong_ty_le: 70, so_toa: 1 },
      ],
    },
    error: null,
  });

  it('cổ đông thường: câu trả lời nói rõ đây chỉ là phần của họ', async () => {
    rpc.mockResolvedValue(goi('chi_minh_toi'));
    const ket = await tool('loi_nhuan_co_dong').execute({ so_luong: 20 }, ctx);
    expect(ket).toMatch(/ch.nh m.nh/i);
  });

  it('người chốt sổ: KHÔNG có câu cảnh báo đó', async () => {
    // Một câu chú thích luôn-bật là một câu chú thích không ai đọc nữa.
    rpc.mockResolvedValue(goi('toan_cong_ty'));
    const ket = await tool('loi_nhuan_co_dong').execute({ so_luong: 20 }, ctx);
    expect(ket).not.toMatch(/ch.nh m.nh/i);
  });

  it('rỗng + phạm vi riêng: nói "bạn chưa có phần nào", không nói "công ty chưa có"', async () => {
    rpc.mockResolvedValue({
      data: {
        ky: '2026-07',
        pham_vi: 'chi_minh_toi',
        gioi_han: 20,
        so_luong: 0,
        tong_hop: null,
        theo_toa: [],
        theo_co_dong: [],
      },
      error: null,
    });
    const ket = await tool('loi_nhuan_co_dong').execute({ so_luong: 20 }, ctx);
    expect(ket).toMatch(/b.n ch.a c. ph.n/i);
  });
});

describe('bon mien nhay cam — khoa quyen va cong tac rollout', () => {
  it('moi tool gac bang DUNG khoa quyen cua man hinh no doc', () => {
    // Cấp lương/lợi nhuận/chat riêng tư qua Copilot bằng một quyền RỘNG hơn là mở
    // cửa sau vòng qua chính hàng rào của màn hình.
    const MONG_DOI: Record<string, { module: string; action: string }> = {
      bang_luong_ky: { module: 'salary', action: 'view' },
      loi_nhuan_co_dong: { module: 'shareholder_profit', action: 'view' },
      hoi_thoai_zalo: { module: 'chat_zalo', action: 'view' },
      trang_thai_mang: { module: 'network_center', action: 'view' },
    };
    for (const [ten, quyen] of Object.entries(MONG_DOI)) {
      expect(tool(ten).requiredPermission, ten).toEqual(quyen);
    }
  });

  it('rolloutKey nao cung phai la mot contract CO THAT', () => {
    // Bịa một khoá ở đây tạo một hàng trong trang admin mà
    // `set_copilot_feature_flag_v2` từ chối (RPC chỉ UPDATE dòng ĐÃ SEED), tức
    // người vận hành bấm nút và nhận một lỗi không tự chữa được.
    const khoaCoThat = new Set(COPILOT_ROLLOUT_CONTRACTS.map((c) => c.contractId));
    for (const ten of ['bang_luong_ky', 'loi_nhuan_co_dong', 'hoi_thoai_zalo', 'trang_thai_mang']) {
      const khoa = tool(ten).rolloutKey;
      expect(khoa, `${ten} khong khai rolloutKey`).toBeTruthy();
      expect(khoaCoThat.has(String(khoa)), `${ten}: rolloutKey "${khoa}" khong co trong contract`).toBe(true);
    }
    // Ba trong bốn trang nằm trong COPILOT_PAGE_EXEMPTIONS nên KHÔNG có contract
    // trang — và ba tool đó có khoá RIÊNG chứ không mượn khoá của trang khác.
    // Mượn (bản đầu dùng `reports.finance` cho bảng lương) nghĩa là bật rollout
    // báo cáo tài chính cũng bật luôn tool lương: hai quyết định vận hành không
    // liên quan trên một công tắc.
    expect(tool('hoi_thoai_zalo').rolloutKey).toBe('chat-zalo.list');
    expect(tool('bang_luong_ky').rolloutKey).toBe('copilot.sensitive.salary');
    expect(tool('loi_nhuan_co_dong').rolloutKey).toBe('copilot.sensitive.shareholder-profit');
    expect(tool('trang_thai_mang').rolloutKey).toBe('copilot.sensitive.network');
    // Và không tool nào của lát này được dùng chung khoá với tool khác.
    const khoa = ['bang_luong_ky', 'loi_nhuan_co_dong', 'hoi_thoai_zalo', 'trang_thai_mang'].map(
      (ten) => tool(ten).rolloutKey,
    );
    expect(new Set(khoa).size).toBe(khoa.length);
  });

  it('khong tool nao cham vao mot RPC ghi cua Network Center hay Zalo', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('src/copilot/tools/nghiepVuTools.ts', 'utf8'),
    );
    for (const ten of [
      'network_center_execute_action_v1',
      'network_center_ack_incident_v1',
      'network_center_create_maintenance_v1',
      'network_center_cancel_maintenance_v1',
      'network_center_request_snapshot_v1',
      'network_center_update_settings_v1',
      'zalo_send',
      'zalo_broadcast',
      'zalo_recall',
    ]) {
      expect(source, ten).not.toContain(ten);
    }
  });
});

describe('registry source contract', () => {
  it('does not query customers or contracts from the browser tools', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('src/copilot/tools/registry.ts', 'utf8'),
    );
    expect(source).toContain("copilot_customer_search_v1");
    expect(source).toContain("copilot_expiring_contracts_v1");
    expect(source).not.toMatch(/\.from\('customers'\)/);
    expect(source).not.toMatch(/\.from\('contracts'\)/);
  });

  it('reads every join-scoped table through RPC only, never from the browser', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('src/copilot/tools/nghiepVuTools.ts', 'utf8'),
    );
    for (const rpcName of [
      'copilot_contract_search_v1',
      'copilot_contract_detail_v1',
      'copilot_income_expense_search_v1',
      'copilot_pending_requests_v1',
      'copilot_lead_search_v1',
      'copilot_meter_readings_v1',
      'copilot_vehicle_search_v1',
      'copilot_tasks_v1',
      'copilot_material_stock_v1',
      'copilot_report_vacant_rooms_v1',
      'copilot_report_renewals_v1',
      'copilot_report_terminations_v1',
      'copilot_report_new_leases_v1',
      'copilot_report_expense_ratio_v1',
      'copilot_report_daily_cashbook_v1',
      'copilot_report_cash_flow_v1',
      'copilot_report_payment_schedule_v1',
      'copilot_report_overpayment_v1',
      'copilot_report_deposits_v1',
      'copilot_salary_summary_v1',
      'copilot_shareholder_profit_v1',
      'copilot_zalo_conversations_v1',
      'copilot_network_status_v1',
    ]) {
      expect(source, rpcName).toContain(`'${rpcName}'`);
    }
    for (const table of [
      'contracts',
      'income_expenses',
      'approval_requests',
      'invoices',
      'leads',
      'meter_readings',
      'vehicles',
      'jobs',
      'materials',
      'rooms',
      'deposits',
      'contract_extensions',
      'contract_terminations',
      'income_expense_items',
      'income_expense_types',
      'salary_monthly',
      'profit_monthly',
      'profit_allocations',
      'shareholders',
      'zalo_conversations',
      'zalo_messages',
      'network_devices',
      'network_device_current',
      'network_incidents',
      'network_client_current',
    ]) {
      expect(source, table).not.toMatch(new RegExp(`\\.from\\('${table}'\\)`));
    }
  });
});
