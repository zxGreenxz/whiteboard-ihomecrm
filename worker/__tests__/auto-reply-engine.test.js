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
let rpcCalls = [];
let rpcError = null;
let rpcResult = { status: 'queued', message_id: 'm1', job_id: 'j1' };

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
  return { data: don ? null : [], error: null, count: 0 };
}

const sbGia = {
  async rpc(name, args) {
    rpcCalls.push({ name, args });
    return { data: rpcResult, error: rpcError };
  },
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
let trangSale = 1;
vi.mock('../lib/vacant-rooms.js', () => ({
  docPhongTrong: () => Promise.resolve({ buildings: [], rooms: trangSale === 0 ? [] : phong, hotline: '0900', trangSale }),
}));

const { xuLyTinDen } = await import('../lib/auto-reply.js');

const hoiThoai = (over = {}) => ({
  id: 'c1', user_id: 'u1', organization_id: 'org-1', is_sale_partner: true, ...over,
});
const goi = (body, conv = hoiThoai()) => xuLyTinDen({ accountId: 'acc-1', conv, body, zaloMsgId: 'source-default' });

beforeEach(() => {
  daChen.messages = []; daChen.queue = []; daChen.runs = [];
  dongAutomation = { id: 'a1', enabled: true, config: {} };
  rpcCalls = []; rpcError = null;
  rpcResult = { status: 'queued', message_id: 'm1', job_id: 'j1' };
  trangSale = 1;
});

describe('auto-reply — nguồn phòng = trang Sale', () => {
  it('công ty chưa có link chia sẻ: KHÔNG khẳng định hết phòng, hỏi nhu cầu bằng câu trung tính', async () => {
    trangSale = 0;
    await goi('còn phòng không b');
    expect(rpcCalls).toHaveLength(1);
    const body = rpcCalls[0].args.p_body;
    expect(body).not.toContain('chưa có phòng trống');
    expect(body).toContain('để lại nhu cầu');
    expect(rpcCalls[0].args.p_detail).toMatchObject({ so_phong: null, khong_co_trang_sale: true });
  });
  it('có trang sale: vẫn gửi danh sách như cũ', async () => {
    await goi('còn phòng không b');
    expect(rpcCalls[0].args.p_body).toContain('P.402');
    expect(rpcCalls[0].args.p_detail).toMatchObject({ so_phong: 2 });
  });
});

describe('auto-reply — atomic enqueue contract', () => {
  it('uses the incoming provider ID as the atomic deduplication key', async () => {
    await xuLyTinDen({ accountId: 'acc-1', conv: hoiThoai(), body: 'còn phòng ko', zaloMsgId: 'source-1' });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({ name: 'zalo_enqueue_auto_reply_v1', args: { p_conversation_id: 'c1', p_source_zalo_msg_id: 'source-1' } });
    expect(daChen.messages).toHaveLength(0);
    expect(daChen.queue).toHaveLength(0);
  });
  it('never falls back to non-atomic writes when the RPC fails', async () => {
    rpcError = { message: 'database unavailable' };
    await xuLyTinDen({ accountId: 'acc-1', conv: hoiThoai(), body: 'còn phòng ko', zaloMsgId: 'source-2' });
    expect(rpcCalls).toHaveLength(1);
    expect(daChen.messages).toHaveLength(0);
    expect(daChen.queue).toHaveLength(0);
  });
  it('does not enqueue without a stable incoming ID', async () => {
    await xuLyTinDen({ accountId: 'acc-1', conv: hoiThoai(), body: 'còn phòng ko' });
    expect(rpcCalls).toHaveLength(0);
    expect(daChen.queue).toHaveLength(0);
  });
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

  it('CỬA 4: tôn trọng DB từ chối vì cooldown, không ghi thêm tin hoặc nhật ký thành công', async () => {
    rpcResult = { status: 'skipped', reason: 'Hội thoại còn trong thời gian chờ chống lặp' };
    await goi('còn phòng ko b');
    expect(rpcCalls).toHaveLength(1);
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs).toHaveLength(0);
  });

  it('CỬA 4: dùng một RPC để kiểm cooldown/cap cùng lúc xếp hàng', async () => {
    await goi('còn phòng ko b');
    expect(rpcCalls).toHaveLength(1);
    expect(daChen.queue).toHaveLength(0);
  });

  it('CỬA 4: tôn trọng DB từ chối vì trần ngày', async () => {
    rpcResult = { status: 'skipped', reason: 'Đã chạm trần trả lời tự động trong ngày' };
    await goi('còn phòng ko b');
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs).toHaveLength(0);
    expect(rpcCalls).toHaveLength(1);
  });

  it('QUA HẾT: truyền danh sách phòng sống và metadata vào RPC atomic', async () => {
    await goi('bên m còn phòng nào trống ko');
    expect(rpcCalls).toHaveLength(1);

    const than = rpcCalls[0].args.p_body;
    expect(than).toContain('TRỐNG NGAY');
    expect(than).toContain('P.402');
    expect(than).toContain('SẮP TRỐNG');
    expect(than).toContain('trống 5/9');
    expect(than).toContain('https://ptcrm.test/r/abc');   // link tổng lấy từ cấu hình broadcast

    // Delay/cooldown/cap/transaction được xác minh bằng DB behavior harness thật.
    expect(rpcCalls[0].args.p_detail).toMatchObject({ so_phong: 2 });
    expect(rpcCalls[0].args.p_detail.tu_khoa).toBeTruthy();
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
