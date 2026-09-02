// Vitest Phase 2 (PLAN.md §Phase 2): maskPii, adapter ×2 cùng schema,
// buildChatContext giữ cặp tool-call, mo_trang canonical route + perm,
// parse provider:model, dựng lại conversation từ rows.
import { describe, expect, it } from 'vitest';
import type { Message } from '@page-agent/llms';
import { maskPii, maskPhonePartial } from '../maskPii';
import { parseProviderModel } from '../copilotConfig';
import { buildChatContext, rowsToMessages } from '../chatEngine';
import {
  buildRegistry,
  buildRegistryDefinitions,
  toLlmTools,
  toPageAgentTools,
  listDocTopics,
} from '../tools/registry';
import { ROUTE_DIEU_HUONG } from '../pageScope';
import { makeIdempotencyKey } from '../tools/writeTools';
import { DANGER_RE, SUBMIT_RE, nhanNguyHiem } from '../safetyGuard';
import { hrefAnToan } from '../hrefAnToan';
import { modelConDungDuoc } from '../useAiProviders';
import type { PermissionsMap } from '@/lib/permissions';

const SUPER: PermissionsMap = { __superadmin: true } as unknown as PermissionsMap;
/** Cong ty dung trong test - ToolCtx nay bat buoc co, xem chotToChuc. */
const ORG_TEST = 'aaaa0000-0000-4000-8000-000000000001';
const STAFF_ROOMS_ONLY: PermissionsMap = { rooms: { view: true } };
const AVAILABILITY = {
  revision: 1,
  fetchedAt: Date.now(),
  organizationId: ORG_TEST,
  states: {
    'page:rooms.list': 'enabled' as const,
    'page:customers.list': 'enabled' as const,
    'page:invoices.list': 'enabled' as const,
  },
};

describe('maskPii', () => {
  it('che SĐT VN (0x và +84, có/không phân cách)', () => {
    expect(maskPii('gọi 0901234567 nhé')).not.toContain('0901234567');
    expect(maskPii('sđt +84 901 234 567')).not.toContain('901 234 567');
  });
  it('che CCCD 12 số', () => {
    expect(maskPii('CCCD 079123456789')).toContain('[CCCD đã ẩn]');
  });
  it('che STK khi có từ khoá ngữ cảnh', () => {
    expect(maskPii('STK: 19036789456013')).toContain('[STK đã ẩn]');
    expect(maskPii('số tài khoản 9704229211234')).toContain('[STK đã ẩn]');
  });
  it('KHÔNG nuốt số tiền định dạng VN', () => {
    const s = maskPii('giá 1.500.000 đ, cọc 3.000.000 đ');
    expect(s).toContain('1.500.000');
    expect(s).toContain('3.000.000');
  });
  it('maskPhonePartial giữ đầu-cuối', () => {
    expect(maskPhonePartial('0901234567')).toBe('090***4567');
    expect(maskPhonePartial('')).toBe('');
  });
});

describe('parseProviderModel', () => {
  it('tách đúng khi model-id chứa ":" (vd :free)', () => {
    expect(parseProviderModel('openrouter:qwen/qwen3-coder:free')).toEqual({
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder:free',
    });
  });
  it('null khi thiếu provider hoặc model', () => {
    expect(parseProviderModel('gpt-4o')).toBeNull();
    expect(parseProviderModel(':x')).toBeNull();
    expect(parseProviderModel('openai:')).toBeNull();
  });
});

describe('buildChatContext', () => {
  const toolPair = (id: string): Message[] => [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'tim_phong', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: id, content: 'kết quả' },
  ];

  it('giữ NGUYÊN cặp tool_calls ↔ tool khi cắt', () => {
    const history: Message[] = [
      { role: 'user', content: 'câu 1' },
      ...toolPair('a'),
      { role: 'assistant', content: 'trả lời 1' },
      { role: 'user', content: 'câu 2' },
      ...toolPair('b'),
      { role: 'assistant', content: 'trả lời 2' },
    ];
    const ctx = buildChatContext(history, { maxTurns: 3 });
    // Không được có message tool mồ côi (tool mà assistant tool_calls trước nó không nằm trong ctx)
    ctx.forEach((m, i) => {
      if (m.role === 'tool') {
        const prev = ctx.slice(0, i).reverse().find((x) => x.role === 'assistant');
        expect(prev?.tool_calls?.some((tc) => tc.id === m.tool_call_id)).toBe(true);
      }
    });
    // Cắt từ CUỐI: message cuối cùng phải giữ nguyên
    expect(ctx[ctx.length - 1].content).toBe('trả lời 2');
  });

  it('tôn trọng maxChars nhưng luôn giữ ít nhất 1 block', () => {
    const history: Message[] = [
      { role: 'user', content: 'x'.repeat(50_000) },
      { role: 'assistant', content: 'y'.repeat(50_000) },
    ];
    const ctx = buildChatContext(history, { maxChars: 100 });
    expect(ctx.length).toBeGreaterThan(0);
  });
});

describe('rowsToMessages (dựng lại conversation)', () => {
  it('map đúng role/content/tool_calls/tool_call_id theo thứ tự rows', () => {
    const rows: Parameters<typeof rowsToMessages>[0] = [
      { role: 'user', content: 'hỏi', tool_calls: null, tool_call_id: null },
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
        tool_call_id: null,
      },
      { role: 'tool', content: 'kq', tool_calls: null, tool_call_id: 'c1' },
      { role: 'assistant', content: 'đáp', tool_calls: null, tool_call_id: null },
    ];
    const msgs = rowsToMessages(rows);
    expect(msgs).toHaveLength(4);
    expect(msgs[1].tool_calls?.[0].id).toBe('c1');
    expect(msgs[2].tool_call_id).toBe('c1');
    expect(msgs[3].content).toBe('đáp');
  });
});

describe('registry + adapters', () => {
  it('2 adapter cho ra CÙNG schema với tool CÓ Ở CẢ HAI bên', () => {
    // Trước 12/08/2026 test này duyệt mọi khoá của llmTools và đòi paTools phải
    // có đủ — tức nó khẳng định hai adapter cấp CÙNG MỘT bộ tool. Khẳng định đó
    // chính là thứ đã để write tool lọt sang PageAgent. Bất biến đúng hẹp hơn:
    // tool nào xuất hiện ở CẢ HAI thì phải dùng chung schema, không phải bản chép.
    const reg = buildRegistryDefinitions();
    const llmTools = toLlmTools(reg, { perms: SUPER, organizationId: ORG_TEST, availability: AVAILABILITY });
    const paTools = toPageAgentTools(reg, { perms: SUPER, organizationId: ORG_TEST, availability: AVAILABILITY });
    const chung = Object.keys(llmTools).filter((name) => paTools[name]);
    expect(chung.length).toBeGreaterThanOrEqual(5); // sàn chống-xanh-rỗng
    for (const name of chung) {
      expect(paTools[name].description).toBe(llmTools[name].description);
      expect(paTools[name].inputSchema).toBe(llmTools[name].inputSchema);
    }
  });

  it('tool GHI không bao giờ tới tay PageAgent, kể cả khi thừa quyền', () => {
    const reg = buildRegistryDefinitions();
    // SUPER có đủ income_expenses.create — nếu chặn bằng quyền thì test này xanh
    // giả. Chặn phải đến từ cờ chatOnly, không phải từ việc thiếu quyền.
    expect(toLlmTools(reg, { perms: SUPER, organizationId: ORG_TEST, availability: AVAILABILITY }).tao_phieu_thu_chi_nhap).toBeDefined();
    expect(toPageAgentTools(reg, { perms: SUPER, organizationId: ORG_TEST, availability: AVAILABILITY }).tao_phieu_thu_chi_nhap).toBeUndefined();

    // Và nói rộng hơn: KHÔNG tool ghi nào lọt sang adapter UI-control.
    const toolGhi = reg.filter((t) => t.chatOnly).map((t) => t.name);
    expect(toolGhi.length).toBeGreaterThanOrEqual(1); // sàn chống-xanh-rỗng
    const paNames = Object.keys(toPageAgentTools(reg, { perms: SUPER, organizationId: ORG_TEST, availability: AVAILABILITY }));
    for (const name of toolGhi) expect(paNames).not.toContain(name);
  });

  it('mo_trang CHỈ có ở adapter UI-control (chat không điều hướng)', () => {
    const reg = buildRegistryDefinitions();
    expect(toLlmTools(reg, { perms: SUPER, organizationId: ORG_TEST, availability: AVAILABILITY }).mo_trang).toBeUndefined();
    expect(toPageAgentTools(reg, { perms: SUPER, organizationId: ORG_TEST, availability: AVAILABILITY }).mo_trang).toBeDefined();
  });

  it('MỌI requiredPermission phải là cặp module.action CÓ THẬT trong catalog', async () => {
    // Gõ sai tên module hoặc action không gây lỗi biên dịch: `canUse` chỉ trả
    // `false`, nên tool biến mất khỏi danh sách gửi cho mô hình với MỌI người
    // dùng, kể cả superadmin — im lặng, không log, không đỏ ở đâu cả. Đây là
    // cùng lớp lỗi mà `check-copilot-routes.mjs` canh cho MO_TRANG_ROUTES.
    const { ALL_PAGE_FEATURES } = await import('@/lib/permissionPages');
    const coThat = new Set(ALL_PAGE_FEATURES.map((f) => `${f.module}.${f.action}`));
    expect(coThat.size).toBeGreaterThanOrEqual(100); // sàn chống-xanh-rỗng

    const reg = buildRegistryDefinitions();
    const coQuyen = reg.filter((t) => t.requiredPermission);
    expect(coQuyen.length).toBeGreaterThanOrEqual(6); // sàn chống-xanh-rỗng
    for (const t of coQuyen) {
      const { module, action } = t.requiredPermission!;
      expect(coThat.has(`${module}.${action}`), `tool "${t.name}" đòi quyền không tồn tại: ${module}.${action}`).toBe(true);
    }
  });

  it('mọi tool có tên DUY NHẤT — trùng tên là một cái nuốt cái kia', () => {
    const ten = buildRegistryDefinitions().map((t) => t.name);
    expect(new Set(ten).size).toBe(ten.length);
    expect(ten.length).toBeGreaterThanOrEqual(12); // sàn chống-xanh-rỗng
  });

  it('tool bị LOẠI khỏi danh sách khi thiếu quyền', () => {
    const reg = buildRegistryDefinitions();
    const tools = toLlmTools(reg, { perms: STAFF_ROOMS_ONLY, organizationId: ORG_TEST, availability: AVAILABILITY });
    expect(tools.phong_trong).toBeDefined();       // rooms.view có
    expect(tools.doanh_thu_thang).toBeUndefined(); // reports_finance.analysis không
    expect(tools.huong_dan).toBeDefined();         // không cần quyền
  });

  it('mo_trang: route CANONICAL /apartments (không /rooms) + gọi navigate', async () => {
    const phong = ROUTE_DIEU_HUONG.find((m) => m.key === 'rooms.list')!;
    expect(phong.route).toBe('/apartments');
    expect(ROUTE_DIEU_HUONG.some((m) => m.route === '/rooms')).toBe(false);
    const reg = buildRegistryDefinitions();
    const moTrang = reg.find((t) => t.name === 'mo_trang')!;
    let navigated = '';
    const out = await moTrang.execute({ trang: 'rooms.list' }, { perms: SUPER, organizationId: ORG_TEST, navigate: (to) => { navigated = to; } });
    expect(navigated).toBe('/apartments');
    expect(out).toContain('/apartments');
  });

  it('mo_trang: đích SINH TỪ page contract, không phải danh sách tay 3 trang', () => {
    // Đo 02/09/2026: 19 đích. Trước lát G1-A đúng 3, chép tay ở ba file.
    expect(ROUTE_DIEU_HUONG.length).toBeGreaterThanOrEqual(15);
    const moTrang = buildRegistryDefinitions().find((t) => t.name === 'mo_trang')!;
    // Description phải kể ĐỦ nhãn: mô hình không gọi tới trang nó không thấy tên.
    for (const muc of ROUTE_DIEU_HUONG) expect(moTrang.description).toContain(muc.label);
  });

  it('mo_trang: chặn khi không có quyền module đích', async () => {
    const reg = buildRegistryDefinitions();
    const moTrang = reg.find((t) => t.name === 'mo_trang')!;
    await expect(
      moTrang.execute({ trang: 'invoices.list' }, { perms: STAFF_ROOMS_ONLY, organizationId: ORG_TEST, navigate: () => {} }),
    ).rejects.toThrow(/quyền/);
  });
});

describe('huong_dan — allowlist tài liệu + gác quyền', () => {
  // Trước manifest, tool này glob mù docs/he-thong/*.md: mọi file thả vào thư
  // mục đều thành nguồn tư vấn cho người dùng thật, và ai cũng đọc được tài
  // liệu lương/lợi nhuận.
  const keys = (perms?: PermissionsMap) => listDocTopics(perms).map((t) => t.key);

  it('KHÔNG đọc file ngoài allowlist (perf writeup, bản đồ realtime, mục lục)', () => {
    const all = keys(SUPER);
    expect(all).not.toContain('perf-2026-06-30-toi-uu-hieu-nang');
    expect(all).not.toContain('realtime-sync');
    expect(all).not.toContain('README');
    expect(all).toContain('07-hoa-don-thanh-toan');
  });

  it('tài liệu nhạy cảm bị loại khi thiếu quyền, hiện ra khi có quyền', () => {
    const staff = keys(STAFF_ROOMS_ONLY);
    expect(staff).not.toContain('17-luong-thuong');
    expect(staff).not.toContain('12-co-dong-loi-nhuan');
    expect(staff).toContain('05-hop-dong'); // không gắn quyền -> vẫn đọc được

    const withSalary = keys({ ...STAFF_ROOMS_ONLY, salary: { view: true } });
    expect(withSalary).toContain('17-luong-thuong');
  });

  it('fail closed khi perms chưa load', () => {
    const none = keys(undefined);
    expect(none).not.toContain('17-luong-thuong');
    expect(none).not.toContain('20-phe-duyet-tai-chinh');
    expect(none).toContain('00-tong-quan');
  });

  it('huong_dan: không tìm thấy thì nói thẳng, không kể tên tài liệu ngoài quyền', async () => {
    // Câu tra cũ ở đây là 'khong-co-chu-de-nay-dau'. Nó từng "không tìm thấy"
    // vì bản cũ so khớp trên TÊN FILE. Với tìm kiếm theo nội dung thì nó KHÔNG
    // còn vô nghĩa — nó chứa cụm "chủ đề", một từ có thật. Đổi sang câu vô
    // nghĩa hẳn để test kiểm đúng thứ nó định kiểm.
    const reg = buildRegistryDefinitions();
    const tool = reg.find((t) => t.name === 'huong_dan')!;
    const out = await tool.execute({ chu_de: 'xyzzy plugh frobnicate' }, { perms: STAFF_ROOMS_ONLY, organizationId: ORG_TEST });
    expect(out).toContain('Không tìm thấy');
    expect(out).not.toContain('(nguồn: 17-luong-thuong');
  });

  it('liet_ke_chu_de: chỉ kể tài liệu trong quyền', async () => {
    const reg = buildRegistryDefinitions();
    const tool = reg.find((t) => t.name === 'liet_ke_chu_de')!;
    const out = await tool.execute({}, { perms: STAFF_ROOMS_ONLY, organizationId: ORG_TEST });
    expect(out).toContain('05-hop-dong');
    expect(out).not.toContain('17-luong-thuong');
    // perms chưa tải: nói rõ là đang tải, KHÔNG nói "không có tài liệu nào"
    const chuaTai = await tool.execute({}, { perms: undefined, organizationId: ORG_TEST });
    expect(chuaTai).not.toContain('17-luong-thuong');
  });
});

describe('Phase 5 — write tool + form-fill guard', () => {
  it('tao_phieu_thu_chi_nhap: KHÔNG còn cờ xác nhận nào trong input schema', async () => {
    const reg = buildRegistryDefinitions();
    const tool = reg.find((t) => t.name === 'tao_phieu_thu_chi_nhap')!;
    expect(tool.requiredPermission).toEqual({ module: 'income_expenses', action: 'create' });

    // Đây là bất biến ĐẮT NHẤT của cả luồng ghi: mô hình không được có bất kỳ
    // trường nào để tự khai "người dùng đã đồng ý". Còn một cờ như thế thì nonce
    // chỉ là trang trí — mô hình vẫn tự bấm nút của chính nó.
    const schema = (await import('zod/v4')).toJSONSchema(tool.inputSchema, { io: 'input' }) as {
      properties?: Record<string, unknown>;
    };
    const khoa = Object.keys(schema.properties ?? {});
    expect(khoa).toEqual(
      expect.arrayContaining(['loai', 'so_tien', 'ten_phieu', 'toa_nha', 'hang_muc']),
    );
    for (const cam of ['xac_nhan', 'confirm', 'confirmed', 'confirmation_nonce', 'nonce']) {
      expect(khoa, `input schema còn trường "${cam}"`).not.toContain(cam);
    }

    // Và tool ghi vẫn không bao giờ tới tay PageAgent.
    expect(toLlmTools(reg, { perms: STAFF_ROOMS_ONLY, organizationId: ORG_TEST, availability: AVAILABILITY }).tao_phieu_thu_chi_nhap).toBeUndefined();
    expect(toLlmTools(reg, { perms: SUPER, organizationId: ORG_TEST, availability: AVAILABILITY }).tao_phieu_thu_chi_nhap).toBeDefined();
  });

  it('hàm thực thi xác nhận KHÔNG nằm trong registry', async () => {
    // Nếu `thucThiXacNhan` là một DomainTool thì mô hình gọi được nó, và cả kiến
    // trúc nonce sụp trong một dòng.
    const reg = buildRegistryDefinitions();
    const { thucThiXacNhan } = await import('../tools/writeTools');
    expect(typeof thucThiXacNhan).toBe('function');
    for (const t of reg) {
      expect(t.execute, `tool "${t.name}" chính là hàm thực thi xác nhận`).not.toBe(thucThiXacNhan);
      expect(t.name).not.toMatch(/xac_nhan|confirm/i);
    }
  });

  it('KHÔNG chỉ dẫn nào trỏ tới tool đã bị gỡ khỏi registry', async () => {
    // `respond` từng là tool giả làm dấu "xong", bị gỡ khi chat engine chuyển
    // sang tool_choice:'auto' (chú thích đầu chatEngine.ts). Chỉ dẫn còn sót lại
    // bảo mô hình "gọi respond NGAY BÂY GIỜ" là trỏ vào hư không — mô hình hoặc
    // lờ đi, hoặc gọi rồi nhận lỗi, và bước dừng-để-hỏi trước khi tạo phiếu
    // hỏng đúng lúc nó cần chắc nhất.
    const reg = buildRegistryDefinitions();
    const tenTool = new Set(reg.map((t) => t.name));
    expect(tenTool.has('respond')).toBe(false);

    // Quét cả description (mô hình đọc mọi lúc) lẫn văn bản xem trước của tool
    // ghi (mô hình đọc đúng lúc sắp tạo phiếu).
    const { TEXT_XEM_TRUOC_MAU } = await import('../tools/writeTools');
    const vanBan = [...reg.map((t) => t.description), TEXT_XEM_TRUOC_MAU].join('\n');
    for (const m of vanBan.matchAll(/g[ọo]i\s+`?([a-z_][a-z0-9_]*)`?/gi)) {
      const ten = m[1].toLowerCase();
      // Chỉ soi các từ trông như tên tool (có gạch dưới hoặc trùng tool đã biết).
      if (!ten.includes('_') && !tenTool.has(ten)) continue;
      expect(tenTool.has(ten), `chỉ dẫn nhắc tool không tồn tại: "${ten}"`).toBe(true);
    }
    expect(vanBan.toLowerCase()).not.toContain('gọi respond');
  });

  it('makeIdempotencyKey: ổn định + phân biệt nội dung khác', () => {
    const a = makeIdempotencyKey(['u1', 'EXPENSE', 100000, 'b1', 't1', '2026-07-11', 'Chi thử']);
    const b = makeIdempotencyKey(['u1', 'EXPENSE', 100000, 'b1', 't1', '2026-07-11', 'Chi thử']);
    const c = makeIdempotencyKey(['u1', 'EXPENSE', 200000, 'b1', 't1', '2026-07-11', 'Chi thử']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('SUBMIT_RE chặn nút submit, không chặn nút lọc/điều hướng', () => {
    for (const label of ['Lưu', 'Cập nhật', 'Xác nhận', 'Hoàn tất', 'Tạo mới', 'Gửi', 'Save', 'Submit']) {
      expect(SUBMIT_RE.test(label)).toBe(true);
    }
    for (const label of ['Lọc', 'Tìm kiếm', 'Xem chi tiết', 'Trang sau', 'Đóng']) {
      expect(SUBMIT_RE.test(label) || DANGER_RE.test(label)).toBe(false);
    }
  });

  it('DANGER_RE vẫn chặn hành động phá huỷ', () => {
    for (const label of ['Xoá hoá đơn', 'Huỷ phiếu', 'Duyệt', 'Thanh lý HĐ', 'Delete']) {
      expect(DANGER_RE.test(label)).toBe(true);
    }
  });

  it('nhãn ở `title` cũng bị soi, không chỉ textContent/aria-label', () => {
    // Khảo sát 14/08/2026: nút icon trên bảng toà nhà đặt nhãn ở `title`
    // (BuildingListTable "Sửa"/"Xoá"/"In"). Trước đây chỉ đọc textContent +
    // aria-label nên nút "Xoá" đó là icon trần không chữ — hàng rào đi ngang qua.
    expect(nhanNguyHiem(['', '', 'Xoá'])).toBe(true);
    expect(nhanNguyHiem(['', '', 'Lưu'])).toBe(true);
    expect(nhanNguyHiem(['', '', 'In'])).toBe(false);
    expect(nhanNguyHiem(['', '', 'Sửa'])).toBe(false);
  });

  it('nhãn được soi RỜI, chuỗi trước không che được chuỗi sau', () => {
    // SUBMIT_RE neo đầu (`^`). Nối "Xem" + "Lưu" thành một chuỗi thì luật submit
    // không khớp nữa — nối chuỗi ở đây là tự tạo điểm mù.
    expect(SUBMIT_RE.test('Xem Lưu')).toBe(false);
    expect(nhanNguyHiem(['Xem', 'Lưu'])).toBe(true);
  });

  it('biến thể chính tả thật trong repo đều bị chặn', () => {
    // Cùng một hành động viết khác dấu ở các file khác nhau — khảo sát 14/08
    // liệt kê đủ cặp này; regex phải phủ cả hai bên.
    for (const label of [
      'Xóa', 'Xoá', 'Đang xóa...', 'Đang xoá...',
      'Hủy', 'Huỷ', 'Huỷ bỏ',
      'Thanh lý', 'Xác nhận thanh lý',
      'Lập hoá đơn & thanh lý', 'Lập hoá đơn & Thanh lý',
      'Nhượng hợp đồng', 'Nhượng HĐ',
    ]) {
      expect(nhanNguyHiem([label]), `nhãn "${label}" lọt hàng rào`).toBe(true);
    }
  });

  it('"nhượng" bị chặn nhưng từ nối "nhưng" thì không', () => {
    // Ranh giới hẹp: hai ký tự "ượ" phải khớp RỜI. Gộp thành một char class sẽ
    // nuốt luôn "nhưng" và chặn nhầm những nút hoàn toàn lành.
    expect(DANGER_RE.test('Nhượng HĐ')).toBe(true);
    expect(DANGER_RE.test('Nhượng hợp đồng')).toBe(true);
    expect(DANGER_RE.test('chuyển nhượng')).toBe(true);
    expect(DANGER_RE.test('Có nhưng chưa đủ')).toBe(false);
  });

  it('KHOẢNG TRỐNG ĐÃ BIẾT: nhãn chỉ nằm trong tooltip thì regex không thấy', () => {
    // Ghi lại bằng test để không ai đọc nhầm hàng rào này là đã phủ hết.
    // "Gia hạn", "Chuyển phòng", "ĐK chuyển đi" trên bảng hợp đồng chỉ có chữ
    // trong <TooltipContent> (render vào portal khi hover) — lúc quét DOM thì
    // nút là icon trần. Đóng lỗ này là việc của safe-control theo khai báo
    // (Phase C), không phải của regex nhãn.
    for (const label of ['Gia hạn', 'Chuyển phòng', 'ĐK chuyển đi']) {
      expect(nhanNguyHiem([label]), `nếu regex đã bắt "${label}" thì cập nhật test này`).toBe(false);
    }
    // Và control autosave không nhãn thì không nhãn nào bắt được.
    expect(nhanNguyHiem([])).toBe(false);
  });
});

describe('modelConDungDuoc — preference trỏ vào model đã bị gỡ', () => {
  // Đã gặp thật 12/08/2026: tài khoản còn lưu `9router:mmf/mimo-auto` sau khi
  // model đó bị gỡ khỏi VPS. Trước khi proxy ép allowlist thì hỏng ở upstream;
  // sau đó thì 400 ngay lượt đầu, và người dùng không hiểu vì sao chỉ mình họ
  // bị.
  const opts = [
    { value: '9router:cx/gpt-5.6-sol(max)', label: 'Sol Max', provider: '9router', localOnly: false },
    { value: 'gemini:gemini-2.5-flash', label: 'Flash', provider: 'gemini', localOnly: false },
  ];

  it('model còn trong danh sách thì giữ', () => {
    expect(modelConDungDuoc('9router:cx/gpt-5.6-sol(max)', opts)).toBe(true);
  });

  it('model đã bị gỡ thì báo lỗi thời', () => {
    expect(modelConDungDuoc('9router:mmf/mimo-auto', opts)).toBe(false);
  });

  it('danh sách CHƯA TẢI thì giữ nguyên preference, không đá về mặc định', () => {
    // Coi "chưa biết" là "không hợp lệ" sẽ nháy đổi model mỗi lần mở panel.
    expect(modelConDungDuoc('9router:mmf/mimo-auto', undefined)).toBe(true);
  });

  it('danh sách RỖNG (không provider nào bật) thì coi là lỗi thời', () => {
    expect(modelConDungDuoc('9router:cx/gpt-5.6-sol(max)', [])).toBe(false);
  });
});

describe('hrefAnToan — link do MÔ HÌNH sinh, không phải link ta viết', () => {
  // Mô hình đọc dữ liệu nghiệp vụ (tên khách, ghi chú, tin Zalo). Một chuỗi do
  // người ngoài nhập đi trọn đường tới đây được, nên đây là biên giới tin cậy
  // chứ không phải chỗ định dạng cho đẹp.

  it('cho qua đường dẫn nội bộ và https', () => {
    expect(hrefAnToan('/invoices')).toBe('/invoices');
    expect(hrefAnToan('/customers/abc-123')).toBe('/customers/abc-123');
    expect(hrefAnToan('https://ptcrm.vercel.app/x')).toBe('https://ptcrm.vercel.app/x');
  });

  it('CHẶN javascript: kể cả khi né bằng hoa/thường và khoảng trắng', () => {
    for (const xau of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)  ',
      'jAvAsCrIpT:fetch("/api")',
    ]) {
      expect(hrefAnToan(xau)).toBeNull();
    }
  });

  it('CHẶN data:, vbscript:, file: và http trần', () => {
    expect(hrefAnToan('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(hrefAnToan('vbscript:msgbox(1)')).toBeNull();
    expect(hrefAnToan('file:///etc/passwd')).toBeNull();
    expect(hrefAnToan('http://ptcrm.vercel.app')).toBeNull(); // hạ cấp http → chặn
  });

  it('CHẶN URL giao thức-tương đối `//host` — trông như đường dẫn nội bộ nhưng ra ngoài', () => {
    expect(hrefAnToan('//evil.example/x')).toBeNull();
  });

  it('CHẶN chuỗi không phải URL (mô hình bịa) thay vì render mù', () => {
    expect(hrefAnToan('invoices')).toBeNull();
    expect(hrefAnToan('')).toBeNull();
  });
});
