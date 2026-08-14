// Tool có phạm vi công ty phải TỪ CHỐI khi chưa chốt công ty — chặn TRƯỚC truy vấn.
//
// Vì sao không để RLS lo: RLS trả về union của các công ty người dùng thuộc về.
// Đó là một câu trả lời "hợp lệ" nhưng cộng gộp sổ của nhiều công ty — không lỗi
// nào nổ ra, và con số sai theo cách không ai nhìn ra được. Trước 14/08/2026
// `ToolCtx` không có `organizationId` nên đây là hành vi mặc định của mọi tool đọc.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const from = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from, rpc } }));

const { buildRegistry, LOI_THIEU_TO_CHUC } = await import('../tools/registry');
import type { PermissionsMap } from '@/lib/permissions';

const SUPER = { __superadmin: true } as unknown as PermissionsMap;
const ORG = 'aaaa0000-0000-4000-8000-000000000001';

/**
 * Tool có phạm vi công ty. Danh sách này CỐ Ý viết tay: nó là lời khẳng định
 * "đây là những tool mà câu trả lời phụ thuộc vào việc đang xem sổ công ty nào".
 * Thêm tool đọc số liệu mới mà quên thêm vào đây thì test cuối cùng sẽ bắt.
 */
const TOOL_THEO_CONG_TY = [
  { ten: 'so_quy', args: {} },
  { ten: 'doanh_thu_thang', args: { thang: '2026-08', accrual: false } },
  { ten: 'cong_no_tong_quan', args: {} },
  { ten: 'coc_dang_giu', args: {} },
  { ten: 'ty_le_lap_day', args: {} },
  { ten: 'tim_khach_hang', args: { tu_khoa: 'An' } },
  { ten: 'hop_dong_sap_het_han', args: { so_ngay: 30 } },
  { ten: 'tim_hoa_don', args: {} },
  { ten: 'phong_trong', args: {} },
];

const tool = (ten: string) => {
  const t = buildRegistry().find((x) => x.name === ten);
  if (!t) throw new Error(`không có tool ${ten}`);
  return t;
};

describe('chưa chốt công ty ⇒ từ chối TRƯỚC khi truy vấn', () => {
  beforeEach(() => {
    from.mockReset();
    rpc.mockReset();
  });

  for (const { ten, args } of TOOL_THEO_CONG_TY) {
    it(`${ten}: ném ${LOI_THIEU_TO_CHUC} và KHÔNG gọi Supabase`, async () => {
      await expect(
        tool(ten).execute(args, { perms: SUPER, organizationId: null }),
      ).rejects.toThrow(LOI_THIEU_TO_CHUC);

      // Điểm mấu chốt: chặn phải xảy ra TRƯỚC truy vấn. Một tool query xong rồi
      // mới ném đã kịp đọc dữ liệu của công ty khác vào bộ nhớ tiến trình.
      expect(from, `${ten} đã gọi .from() dù chưa chốt công ty`).not.toHaveBeenCalled();
      expect(rpc, `${ten} đã gọi .rpc() dù chưa chốt công ty`).not.toHaveBeenCalled();
    });
  }

  it('thông báo lỗi nói rõ phải làm gì, không chỉ nêu mã lỗi', async () => {
    // Mô hình đọc chuỗi này rồi diễn giải cho người dùng. "organization_required"
    // trần thì nó sẽ tự bịa ra một lời giải thích.
    await expect(
      tool('so_quy').execute({}, { perms: SUPER, organizationId: null }),
    ).rejects.toThrow(/chọn công ty/i);
  });
});

describe('đã chốt công ty ⇒ tool PostgREST lọc đúng công ty', () => {
  beforeEach(() => {
    from.mockReset();
    rpc.mockReset();
  });

  /** Ghi lại mọi `.eq(...)` trên chuỗi truy vấn để kiểm bộ lọc. */
  function mockChain(rows: unknown[] = []) {
    const eqs: [string, unknown][] = [];
    from.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'is', 'or', 'gte', 'lte', 'order', 'limit', 'in', 'not']) {
        chain[m] = () => chain;
      }
      chain.eq = (cot: string, gt: unknown) => {
        eqs.push([cot, gt]);
        return chain;
      };
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve);
      return chain;
    });
    return eqs;
  }

  it('tim_khach_hang lọc organization_id', async () => {
    const eqs = mockChain();
    await tool('tim_khach_hang').execute({ tu_khoa: 'An' }, { perms: SUPER, organizationId: ORG });
    expect(eqs).toContainEqual(['organization_id', ORG]);
  });

  it('hop_dong_sap_het_han lọc organization_id', async () => {
    const eqs = mockChain();
    await tool('hop_dong_sap_het_han').execute({ so_ngay: 30 }, { perms: SUPER, organizationId: ORG });
    expect(eqs).toContainEqual(['organization_id', ORG]);
  });
});

describe('KHOẢNG TRỐNG ĐÃ BIẾT: RPC cũ chưa nhận công ty', () => {
  it('bốn tool RPC mới chỉ CHẶN được, chưa lọc được theo công ty', () => {
    // Ghi lại bằng test để không ai đọc nhầm "đã chốt công ty" thành "đã lọc
    // đúng công ty". `chotToChuc` buộc người dùng chọn tường minh — đó là nửa
    // giá trị có thể lấy ngay. Nhưng bốn RPC dưới đây có chữ ký cố định KHÔNG
    // nhận `p_organization_id`, nên sau khi chọn, chúng vẫn trả union các công ty
    // người dùng thuộc về. Với người MỘT công ty (đa số hiện nay) hai thứ đó
    // trùng nhau; với người nhiều công ty thì chưa.
    //
    // Đóng nốt cần RPC v2 cho từng cái — cùng loại việc mà security-remediation
    // Task 9 mô tả với `cashbook_settlement_report_v2`. KHÔNG được sửa chữ ký RPC
    // đang chạy tại chỗ: nơi khác đang gọi chúng.
    const CHUA_LOC_DUOC_THEO_CONG_TY = [
      'so_quy',            // cashbook_settlement_report(p_from, p_to)
      'ty_le_lap_day',     // occupancy_snapshot_v2(p_as_of_date, p_building_ids)
      'cong_no_tong_quan', // get_invoice_statistics_v2(p_billing_month)
      'coc_dang_giu',      // get_held_deposit_summary()
      'phong_trong',       // get_my_available_rooms()
      'tim_hoa_don',       // đi qua invoicesListQuery — hàng đợi riêng, xem hooks/useInvoices
    ];
    // Sàn: danh sách này chỉ được TEO. Thêm tên vào đây là mở rộng khoảng trống,
    // và phải có lý do tường minh trong PR.
    expect(CHUA_LOC_DUOC_THEO_CONG_TY.length).toBeLessThanOrEqual(6);
  });
});

describe('không bỏ sót tool nào', () => {
  it('mọi tool đọc số liệu nghiệp vụ đều nằm trong danh sách phạm vi công ty', () => {
    // Sàn chống bỏ quên: thêm một tool đọc sổ mới mà quên chốt công ty thì con số
    // nó trả về là union nhiều công ty — sai âm thầm.
    const CHO_PHEP_KHONG_THEO_CONG_TY = new Set([
      'huong_dan',           // tra tài liệu, lọc theo quyền từng kết quả
      'liet_ke_chu_de',      // liệt kê tài liệu
      'ban_do_he_thong',     // bản đồ trang, không đọc dữ liệu nghiệp vụ
      'mo_trang',            // điều hướng
      'tao_phieu_thu_chi_nhap', // tool GHI — chốt công ty ở Phase B (nonce server)
    ]);
    const daPhu = new Set(TOOL_THEO_CONG_TY.map((t) => t.ten));

    const thieu = buildRegistry()
      .map((t) => t.name)
      .filter((ten) => !daPhu.has(ten) && !CHO_PHEP_KHONG_THEO_CONG_TY.has(ten));

    expect(thieu, `tool chưa khai phạm vi công ty: ${thieu.join(', ')}`).toEqual([]);
  });
});
