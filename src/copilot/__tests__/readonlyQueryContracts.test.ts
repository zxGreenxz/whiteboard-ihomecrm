// Hợp đồng truy vấn của các tool ĐỌC — chặn quan hệ không tồn tại trong schema.
//
// Vì sao cần test riêng thay vì tin vào test format: hai tool `tim_khach_hang`
// và `hop_dong_sap_het_han` từng nhúng thẳng `customers -> rooms`,
// `customers -> buildings`, `contracts -> buildings`, `contracts -> customers`.
// Bốn quan hệ đó KHÔNG có trong schema (bảng `customers` không có `room_id`/
// `building_id`; `contracts` không có `customer_id`/`building_id`), nên PostgREST
// trả lỗi schema-cache trên deployment thật. Đánh giá live 13/08/2026 ghi nhận
// 5 ca hỏng vì đúng hai tool này (C02, C04, C14, C16 FAIL và C27 PARTIAL).
//
// Test format bằng mock trả sẵn `data` KHÔNG bắt được lớp lỗi này: mock luôn
// "thành công" bất kể chuỗi select có hợp lệ hay không. Nên ở đây ta kiểm CHÍNH
// CHUỖI SELECT — thứ duy nhất quyết định PostgREST dựng được câu truy vấn hay
// không — và đối chiếu với tên khoá ngoại có thật trong generated types.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const from = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from, rpc: vi.fn() } }));

const { buildRegistry } = await import('../tools/registry');
import type { PermissionsMap } from '@/lib/permissions';

const SUPER = { __superadmin: true } as unknown as PermissionsMap;
const ctx = { perms: SUPER, organizationId: 'aaaa0000-0000-4000-8000-000000000001' };

/**
 * Builder giả lập chuỗi PostgREST. Ghi lại tên bảng + chuỗi select rồi trả
 * `payload` khi được await — đủ để chạy ĐƯỜNG THẬT của tool.
 */
function mockChain(payload: { data: unknown[] | null; error: { message: string } | null }) {
  const calls: { table: string; select: string }[] = [];
  from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'is', 'or', 'eq', 'gte', 'lte', 'order', 'limit', 'in', 'not']) {
      chain[m] = (arg: unknown) => {
        if (m === 'select') calls.push({ table, select: String(arg) });
        return chain;
      };
    }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(payload).then(resolve);
    return chain;
  });
  return calls;
}

const tool = (name: string) => {
  const t = buildRegistry().find((x) => x.name === name);
  if (!t) throw new Error(`không có tool ${name}`);
  return t;
};

/** Quan hệ trực tiếp KHÔNG tồn tại trong schema — nhúng là lỗi runtime. */
const QUAN_HE_KHONG_TON_TAI = [
  { chuoi: 'rooms(', trong: 'customers', vi: 'customers -> rooms' },
  { chuoi: 'buildings(', trong: 'customers', vi: 'customers -> buildings' },
  { chuoi: 'buildings(', trong: 'contracts', vi: 'contracts -> buildings' },
  { chuoi: 'customers(', trong: 'contracts', vi: 'contracts -> customers' },
];

/**
 * Mọi phép nhúng phải nêu ĐÍCH DANH tên khoá ngoại (`target!fk_name(...)`).
 * Không nêu tên FK thì PostgREST tự đoán, và nó đoán sai/mơ hồ ngay khi có
 * nhiều đường nối giữa hai bảng.
 */
function nhungThieuTenFk(select: string): string[] {
  const thieu: string[] = [];
  // Bắt các đoạn `ten_bang(` — mọi lần nhúng đều có dạng này.
  for (const m of select.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const truoc = select.slice(0, m.index);
    // Nhúng có tên FK sẽ có dạng `bang!fk_name(` — ký tự ngay trước tên là '!'
    if (!/!$/.test(truoc.split(/[\s,(]/).pop() ?? '') && !truoc.endsWith('!')) {
      // kiểm lại chính xác: ký tự đứng ngay trước tên bảng trong `m[1]`
      const startIdx = m.index ?? 0;
      const kyTuTruoc = startIdx > 0 ? select[startIdx - 1] : '';
      if (kyTuTruoc !== '!') thieu.push(m[1]);
    }
  }
  return thieu;
}

describe('tim_khach_hang — hợp đồng truy vấn', () => {
  beforeEach(() => from.mockReset());

  it('KHÔNG nhúng thẳng rooms/buildings từ customers (nguồn lỗi C02/C14)', async () => {
    const calls = mockChain({ data: [], error: null });
    await tool('tim_khach_hang').execute({ tu_khoa: 'Nguyễn An' }, ctx);
    const kh = calls.find((c) => c.table === 'customers');
    expect(kh, 'tool phải truy vấn bảng customers').toBeTruthy();
    for (const qh of QUAN_HE_KHONG_TON_TAI.filter((q) => q.trong === 'customers')) {
      expect(kh!.select, `còn nhúng quan hệ không tồn tại: ${qh.vi}`).not.toMatch(
        new RegExp(`(^|[\\s,(:])${qh.chuoi.replace('(', '\\(')}`),
      );
    }
  });

  it('đi qua chuỗi khoá ngoại có thật: contract_customers -> contracts -> rooms -> buildings', async () => {
    const calls = mockChain({ data: [], error: null });
    await tool('tim_khach_hang').execute({ tu_khoa: 'An' }, ctx);
    const select = calls.map((c) => c.select).join(' ');
    for (const fk of [
      'contract_customers_customer_id_fkey',
      'contract_customers_contract_id_fkey',
      'contracts_room_id_fkey',
      'rooms_building_id_fkey',
    ]) {
      expect(select, `thiếu khoá ngoại ${fk}`).toContain(fk);
    }
  });

  it('mọi phép nhúng đều nêu đích danh tên khoá ngoại', async () => {
    const calls = mockChain({ data: [], error: null });
    await tool('tim_khach_hang').execute({ tu_khoa: 'An' }, ctx);
    for (const c of calls) {
      expect(nhungThieuTenFk(c.select), `select "${c.select}" có nhúng thiếu tên FK`).toEqual([]);
    }
  });

  it('trả kết quả có phòng/toà khi khách đang thuê (positive)', async () => {
    mockChain({
      data: [
        {
          id: 'c1',
          full_name: 'Nguyễn An',
          phone: '0901234567',
          hop_dong: [
            {
              is_representative: true,
              contract: { status: 'ACTIVE', room: { name: 'A101', building: { name: 'Toà A' } } },
            },
          ],
        },
      ],
      error: null,
    });
    const ra = await tool('tim_khach_hang').execute({ tu_khoa: 'An' }, ctx);
    expect(ra).toContain('Nguyễn An');
    expect(ra).toContain('A101');
    expect(ra).toContain('Toà A');
    expect(ra, 'SĐT phải được che một phần').not.toContain('0901234567');
  });

  it('empty-state hợp lệ, KHÔNG phải thông báo lỗi (nguồn lỗi C14)', async () => {
    mockChain({ data: [], error: null });
    const ra = await tool('tim_khach_hang').execute({ tu_khoa: '0000000000' }, ctx);
    expect(ra).toMatch(/không tìm thấy/i);
    expect(ra).not.toMatch(/lỗi|error|schema/i);
  });

  it('lỗi PostgREST phải NÉM RA, không nuốt thành danh sách rỗng', async () => {
    mockChain({ data: null, error: { message: "Could not find a relationship" } });
    await expect(tool('tim_khach_hang').execute({ tu_khoa: 'An' }, ctx)).rejects.toThrow();
  });
});

describe('hop_dong_sap_het_han — hợp đồng truy vấn', () => {
  beforeEach(() => from.mockReset());

  it('KHÔNG nhúng thẳng buildings/customers từ contracts (nguồn lỗi C04/C16)', async () => {
    const calls = mockChain({ data: [], error: null });
    await tool('hop_dong_sap_het_han').execute({ so_ngay: 30 }, ctx);
    const hd = calls.find((c) => c.table === 'contracts');
    expect(hd, 'tool phải truy vấn bảng contracts').toBeTruthy();
    for (const qh of QUAN_HE_KHONG_TON_TAI.filter((q) => q.trong === 'contracts')) {
      expect(hd!.select, `còn nhúng quan hệ không tồn tại: ${qh.vi}`).not.toMatch(
        new RegExp(`(^|[\\s,(:])${qh.chuoi.replace('(', '\\(')}`),
      );
    }
  });

  it('đi qua khoá ngoại có thật cho cả phòng/toà và khách đại diện', async () => {
    const calls = mockChain({ data: [], error: null });
    await tool('hop_dong_sap_het_han').execute({ so_ngay: 30 }, ctx);
    const select = calls.map((c) => c.select).join(' ');
    for (const fk of [
      'contracts_room_id_fkey',
      'rooms_building_id_fkey',
      'contract_customers_contract_id_fkey',
      'contract_customers_customer_id_fkey',
    ]) {
      expect(select, `thiếu khoá ngoại ${fk}`).toContain(fk);
    }
  });

  it('mọi phép nhúng đều nêu đích danh tên khoá ngoại', async () => {
    const calls = mockChain({ data: [], error: null });
    await tool('hop_dong_sap_het_han').execute({ so_ngay: 7 }, ctx);
    for (const c of calls) {
      expect(nhungThieuTenFk(c.select), `select "${c.select}" có nhúng thiếu tên FK`).toEqual([]);
    }
  });

  it('chọn khách ĐẠI DIỆN, fallback phần tử đầu khi không ai được đánh dấu', async () => {
    mockChain({
      data: [
        {
          id: 'h1',
          contract_number: 'HD001',
          end_date: '2026-09-01',
          room: { name: 'B202', building: { name: 'Toà B' } },
          khach: [
            { is_representative: false, customer: { full_name: 'Người Phụ' } },
            { is_representative: true, customer: { full_name: 'Người Đại Diện' } },
          ],
        },
        {
          id: 'h2',
          contract_number: 'HD002',
          end_date: '2026-09-02',
          room: { name: 'B203', building: { name: 'Toà B' } },
          khach: [{ is_representative: false, customer: { full_name: 'Chỉ Một Người' } }],
        },
      ],
      error: null,
    });
    const ra = await tool('hop_dong_sap_het_han').execute({ so_ngay: 30 }, ctx);
    expect(ra).toContain('Người Đại Diện');
    expect(ra, 'không được lấy nhầm người phụ khi đã có đại diện').not.toContain('Người Phụ');
    expect(ra, 'không có ai đánh dấu đại diện thì lấy phần tử đầu').toContain('Chỉ Một Người');
    expect(ra).toContain('B202');
    expect(ra).toContain('Toà B');
  });

  it('empty-state hợp lệ', async () => {
    mockChain({ data: [], error: null });
    const ra = await tool('hop_dong_sap_het_han').execute({ so_ngay: 7 }, ctx);
    expect(ra).toMatch(/không có hợp đồng nào/i);
    expect(ra).not.toMatch(/lỗi|error|schema/i);
  });

  it('lỗi PostgREST phải NÉM RA, không nuốt thành danh sách rỗng', async () => {
    mockChain({ data: null, error: { message: "Could not find a relationship" } });
    await expect(tool('hop_dong_sap_het_han').execute({ so_ngay: 30 }, ctx)).rejects.toThrow();
  });
});
