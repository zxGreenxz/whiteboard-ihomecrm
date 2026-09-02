// Customer and expiring-contract tools use the typed server RPC boundary.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc, from } }));

const { buildRegistryDefinitions } = await import('../tools/registry');
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
    ]) {
      expect(source, table).not.toMatch(new RegExp(`\\.from\\('${table}'\\)`));
    }
  });
});
