// Test tool nghiệp vụ. Trọng tâm: PII KHÔNG được rời hệ thống.
//
// Kết quả tool đi thẳng vào ngữ cảnh mô hình, tức đi qua `llm-proxy` ra nhà
// cung cấp LLM bên thứ ba. Với dữ liệu CÓ CẤU TRÚC, hàng rào đúng là danh sách
// trường cho phép — `maskPii` chỉ bắt được MẪU (số điện thoại, CCCD, số tài
// khoản sau từ khoá); nó không biết "Nguyễn Văn A" là họ tên, cũng không biết
// một ghi chú tự do chứa gì.
import { describe, expect, it, vi } from 'vitest';

/**
 * Ba trường `ToolCtx` không liên quan tới điều đang đo — khai một lần.
 *
 * `isSuperAdmin: false` là mặc định CÓ CHỦ Ý: tool `superAdminOnly` phải vắng mặt
 * trừ khi một ca nói rõ người dùng là super admin.
 */
const CTX_NEN = { threadId: null, generation: 0, isSuperAdmin: false };

// Giả lập biên mạng để chạy được ĐƯỜNG THẬT của tool, không chỉ hàm định dạng.
// Cần vì kiểm bằng đột biến đã chỉ ra: test chỉ gọi `dinhDangSoQuy` trực tiếp
// thì việc tool ngừng dùng hàm đó (quay lại đổ JSON thô) KHÔNG bị bắt.
const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc, from } }));

const { dinhDangSoQuy, soQuy, tyLeLapDay, TOOL_NGHIEP_VU } = await import('../tools/nghiepVuTools');

/** Payload dựng theo đúng hình dạng `cashbook_settlement_report` trên production. */
const BAO_CAO = {
  from: '2026-08-01',
  to: '2026-08-12',
  accounts: [
    {
      account_id: 'a1',
      name: 'TK 19036789456013 VCB',
      owner_name: 'Nguyễn Văn Kế Toán',
      is_bank: true,
      current_balance: 125_000_000,
      period_collected: 40_000_000,
      period_spent: 15_000_000,
      period_handed_over: 5_000_000,
    },
    {
      account_id: 'a2',
      name: 'Quỹ tiền mặt toà A',
      owner_name: 'Trần Thị Thủ Quỹ',
      is_bank: false,
      current_balance: 8_000_000,
      period_collected: 12_000_000,
      period_spent: 9_000_000,
      period_handed_over: 0,
    },
  ],
  sessions: [
    { code: 'BG01', giver_name: 'Lê Văn Giao', receiver_name: 'Phạm Thị Nhận', gross: 20_000_000, expense: 1_000_000, net: 19_000_000, voucher_count: 7 },
    { code: 'BG02', giver_name: 'Hoàng Văn B', receiver_name: 'Đỗ Thị C', gross: 5_000_000, expense: 0, net: 5_000_000, voucher_count: 2 },
  ],
  reconciliations: [
    { account_name: 'Quỹ tiền mặt toà A', note: 'Thiếu 200k, nghi anh Tuấn cầm chưa trả — hỏi lại', system_balance: 8_200_000, counted_balance: 8_000_000, diff: -200_000, status: 'confirmed' },
    { account_name: 'TK 19036789456013 VCB', note: 'khớp', system_balance: 125_000_000, counted_balance: 125_000_000, diff: 0, status: 'confirmed' },
  ],
};

describe('so_quy — PII không được rời hệ thống', () => {
  const ra = dinhDangSoQuy(BAO_CAO, '2026-08-01', '2026-08-12');

  it('KHÔNG chứa họ tên bất kỳ ai', () => {
    // Bản đầu `JSON.stringify(data)` đổ nguyên payload, gồm cả bốn cái tên này.
    for (const ten of ['Nguyễn Văn Kế Toán', 'Trần Thị Thủ Quỹ', 'Lê Văn Giao', 'Phạm Thị Nhận', 'Hoàng Văn B', 'Đỗ Thị C']) {
      expect(ra, `lọt tên "${ten}"`).not.toContain(ten);
    }
  });

  it('KHÔNG chứa ghi chú đối soát tự do', () => {
    // Ghi chú là ô nhập tự do — nó chứa gì thì không ai đoán trước được.
    expect(ra).not.toContain('nghi anh Tuấn');
    expect(ra).not.toContain('Thiếu 200k');
  });

  it('CHE số tài khoản nằm trong tên sổ', () => {
    // Quy ước đặt tên ở đây nhét số tài khoản vào chính cái tên; hàm SQL còn
    // nhận diện sổ ngân hàng bằng `name ILIKE 'tk%'`.
    expect(ra).not.toContain('19036789456013');
    expect(ra).toContain('[STK đã ẩn]');
  });

  it('nhưng VẪN trả lời được câu người dùng hỏi', () => {
    expect(ra).toContain('Quỹ tiền mặt toà A'); // biết đang nói sổ nào
    expect(ra).toMatch(/TỔNG số dư/);
    expect(ra).toMatch(/2 phiên/); // bàn giao: đếm được, không cần tên
    expect(ra).toMatch(/Có chênh lệch: 1/); // đối soát: biết có lệch, không cần ghi chú
  });

  it('payload rỗng không làm vỡ', () => {
    expect(dinhDangSoQuy({}, '2026-08-01', '2026-08-12')).toContain('Không có dữ liệu');
  });

  it('TOOL THẬT cũng sạch — không chỉ hàm định dạng', async () => {
    // Kiểm bằng đột biến bắt được đúng chỗ này: bản test đầu chỉ gọi
    // `dinhDangSoQuy` trực tiếp, nên nếu tool NGỪNG dùng nó (quay lại
    // `JSON.stringify(data)`) thì không test nào đỏ. Ca này chạy qua `execute`.
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is']) chain[method] = () => chain;
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    from.mockReturnValue(chain);
    rpc.mockResolvedValueOnce({ data: BAO_CAO, error: null });
    const out = await soQuy.execute({ tu_ngay: '2026-08-01', den_ngay: '2026-08-12' }, { ...CTX_NEN, perms: undefined, organizationId: 'aaaa0000-0000-4000-8000-000000000001' });
    expect(rpc).toHaveBeenCalledWith('copilot_cashbook_settlement_v2', {
      p_from: '2026-08-01',
      p_to: '2026-08-12',
      p_organization_id: 'aaaa0000-0000-4000-8000-000000000001',
    });
    for (const ten of ['Nguyễn Văn Kế Toán', 'Lê Văn Giao', 'nghi anh Tuấn']) {
      expect(out, `tool để lọt "${ten}"`).not.toContain(ten);
    }
    expect(out).not.toContain('19036789456013');
    expect(out).toMatch(/TỔNG số dư/);
  });
});

describe('quyền của tool nghiệp vụ khớp màn hình tương ứng', () => {
  it('ty_le_lap_day đòi reports_real_estate.occupancy, KHÔNG phải rooms.view', () => {
    // Màn hình /reports/real-estate/occupancy gác bằng cặp này. Cấp qua Copilot
    // với một quyền rộng hơn là mở cửa sau vòng qua hàng rào của màn hình.
    expect(tyLeLapDay.requiredPermission).toEqual({
      module: 'reports_real_estate',
      action: 'occupancy',
    });
  });

  it('mọi tool nghiệp vụ đều CÓ gác quyền — không tool nào để trống', () => {
    expect(TOOL_NGHIEP_VU.length).toBeGreaterThanOrEqual(4); // sàn chống-xanh-rỗng
    for (const t of TOOL_NGHIEP_VU) {
      expect(t.requiredPermission, `tool "${t.name}" không gác quyền`).toBeTruthy();
    }
  });
});
