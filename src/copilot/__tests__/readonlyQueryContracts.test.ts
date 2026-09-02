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

  it('reads contracts, vouchers and the pending inbox through RPC only', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('src/copilot/tools/nghiepVuTools.ts', 'utf8'),
    );
    for (const rpcName of [
      'copilot_contract_search_v1',
      'copilot_contract_detail_v1',
      'copilot_income_expense_search_v1',
      'copilot_pending_requests_v1',
    ]) {
      expect(source, rpcName).toContain(`'${rpcName}'`);
    }
    for (const table of ['contracts', 'income_expenses', 'approval_requests', 'invoices']) {
      expect(source, table).not.toMatch(new RegExp(`\\.from\\('${table}'\\)`));
    }
  });
});
