// Tool ghi sinh từ sổ hành động — factory, kill switch, và thẻ xác nhận
// tổng quát hoá.
//
// BA ĐIỀU FILE NÀY CANH, VÀ VÌ SAO TỪNG ĐIỀU ĐÁNG CANH
//   1. NONCE KHÔNG ĐƯỢC LỌT VÀO CHUỖI TRẢ VỀ. Chuỗi đó đi thẳng vào ngữ cảnh mô
//      hình; một nonce nằm trong đó nghĩa là mô hình tự bấm được nút của chính
//      nó, và cả kiến trúc xác nhận sụp. Đây là bài đo đắt nhất trong file.
//   2. CỜ TẮT THÌ TOOL BIẾN MẤT. Kill switch bấm mà không tắt gì là kill switch
//      giả — đo cả hai chiều, không chỉ chiều tắt.
//   3. THẺ XÁC NHẬN GỌI ĐÚNG RPC. Thẻ nay phục vụ 4 hành động; gọi nhầm RPC thì
//      server trả `confirmation_contract_mismatch` và triệu chứng người dùng
//      thấy chỉ là "bấm nút không có gì xảy ra".
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from, rpc } }));

const {
  KHAI_BAO_TOOL_GHI_DE_DO,
  TOOL_GHI_HANH_DONG,
  chuoiGiaTriXemTruoc,
  dienGiaiLoiHanhDong,
  dungBanXemTruoc,
  nhanTruongXemTruoc,
  taoToolGhiTuCatalog,
  thucThiXacNhanTheoTool,
} = await import('../tools/writeTools');
const { buildRegistryDefinitions, toLlmTools, toPageAgentTools } = await import(
  '../tools/registry'
);
const { datNguCanhXacNhan, layXacNhanDangCho, xoaXacNhanDangCho } = await import(
  '../confirmationStore'
);
const { hanhDongDaTat, nhanNutXacNhan, layHangSo } = await import('../XacNhanPhieuCard');

import {
  ACTION_CATALOG,
  NHAN_TRUONG_XEM_TRUOC,
  khoaQuyenHanhDong,
  khoaRolloutHanhDong,
  type ActionCatalogEntry,
  type ActionId,
} from '../plan/actionCatalog';
import type { CopilotAvailabilitySnapshot, CopilotFlagState } from '../featureFlags';
import type { ToolCtx } from '../tools/registry';
import type { PermissionsMap } from '@/lib/permissions';
import { CHAT_SYSTEM_PROMPT } from '../systemPromptVi';

const SUPER: PermissionsMap = { __superadmin: true } as unknown as PermissionsMap;
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const NONCE = 'ab'.repeat(32);

/**
 * Mọi tool ghi sinh từ sổ — nguồn là chính bảng khai báo, không gõ lại tên.
 *
 * KHÔNG ghim số lượng: G2-D có ba, G2-E thêm hai, và mọi bài dưới đây phải tự
 * mở rộng theo bảng chứ không phải sửa một con số mỗi đợt.
 */
const TOOL_GHI = KHAI_BAO_TOOL_GHI_DE_DO;

function snapshot(trangThai: CopilotFlagState): CopilotAvailabilitySnapshot {
  const states: Record<string, CopilotFlagState> = { 'page:rooms.list': 'enabled' };
  for (const id of Object.keys(ACTION_CATALOG) as ActionId[]) {
    states[khoaRolloutHanhDong(id)] = trangThai;
  }
  return { revision: 31, fetchedAt: Date.now(), organizationId: ORG, states };
}

function ctxVoi(availability: CopilotAvailabilitySnapshot): ToolCtx {
  return {
    perms: SUPER,
    organizationId: ORG,
    availability,
    threadId: 'thread-1',
    generation: 3,
    isSuperAdmin: false,
  };
}

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  xoaXacNhanDangCho();
  datNguCanhXacNhan(null);
});

describe('factory sinh tool ghi từ sổ hành động', () => {
  it('ba tool có mặt trong registry với đúng tên, đúng khoá rollout', () => {
    const ten = new Set(buildRegistryDefinitions().map((t) => t.name));
    for (const khai of TOOL_GHI) {
      expect(ten.has(khai.name), `registry thiếu ${khai.name}`).toBe(true);
    }
    for (const tool of TOOL_GHI_HANH_DONG) {
      const khai = TOOL_GHI.find((k) => k.name === tool.name)!;
      expect(tool.rolloutKey).toBe(`action:${khai.actionId}`);
      expect(tool.chatOnly).toBe(true);
      // Không miễn trừ rollout: một đường ghi phải tắt được.
      expect(tool.rolloutExempt).toBeUndefined();
    }
  });

  it('bảng khai báo chữ chết khớp `permission` trong sổ — không có bản sao lệch', () => {
    // Ba trường `name` / `chatOnly` / `requiredPermission` tồn tại dưới dạng chữ
    // chết vì hai gate regex phải đọc được chúng (xem chú thích trong
    // `writeTools.ts`). Chúng cũng là thứ factory DÙNG lúc chạy, nên nếu chúng
    // lệch `ACTION_CATALOG` thì tool đo quyền theo một khoá còn server gác theo
    // một khoá khác — đúng loại lệch mà bài này tồn tại để bắt.
    for (const khai of TOOL_GHI) {
      const entry = ACTION_CATALOG[khai.actionId] as ActionCatalogEntry;
      expect(entry, `sổ thiếu ${khai.actionId}`).toBeDefined();
      expect(`${khai.requiredPermission.module}.${khai.requiredPermission.action}`).toBe(
        khoaQuyenHanhDong(entry),
      );
    }
  });

  it('tên tool là snake_case tiếng Việt, không chứa động từ bị cấm', () => {
    const CAM = /(approve|duyet|post|ghi_so|delete|xoa|grant|revoke|permission|sql|secret|deploy)/;
    for (const khai of TOOL_GHI) {
      expect(khai.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(khai.name, `${khai.name} chứa động từ bị cấm`).not.toMatch(CAM);
    }
  });

  it('mọi trường xem trước của mọi hành động đều có nhãn tiếng Việt', () => {
    const thieu: string[] = [];
    for (const entry of Object.values(ACTION_CATALOG) as ActionCatalogEntry[]) {
      for (const truong of entry.previewFields) {
        if (!NHAN_TRUONG_XEM_TRUOC[truong]) thieu.push(`${entry.actionId}.${truong}`);
      }
    }
    expect(thieu, `trường xem trước chưa có nhãn: ${thieu.join(', ')}`).toEqual([]);
  });
});

describe('kill switch phạm vi action cho mọi tool ghi', () => {
  it('cờ `disabled` ⇒ tất cả biến mất khỏi danh sách gửi mô hình', () => {
    const tools = toLlmTools(buildRegistryDefinitions(), ctxVoi(snapshot('disabled')));
    for (const khai of TOOL_GHI) expect(tools[khai.name]).toBeUndefined();
    expect(tools.phong_trong).toBeDefined();
  });

  it('cờ `enabled` ⇒ tất cả có mặt', () => {
    const tools = toLlmTools(buildRegistryDefinitions(), ctxVoi(snapshot('enabled')));
    for (const khai of TOOL_GHI) expect(tools[khai.name]).toBeDefined();
  });

  it('cờ `shadow` KHÔNG đủ — chỉ `enabled` mới mở đường ghi', () => {
    const tools = toLlmTools(buildRegistryDefinitions(), ctxVoi(snapshot('shadow')));
    for (const khai of TOOL_GHI) expect(tools[khai.name]).toBeUndefined();
  });

  it('PageAgent (UI-control) KHÔNG bao giờ cầm tool ghi, dù cờ đang bật', () => {
    const tools = toPageAgentTools(buildRegistryDefinitions(), ctxVoi(snapshot('enabled')));
    for (const khai of TOOL_GHI) expect(tools[khai.name]).toBeUndefined();
  });
});

describe('bước xem trước: nonce rẽ sang bộ nhớ, KHÔNG vào chuỗi trả về', () => {
  for (const khai of KHAI_BAO_TOOL_GHI_DE_DO) {
    it(`${khai.name} — chuỗi trả về không chứa nonce`, async () => {
      const entry = ACTION_CATALOG[khai.actionId] as ActionCatalogEntry;
      const preview: Record<string, unknown> = {};
      for (const truong of entry.previewFields) preview[truong] = `gia-tri-${truong}`;
      rpc.mockResolvedValue({
        data: { confirmation_nonce: NONCE, canonical: { organization_id: ORG }, preview },
        error: null,
      });

      datNguCanhXacNhan({ organizationId: ORG, threadId: 'thread-1', generation: 3 });
      const tool = TOOL_GHI_HANH_DONG.find((t) => t.name === khai.name)!;
      const ra = await tool.execute({}, ctxVoi(snapshot('enabled')));

      expect(rpc).toHaveBeenCalledWith(entry.previewRpc, {
        p_organization_id: ORG,
        p_payload: {},
      });
      expect(ra).not.toContain(NONCE);
      // Bản xem trước phải nói đủ mọi trường của hợp đồng — thiếu một trường là
      // người dùng bấm nút mà không thấy thứ mình đang đổi.
      for (const truong of entry.previewFields) {
        expect(ra).toContain(nhanTruongXemTruoc(truong));
      }
      // Nonce phải nằm trong kho bộ nhớ, kèm `tool` để thẻ biết gọi RPC nào.
      const dangCho = layXacNhanDangCho(Date.now(), undefined, {
        organizationId: ORG,
        threadId: 'thread-1',
        generation: 3,
      })!;
      expect(dangCho.nonce).toBe(NONCE);
      expect(dangCho.tool).toBe(entry.actionId);
    });
  }

  it('lỗi kill switch từ server được dịch thành câu người đọc được, không phải mã lỗi thô', () => {
    expect(dienGiaiLoiHanhDong('copilot_action_disabled: co action:x dang o trang thai disabled', 'X'))
      .toContain('TẮT bởi quản trị');
    expect(dienGiaiLoiHanhDong('tenant_emergency_denied: ...', 'X')).toContain('cấm khẩn cấp');
    expect(dienGiaiLoiHanhDong('entity_not_found', 'X')).toContain('Không tìm thấy');
    // Mã lạ thì thuật lại nguyên văn kèm nhãn — không nuốt.
    expect(dienGiaiLoiHanhDong('loi_la_hoac_moi', 'Sửa ghi chú')).toContain('loi_la_hoac_moi');
  });

  it('RPC trả lỗi ⇒ KHÔNG có đề xuất nào được cất', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'not_permitted' } });
    datNguCanhXacNhan({ organizationId: ORG, threadId: 'thread-1', generation: 3 });
    const tool = TOOL_GHI_HANH_DONG[0];
    const ra = await tool.execute({}, ctxVoi(snapshot('enabled')));
    expect(ra).toContain('không có quyền');
    expect(layXacNhanDangCho()).toBeNull();
  });
});

describe('thẻ xác nhận tổng quát hoá', () => {
  it('gọi ĐÚNG executeRpc của hành động đang chờ', async () => {
    for (const khai of TOOL_GHI) {
      rpc.mockReset();
      rpc.mockResolvedValue({ data: { status: 'da_thuc_hien' }, error: null });
      datNguCanhXacNhan({ organizationId: ORG, threadId: 'thread-1', generation: 3 });
      const entry = ACTION_CATALOG[khai.actionId] as ActionCatalogEntry;

      const ra = await thucThiXacNhanTheoTool(entry.actionId, NONCE, { a: 1 }, {
        organizationId: ORG,
        threadId: 'thread-1',
        generation: 3,
      });

      expect(rpc).toHaveBeenCalledWith(entry.executeRpc, {
        p_confirmation_nonce: NONCE,
        p_payload: { a: 1 },
      });
      expect(ra).toContain('✅');
    }
  });

  it('đường tạo phiếu vẫn đi hàm riêng — nó đọc lại MÃ PHIẾU vừa tạo', async () => {
    rpc.mockResolvedValue({ data: { status: 'da_tao', entity_id: 'id-1' }, error: null });
    from.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { code: 'PC-001' } }) }) }),
    });
    datNguCanhXacNhan({ organizationId: ORG, threadId: 'thread-1', generation: 3 });
    const ra = await thucThiXacNhanTheoTool('income_expense.create_draft', NONCE, {}, {
      organizationId: ORG,
      threadId: 'thread-1',
      generation: 3,
    });
    expect(rpc).toHaveBeenCalledWith('copilot_execute_income_expense_v1', expect.anything());
    expect(ra).toContain('PC-001');
  });

  it('`tool` không có trong sổ ⇒ ném, không im lặng gọi bừa một RPC', async () => {
    datNguCanhXacNhan({ organizationId: ORG, threadId: 'thread-1', generation: 3 });
    await expect(
      thucThiXacNhanTheoTool('khong.co_that', NONCE, {}, {
        organizationId: ORG,
        threadId: 'thread-1',
        generation: 3,
      }),
    ).rejects.toThrow('hanh_dong_khong_co_trong_so');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('`da_thuc_hien_truoc_do` nói rõ là KHÔNG làm lại', async () => {
    rpc.mockResolvedValue({ data: { status: 'da_thuc_hien_truoc_do' }, error: null });
    datNguCanhXacNhan({ organizationId: ORG, threadId: 'thread-1', generation: 3 });
    const ra = await thucThiXacNhanTheoTool('income_expense.annotate', NONCE, {}, {
      organizationId: ORG,
      threadId: 'thread-1',
      generation: 3,
    });
    expect(ra).toContain('đã được thực hiện trước đó');
  });

  it('kill switch đo theo `tool` của đề xuất, không theo một khoá ghi chết', () => {
    const bat = snapshot('enabled');
    const tat: CopilotAvailabilitySnapshot = {
      ...bat,
      states: { ...bat.states, 'action:zalo.set_conversation_flags': 'disabled' },
    };
    expect(hanhDongDaTat('zalo.set_conversation_flags', bat)).toBe(false);
    expect(hanhDongDaTat('zalo.set_conversation_flags', tat)).toBe(true);
    // Tắt một hành động KHÔNG kéo theo hành động khác.
    expect(hanhDongDaTat('income_expense.annotate', tat)).toBe(false);
    // Hành động không có trong sổ ⇒ fail-closed.
    expect(hanhDongDaTat('khong.co_that', bat)).toBe(true);
    // Snapshot vắng ⇒ fail-closed.
    expect(hanhDongDaTat('income_expense.annotate', null)).toBe(true);
  });

  it('nhãn nút lấy từ sổ, riêng đường tạo phiếu giữ câu quen thuộc', () => {
    expect(nhanNutXacNhan(layHangSo('income_expense.create_draft')!)).toBe('Tạo phiếu chờ duyệt');
    expect(nhanNutXacNhan(layHangSo('income_expense.annotate')!)).toBe(
      ACTION_CATALOG['income_expense.annotate'].labelVi,
    );
  });
});

describe('tiện ích dựng bản xem trước', () => {
  it('giá trị rỗng/null hiện "(trống)", boolean hiện Có/Không', () => {
    expect(chuoiGiaTriXemTruoc(null)).toBe('(trống)');
    expect(chuoiGiaTriXemTruoc(undefined)).toBe('(trống)');
    expect(chuoiGiaTriXemTruoc('')).toBe('(trống)');
    expect(chuoiGiaTriXemTruoc(true)).toBe('Có');
    expect(chuoiGiaTriXemTruoc(false)).toBe('Không');
    expect(chuoiGiaTriXemTruoc(0)).toBe('0');
  });

  it('chỉ đọc trường có trong hợp đồng — trường lạ của server KHÔNG vào ngữ cảnh mô hình', () => {
    const entry = ACTION_CATALOG['income_expense.annotate'] as ActionCatalogEntry;
    const ra = dungBanXemTruoc(entry, {
      ma_phieu: 'PC-9',
      ten_phieu: 'Phiếu chi',
      ghi_chu_cu: 'cũ',
      ghi_chu_moi: 'mới',
      // Trường server thêm sau này, chưa ai duyệt cho vào ngữ cảnh mô hình.
      so_dien_thoai_khach: '0900000000',
    });
    expect(ra).toContain('PC-9');
    expect(ra).not.toContain('0900000000');
  });

  it('factory dùng schema của sổ, không dựng schema riêng', () => {
    const tool = taoToolGhiTuCatalog(TOOL_GHI[0]);
    expect(tool.inputSchema).toBe(ACTION_CATALOG[TOOL_GHI[0].actionId].inputSchema);
  });
});

// ── G2-E: hai action L4 ─────────────────────────────────────────────────────
//
// L4 khác L3 ở chỗ chúng ĐI VÀO TIỀN (chỉ số công tơ nuôi hoá đơn kỳ sau) hoặc
// khoá một tài nguyên (phòng đang giữ chỗ thì người khác không đặt được). Ba
// bài dưới đây đo đúng những chỗ mà một bản sau dễ làm hỏng mà không ai thấy.
describe('G2-E — hai action L4 trong sổ và trong bảng tool', () => {
  it('mọi tool ghi sinh từ sổ đều là L3 hoặc L4 — L5 KHÔNG đi đường factory này', () => {
    // Factory chỉ biết một kiểu đồng ý: `click`. Một hành động L5 đòi `step_up`
    // (cơ chế của G3) — để nó lọt vào đây nghĩa là mở đường ghi mức cao nhất
    // bằng đúng một cú bấm thường.
    for (const khai of TOOL_GHI) {
      const entry = ACTION_CATALOG[khai.actionId] as ActionCatalogEntry;
      expect(['L3', 'L4'], `${khai.actionId} có risk ${entry.risk}`).toContain(entry.risk);
      expect(entry.consentRequired).toBe('click');
      expect(entry.executorKind).toBe('nonce_abi_v1');
    }
  });

  it('hai action L4 của G2-E có mặt, đúng quyền và đúng cặp RPC', () => {
    expect(ACTION_CATALOG['meter_reading.create'].risk).toBe('L4');
    expect(khoaQuyenHanhDong(ACTION_CATALOG['meter_reading.create'])).toBe('meter_readings.create');
    expect(ACTION_CATALOG['meter_reading.create'].executeRpc).toBe(
      'copilot_execute_meter_reading_v1',
    );
    expect(ACTION_CATALOG['reservation_deposit.create'].risk).toBe('L4');
    expect(khoaQuyenHanhDong(ACTION_CATALOG['reservation_deposit.create'])).toBe(
      'deposits.create',
    );
    expect(ACTION_CATALOG['reservation_deposit.create'].executeRpc).toBe(
      'copilot_execute_reservation_deposit_v1',
    );
    // Hai tool tương ứng phải có trong bảng khai báo (thứ hai gate regex đọc).
    const ten = new Set(TOOL_GHI.map((k) => k.name));
    expect(ten.has('ghi_chi_so_cong_to')).toBe(true);
    expect(ten.has('tao_phieu_giu_cho')).toBe(true);
  });

  it('schema chỉ số công tơ KHÔNG có trường ảnh, và từ chối chỉ số âm', () => {
    const schema = ACTION_CATALOG['meter_reading.create'].inputSchema;
    expect(
      schema.safeParse({
        meter_id: '11111111-1111-4111-8111-111111111111',
        reading_date: '2026-09-01',
        current_reading: 1234.5,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        meter_id: '11111111-1111-4111-8111-111111111111',
        reading_date: '2026-09-01',
        current_reading: -1,
      }).success,
    ).toBe(false);
    // Trường ảnh bị bỏ qua chứ không được nhận: `strip` của zod loại nó khỏi
    // dữ liệu, nên không có đường nào để nó tới RPC.
    const ra = schema.safeParse({
      meter_id: '11111111-1111-4111-8111-111111111111',
      reading_date: '2026-09-01',
      current_reading: 10,
      meter_image_url: 'https://vi-du/anh.jpg',
    });
    expect(ra.success).toBe(true);
    expect(ra.success && 'meter_image_url' in ra.data).toBe(false);
  });

  it('schema phiếu giữ chỗ chỉ nhận phòng + số tiền dương; hạn giữ chỗ do server quyết', () => {
    const schema = ACTION_CATALOG['reservation_deposit.create'].inputSchema;
    expect(
      schema.safeParse({ room_id: '11111111-1111-4111-8111-111111111111', amount: 2_000_000 })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ room_id: '11111111-1111-4111-8111-111111111111', amount: 0 }).success,
    ).toBe(false);
    const ra = schema.safeParse({
      room_id: '11111111-1111-4111-8111-111111111111',
      amount: 1,
      expires_at: '2099-01-01',
    });
    expect(ra.success && 'expires_at' in ra.data).toBe(false);
  });

  it('lỗi bất biến nháp / readback được dịch thành câu nói rõ KHÔNG có gì được ghi', () => {
    // Hai mã này nổ ra SAU khi RPC gốc đã chạy, và cả giao dịch bị cuộn lại.
    // Một câu mơ hồ ở đây sẽ khiến mô hình nói "có thể đã tạo, bạn kiểm tra lại"
    // — đúng câu làm người dùng đi tạo lần thứ hai.
    expect(dienGiaiLoiHanhDong('copilot_draft_invariant_violation', 'X')).toContain(
      'Không có gì được ghi',
    );
    expect(dienGiaiLoiHanhDong('copilot_write_readback_mismatch', 'X')).toContain(
      'Không có gì được ghi',
    );
    expect(dienGiaiLoiHanhDong('chi_so_khong_hop_le', 'X')).toContain('không âm');
    expect(dienGiaiLoiHanhDong('so_tien_khong_hop_le', 'X')).toContain('số dương');
  });
});

// ── Fix round 1 (review G2-E) ───────────────────────────────────────────────
//
// Điều đắt nhất ở đây không phải một hàng rào kỹ thuật mà là một CÂU NÓI: hệ
// từng hứa với người dùng rằng "hành động ghi luôn là nháp", trong khi một
// trong năm đường ghi vào thẳng trạng thái đã duyệt. Lời hứa sai ở đúng chỗ
// người ta dựa vào nó để bấm là một lỗ, dù không dòng SQL nào sai.
describe('G2-E fix#1 — trạng thái sau khi ghi được nói ĐÚNG ở mọi tầng', () => {
  it('mọi hành động TẠO đều có `trang_thai` trong previewFields', () => {
    // Ba action L3 là sửa-tại-chỗ (không sinh hàng mới) nên không áp; hai action
    // TẠO của G2-E và đường tạo phiếu thu/chi thì có.
    for (const id of [
      'income_expense.create_draft',
      'meter_reading.create',
      'reservation_deposit.create',
    ] as const) {
      const entry = ACTION_CATALOG[id] as ActionCatalogEntry;
      expect(
        [...entry.previewFields],
        `${id} không nói trạng thái bản ghi sinh ra`,
      ).toContain('trang_thai');
    }
  });

  it('mô tả tool ghi chỉ số nói rõ nó KHÔNG ra bản nháp', () => {
    const khai = TOOL_GHI.find((k) => k.name === 'ghi_chi_so_cong_to')!;
    expect(khai.description).toMatch(/ĐÃ DUYỆT/);
    expect(khai.description).toMatch(/KHÔNG phải bản nháp/);
  });

  it('prompt không còn hứa MỌI hành động ghi đều ra bản chờ duyệt', () => {
    // Câu cũ: "thứ ghi ra luôn là bản CHỜ DUYỆT chứ không phải bản đã duyệt".
    expect(CHAT_SYSTEM_PROMPT).not.toMatch(/luôn là bản CHỜ DUYỆT/);
    // Câu mới phải giữ được vế ĐÚNG (không ghi gì trước cú bấm) và nói rõ trạng
    // thái là tuỳ hành động.
    expect(CHAT_SYSTEM_PROMPT).toMatch(/KHÔNG GHI GÌ CHO TỚI KHI NGƯỜI DÙNG BẤM XÁC NHẬN/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/TUỲ TỪNG HÀNH ĐỘNG/);
  });
});

describe('G2-E fix#2/#3 — câu tiếng Việt khớp ngưỡng THẬT của server', () => {
  it('lỗi ngoài khoảng số tiền được dịch, kèm cả hai mốc', () => {
    const cau = dienGiaiLoiHanhDong('amount_out_of_range', 'Tạo phiếu giữ chỗ');
    expect(cau).toContain('10.000');
    expect(cau).toContain('500.000.000');
  });

  it('câu `ghi_chu_qua_dai` nêu đúng 5000 — con số mà CẢ HAI migration dùng', () => {
    // Ngưỡng ở tầng SQL do `copilotActionsL4Migration.test.ts` ghim (một ngưỡng
    // cho mọi chỗ raise mã này). Ở đây chỉ đo rằng câu tiếng Việt nêu cùng số.
    expect(dienGiaiLoiHanhDong('ghi_chu_qua_dai', 'X')).toContain('5000');
  });

  it('schema ghi chú chỉ số công tơ cho tới 5000 ký tự, khớp SQL', () => {
    const schema = ACTION_CATALOG['meter_reading.create'].inputSchema;
    const nen = {
      meter_id: '11111111-1111-4111-8111-111111111111',
      reading_date: '2026-09-01',
      current_reading: 10,
    };
    expect(schema.safeParse({ ...nen, notes: 'a'.repeat(5000) }).success).toBe(true);
    expect(schema.safeParse({ ...nen, notes: 'a'.repeat(5001) }).success).toBe(false);
  });
});
