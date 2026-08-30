// Test tích hợp auto-reply: bốn cửa an toàn có thật sự chặn không.
//
// Đây là phần nguy hiểm nhất của cả tính năng — nó gửi tin ra ngoài mà không ai
// bấm nút. Mỗi test dưới đây tương ứng một cách nó có thể gây hại:
//   • trả lời nhầm người (chưa đánh dấu Sale)
//   • trả lời về tiền/hợp đồng (chuyện pháp lý, phải để người thật)
//   • trả lời lặp (spam vào mặt một người vừa được trả lời)
//   • vượt trần ngày (dấu hiệu bot → khoá nick)
import { describe, it, expect, vi, beforeEach } from 'vitest';

const daChen = { messages: [], queue: [], runs: [] };
let dongAutomation = { id: 'a1', enabled: true, config: {} };
let dongBroadcast = { config: { template: { shareUrl: 'https://ptcrm.test/r/abc' } } };
let lanTraLoiCuoi = null;      // ISO string hoặc null
let soDaTraLoiHomNay = 0;

function bang(ten) {
  const ctx = { ten, loc: {} };
  const q = {
    select: (_c, opt) => { ctx.head = !!opt?.head; return q; },
    eq: (c, v) => { ctx.loc[c] = v; return q; },
    gte: () => q,
    order: () => q,
    limit: () => q,
    maybeSingle: () => Promise.resolve(traVe(ctx, true)),
    single: () => Promise.resolve(traVe(ctx, true)),
    then: (res) => Promise.resolve(traVe(ctx, false)).then(res),
  };
  return q;
}
function traVe(ctx, don) {
  if (ctx.ten === 'zalo_automations') {
    const kind = ctx.loc.kind;
    const d = kind === 'auto_reply' ? dongAutomation : dongBroadcast;
    return { data: don ? d : [d], error: null };
  }
  if (ctx.ten === 'zalo_automation_runs') {
    if (ctx.head) return { count: soDaTraLoiHomNay, error: null };
    const d = lanTraLoiCuoi ? { created_at: lanTraLoiCuoi } : null;
    return { data: don ? d : (d ? [d] : []), count: soDaTraLoiHomNay, error: null };
  }
  return { data: don ? null : [], error: null, count: 0 };
}

const sbGia = {
  from(ten) {
    if (ten === 'zalo_messages') {
      return { insert: (row) => ({ select: () => ({ single: () => {
        const id = `m${daChen.messages.length + 1}`;
        daChen.messages.push({ id, ...row });
        return Promise.resolve({ data: { id }, error: null });
      } }) }) };
    }
    if (ten === 'zalo_send_queue') {
      return { insert: (row) => { daChen.queue.push(row); return Promise.resolve({ error: null }); } };
    }
    if (ten === 'zalo_automation_runs') {
      const q = bang(ten);
      q.insert = (row) => { daChen.runs.push(row); return Promise.resolve({ error: null }); };
      return q;
    }
    return bang(ten);
  },
};

vi.mock('../lib/ctx.js', () => ({
  sb: sbGia, log: () => {}, orgOf: () => 'org-1', sessions: new Map(), SUPABASE_URL: 'https://x.test',
}));
const phong = [
  { id: 'r1', code: '402', price: 4.5, status: 'free', area: 25, type: 'Studio', buildingAddr: '102 LVT', buildingName: 'T1', availDate: null },
  { id: 'r2', code: '305', price: 3.9, status: 'soon', area: 20, type: 'Gác', buildingAddr: '102 LVT', buildingName: 'T1', availDate: '5/9' },
];
vi.mock('../lib/vacant-rooms.js', () => ({
  docPhongTrong: () => Promise.resolve({ buildings: [], rooms: phong, hotline: '0900' }),
}));

const { xuLyTinDen } = await import('../lib/auto-reply.js');

const hoiThoai = (over = {}) => ({
  id: 'c1', user_id: 'u1', organization_id: 'org-1', is_sale_partner: true, ...over,
});
const goi = (body, conv = hoiThoai()) => xuLyTinDen({ accountId: 'acc-1', conv, body });

beforeEach(() => {
  daChen.messages = []; daChen.queue = []; daChen.runs = [];
  dongAutomation = { id: 'a1', enabled: true, config: {} };
  lanTraLoiCuoi = null;
  soDaTraLoiHomNay = 0;
});

describe('auto-reply — bốn cửa an toàn', () => {
  it('CỬA 1: hội thoại chưa đánh dấu Sale thì im lặng tuyệt đối', async () => {
    await goi('còn phòng ko b', hoiThoai({ is_sale_partner: false }));
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs).toHaveLength(0);   // không ghi sổ: đây là luồng bình thường, không phải sự kiện
  });

  it('CỬA 2: tin nhắc tiền/cọc thì KHÔNG trả lời, và có ghi sổ lý do', async () => {
    await goi('cho mình chuyển khoản cọc phòng nhé');
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs).toHaveLength(1);
    expect(daChen.runs[0].mode).toBe('skipped');
    expect(daChen.runs[0].reason).toContain('người thật');
  });

  it('CỬA 2 THẮNG CỬA 3: tin vừa khớp từ khoá vừa chạm từ chặn → im lặng', async () => {
    // "còn phòng nào cho cọc trước không" khớp cả 'phòng' lẫn 'cọc'.
    await goi('còn phòng nào cho cọc trước không b');
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs[0].mode).toBe('skipped');
  });

  it('CỬA 3: không khớp từ khoá nào thì im lặng, không ghi sổ', async () => {
    await goi('hello bạn ơi khoẻ không');
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs).toHaveLength(0);
  });

  it('CỬA 4: còn trong cooldown thì im lặng và nói rõ còn bao lâu', async () => {
    lanTraLoiCuoi = new Date(Date.now() - 5 * 60_000).toISOString();   // 5 phút trước, cooldown 30
    await goi('còn phòng ko b');
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs[0].reason).toMatch(/im lặng thêm \d+ phút/);
  });

  it('CỬA 4: hết cooldown thì trả lời lại', async () => {
    lanTraLoiCuoi = new Date(Date.now() - 60 * 60_000).toISOString();  // 1 giờ trước
    await goi('còn phòng ko b');
    expect(daChen.queue).toHaveLength(1);
  });

  it('CỬA 4: chạm trần ngày thì dừng', async () => {
    soDaTraLoiHomNay = 50;   // dailyCap mặc định 50
    await goi('còn phòng ko b');
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs[0].reason).toContain('trần');
  });

  it('QUA HẾT: gửi danh sách phòng sống, có trễ tự nhiên, ghi sổ đủ', async () => {
    await goi('bên m còn phòng nào trống ko');
    expect(daChen.queue).toHaveLength(1);
    expect(daChen.messages).toHaveLength(1);

    const than = daChen.messages[0].body;
    expect(than).toContain('TRỐNG NGAY');
    expect(than).toContain('P.402');
    expect(than).toContain('SẮP TRỐNG');
    expect(than).toContain('trống 5/9');
    expect(than).toContain('https://ptcrm.test/r/abc');   // link tổng lấy từ cấu hình broadcast

    // Trả lời tức thì trong 0 giây là dấu hiệu bot rõ nhất.
    const tre = Date.parse(daChen.queue[0].not_before) - Date.now();
    expect(tre).toBeGreaterThan(3000);

    expect(daChen.runs[0]).toMatchObject({ mode: 'reply', messages_count: 1, conversation_id: 'c1' });
    expect(daChen.runs[0].detail.tu_khoa).toBeTruthy();
  });

  it('automation TẮT thì không trả lời', async () => {
    dongAutomation = { id: 'a1', enabled: false, config: {} };
    await goi('còn phòng ko b');
    expect(daChen.queue).toHaveLength(0);
  });

  it('tin quá ngắn thì bỏ qua', async () => {
    await goi('ok');
    expect(daChen.queue).toHaveLength(0);
  });

  it('người dùng xoá sạch danh sách CHẶN thì mặc định được khôi phục', async () => {
    // Xoá hết từ chặn không có nghĩa là "cho phép máy tự trả lời về cọc".
    dongAutomation = { id: 'a1', enabled: true, config: { blockedKeywords: [] } };
    await goi('cho mình gửi cọc giữ phòng');
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs[0].mode).toBe('skipped');
  });
});
