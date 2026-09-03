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

const { buildRegistryDefinitions, LOI_THIEU_TO_CHUC } = await import('../tools/registry');
import type { PermissionsMap } from '@/lib/permissions';

/**
 * Ba trường `ToolCtx` không liên quan tới điều đang đo — khai một lần.
 *
 * `isSuperAdmin: false` là mặc định CÓ CHỦ Ý: tool `superAdminOnly` phải vắng mặt
 * trừ khi một ca nói rõ người dùng là super admin.
 */
const CTX_NEN = { threadId: null, generation: 0, isSuperAdmin: false };

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
  { ten: 'tim_hop_dong', args: { so_luong: 20 } },
  { ten: 'chi_tiet_hop_dong', args: { hop_dong_id: 'aaaa4000-0000-4000-8000-000000000011' } },
  { ten: 'tim_phieu_thu_chi', args: { so_luong: 20 } },
  { ten: 'hop_cho_duyet', args: { so_luong: 20 } },
  { ten: 'tim_khach_hen', args: { so_luong: 20 } },
  { ten: 'chi_so_cong_to', args: { ky: '2026-07', so_luong: 20 } },
  { ten: 'tim_xe', args: { so_luong: 20 } },
  { ten: 'cong_viec', args: { so_luong: 20 } },
  { ten: 'ton_kho_vat_tu', args: { so_luong: 20 } },
  // G1-C3 — mười tool báo cáo. Chúng cộng TIỀN theo kỳ, nên một câu trả lời
  // gộp sổ hai công ty ở đây là con số sai mà không lỗi nào nổ ra.
  { ten: 'bao_cao_phong_trong', args: { so_luong: 20 } },
  { ten: 'bao_cao_gia_han', args: { so_luong: 20 } },
  { ten: 'bao_cao_thanh_ly', args: { so_luong: 20 } },
  { ten: 'bao_cao_hop_dong_moi', args: { so_luong: 20 } },
  { ten: 'bao_cao_ty_le_chi_phi', args: { so_luong: 20 } },
  { ten: 'bao_cao_thu_chi_theo_ngay', args: { so_luong: 20 } },
  { ten: 'bao_cao_dong_tien', args: { so_luong: 20 } },
  { ten: 'bao_cao_lich_thu_tien', args: { so_ngay: 30, so_luong: 20 } },
  { ten: 'bao_cao_thu_thua', args: { so_luong: 20 } },
  { ten: 'bao_cao_dat_coc', args: { so_luong: 20 } },
  // G1-C4 — bốn miền nhạy cảm. Ở đây hậu quả của việc gộp sổ hai công ty
  // không phải một con số lệch mà là lương của người công ty khác, lợi nhuận
  // của cổ đông công ty khác, hội thoại riêng tư của khách công ty khác.
  { ten: 'bang_luong_ky', args: { so_luong: 20 } },
  { ten: 'loi_nhuan_co_dong', args: { so_luong: 20 } },
  { ten: 'hoi_thoai_zalo', args: { so_luong: 20 } },
  { ten: 'trang_thai_mang', args: { so_luong: 20 } },
  // G1-D2 — hai tool bộ nhớ. Chúng KHÔNG đọc sổ, nhưng ghi nhớ vẫn gắn với MỘT
  // công ty: "toà ưu tiên là DEMO A" chỉ đúng trong công ty có toà đó. Ghi vào
  // công ty đang không được chọn là lưu một câu đúng vào nơi nó sai, rồi câu đó
  // đi thẳng vào system prompt của mọi lượt chat sau.
  { ten: 'ghi_nho', args: { khoa: 'toa_uu_tien', noi_dung: 'DEMO A' } },
  { ten: 'quen', args: { khoa: 'toa_uu_tien' } },
];

const tool = (ten: string) => {
  const t = buildRegistryDefinitions().find((x) => x.name === ten);
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
        tool(ten).execute(args, { ...CTX_NEN, perms: SUPER, organizationId: null }),
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
      tool('so_quy').execute({}, { ...CTX_NEN, perms: SUPER, organizationId: null }),
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

  it('tim_khach_hang passes selected organization to its RPC', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await tool('tim_khach_hang').execute({ tu_khoa: 'An' }, { ...CTX_NEN, perms: SUPER, organizationId: ORG });
    expect(rpc).toHaveBeenCalledWith('copilot_customer_search_v1', {
      p_organization_id: ORG,
      p_search: 'An',
    });
  });

  it('hop_dong_sap_het_han passes selected organization to its RPC', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await tool('hop_dong_sap_het_han').execute({ so_ngay: 30 }, { ...CTX_NEN, perms: SUPER, organizationId: ORG });
    expect(rpc).toHaveBeenCalledWith(
      'copilot_expiring_contracts_v1',
      expect.objectContaining({ p_organization_id: ORG, p_window_days: 30 }),
    );
  });

  it('registry binds every scoped tool to the selected organization before querying', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('src/copilot/tools/registry.ts', 'utf8'),
    );
    const nghiệpVụ = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('src/copilot/tools/nghiepVuTools.ts', 'utf8'),
    );
    expect(source).toContain(".eq('organization_id', organizationId)");
    expect(source).toContain("copilot_available_rooms_v1");
    expect(source).toContain("copilot_invoice_search_v1");
    expect(source).toContain("copilot_financial_pnl_v1");
    expect(nghiệpVụ).toContain("copilot_occupancy_v1");
    expect(nghiệpVụ).toContain("copilot_invoice_stats_v1");
    expect(nghiệpVụ).toContain("copilot_deposit_summary_v1");
    expect(nghiệpVụ).toContain("copilot_cashbook_settlement_v2");
    expect(source).not.toContain("get_my_available_rooms");
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
    const CHUA_LOC_DUOC_THEO_CONG_TY: string[] = [];
    // Sàn: danh sách này chỉ được TEO. Thêm tên vào đây là mở rộng khoảng trống,
    // và phải có lý do tường minh trong PR.
    expect(CHUA_LOC_DUOC_THEO_CONG_TY).toEqual([]);
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

    const thieu = buildRegistryDefinitions()
      .map((t) => t.name)
      .filter((ten) => !daPhu.has(ten) && !CHO_PHEP_KHONG_THEO_CONG_TY.has(ten));

    expect(thieu, `tool chưa khai phạm vi công ty: ${thieu.join(', ')}`).toEqual([]);
  });
});
