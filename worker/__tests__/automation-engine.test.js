// Test tích hợp engine broadcast: giả lập Supabase + phiên Zalo rồi chạy một
// lượt thật, xem nó XẾP GÌ vào hàng đợi.
//
// Vì sao cần dù đã có test cho bộ quyết định: bộ quyết định chỉ trả lời "gửi
// hay không, chế độ nào". Phần dễ sai nằm ở sau đó — giãn nhịp có thật sự vào
// `not_before` không, trần tin có chặn giữa chừng không, hội thoại của tài
// khoản đã rớt phiên có bị bỏ qua không. Đó đều là những thứ chỉ lộ ra khi
// chạy, và khi chạy thật thì hậu quả là tin gửi nhầm cho khách.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ---------------------------------------------------------------- giả lập */

/** Bảng ghi lại mọi thứ engine chèn vào, để test soi. */
const daChen = { messages: [], queue: [], runs: [] };
let capNhatAutomations = [];
let duLieuAutomations = [];
let duLieuConversations = [];
let rpcError = null;
let rpcCalls = [];
let rpcFailureFor = () => null;
let uploadError = null;
let tableInputs = [];

/** Query builder giả — đủ chuỗi phương thức mà engine dùng, không hơn. */
function taoQuery(bang) {
  const ctx = { bang, loc: {} };
  const q = {
    select: () => q,
    eq: (c, v) => { ctx.loc[c] = v; return q; },
    in: () => q,
    order: () => q,
    limit: () => q,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => Promise.resolve({ data: null, error: null }),
    then: (res) => Promise.resolve(ketQua(ctx)).then(res),
  };
  return q;
}
function ketQua(ctx) {
  if (ctx.bang === 'zalo_automations') return { data: duLieuAutomations, error: null };
  if (ctx.bang === 'zalo_conversations') return { data: duLieuConversations, error: null };
  return { data: [], error: null };
}

const sbGia = {
  rpc: async (name, args) => {
    rpcCalls.push({ name, args });
    const failure = rpcError || rpcFailureFor(args);
    if (failure) return { data: null, error: failure };
    const id = `msg-${daChen.messages.length + 1}`;
    daChen.messages.push({ id, body: args.p_body });
    daChen.queue.push({ conversation_id: args.p_conversation_id, not_before: args.p_not_before,
      payload: args.p_attachment ? { type: 'image', attachments: Array.isArray(args.p_attachment) ? args.p_attachment : [args.p_attachment] } : { body: args.p_body } });
    return { data: { status: 'queued', message_id: id, job_id: `job-${id}` }, error: null };
  },
  from(bang) {
    if (bang === 'zalo_messages') {
      return {
        insert: (row) => ({
          select: () => ({
            single: () => {
              const id = `msg-${daChen.messages.length + 1}`;
              daChen.messages.push({ id, ...row });
              return Promise.resolve({ data: { id }, error: null });
            },
          }),
        }),
      };
    }
    if (bang === 'zalo_send_queue') {
      return { insert: (row) => { daChen.queue.push(row); return Promise.resolve({ error: null }); } };
    }
    if (bang === 'zalo_automation_runs') {
      return { insert: (row) => { daChen.runs.push(row); return Promise.resolve({ error: null }); } };
    }
    if (bang === 'zalo_automations') {
      const q = taoQuery(bang);
      q.update = (patch) => ({ eq: () => { capNhatAutomations.push(patch); return Promise.resolve({ error: null }); } });
      return q;
    }
    return taoQuery(bang);
  },
  storage: {
    from: () => ({
      upload: () => Promise.resolve({ error: uploadError }),
      getPublicUrl: (p) => ({ data: { publicUrl: `https://x.test/storage/v1/object/public/zalo-media/${p}` } }),
    }),
  },
};

const phienDangSong = new Map();

vi.mock('../lib/ctx.js', () => ({
  sb: sbGia,
  log: () => {},
  orgOf: () => 'org-1',
  sessions: phienDangSong,
  SUPABASE_URL: 'https://x.test',
}));

// Không gọi DB thật để lấy phòng, và không vẽ ảnh thật (chậm + cần font).
const phongGia = [];
vi.mock('../lib/vacant-rooms.js', () => ({
  docPhongTrong: () => Promise.resolve({ buildings: [{ id: 'b1', address: '12 Đường A, Phường B, Quận C', rooms: phongGia }], rooms: phongGia, hotline: '0900' }),
}));
vi.mock('../lib/room-list-image.js', () => ({
  veAnhDanhSach: () => Promise.resolve(Buffer.from('png-gia')),
}));
vi.mock('../lib/room-list-table.js', () => ({
  buildRoomListTable: buildings => { tableInputs.push(buildings); return { totalRooms: phongGia.length, groups: [], title: '', contactLines: [], infoLines: [] }; },
}));

const { tickTuDongHoa } = await import('../lib/automation.js');

/* ------------------------------------------------------------- dữ liệu nền */

const phong = (id, over = {}) => ({
  id, code: id, price: 4.5, status: 'free', availDate: null,
  buildingAddr: 'Địa chỉ', buildingName: 'Toà', area: 25, type: 'Studio',
  amenities: ['Máy lạnh'], images: [], description: null, saleNote: null, ...over,
});

const conv = (id, accountId = 'acc-1') => ({
  id, user_id: 'u1', organization_id: 'org-1', account_id: accountId,
  peer_name: `Hội thoại ${id}`, thread_type: 'group', is_sale_partner: true,
});

/** Thứ Hai 31/08/2026, 08:30 giờ VN — trùng giờ hẹn mặc định. */
const THU_HAI_0830 = new Date('2026-08-31T01:30:00Z');

function datCauHinh(over = {}, stats = {}) {
  duLieuAutomations = [{
    id: 'auto-1', organization_id: 'org-1', kind: 'broadcast_vacant', enabled: true,
    config: {
      recipients: ['c1', 'c2'],
      schedule: { time: '08:30', days: { mon: 'compact', tue: 'compact', wed: 'compact', thu: 'compact', fri: 'compact', sat: 'compact', sun: 'off' } },
      template: { blocks: ['link', 'table_image'], shareUrl: 'https://ptcrm.test/r/abc' },
      antiSpam: { gapBetweenRecipientsSec: 180, gapBetweenRoomMsgsSec: 20, dailyCap: 120, maxRoomsPerRun: 5 },
      ...over,
    },
    stats,
  }];
}

beforeEach(() => {
  daChen.messages = []; daChen.queue = []; daChen.runs = [];
  capNhatAutomations = [];
  rpcCalls = []; rpcError = null;
  rpcFailureFor = () => null;
  uploadError = null;
  tableInputs = [];
  duLieuConversations = [conv('c1'), conv('c2')];
  phienDangSong.clear();
  phienDangSong.set('acc-1', { api: {}, ownId: 'own' });
  phongGia.length = 0;
  phongGia.push(phong('r1'), phong('r2'));
  vi.setSystemTime(THU_HAI_0830);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/* -------------------------------------------------------------------- test */

describe('engine broadcast — xếp hàng', () => {
  it('sends every room photo, then information and separator, then the next room; empty rooms explicitly await photos', async () => {
    vi.stubEnv('R2_PUBLIC_BASE', 'https://images.example.test');
    const bytes = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
    bytes.writeUInt32BE(640,16); bytes.writeUInt32BE(480,20);
    const request = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', request);
    phongGia[0].images = ['https://images.example.test/room-sale-images/u/one.jpg', 'https://images.example.test/room-sale-images/u/two.jpg'];
    datCauHinh({ schedule: { time: '08:30', days: { mon: 'full' } }, template: { blocks: ['room_details'] } });
    await tickTuDongHoa();
    const rooms = rpcCalls.map(c => c.args);
    expect(rooms).toHaveLength(6); // (one complete album + information + empty room) × 2 recipients
    expect(request).toHaveBeenCalledTimes(2); // all photos reused for this organization's recipients
    expect(rooms[0].p_request_key).toBe('scheduled:2026-08-31:c1:room:r1:album');
    expect(rooms[0].p_attachment).toHaveLength(2);
    expect(rooms[0].p_attachment.every(a => a.bucket === 'zalo-media' && a.width === 640 && a.height === 480)).toBe(true);
    expect(rooms[0].p_body).toBe('');
    expect(new Set(rooms.map(r => r.p_request_key)).size).toBe(6);
    expect(rooms[1]).toMatchObject({ p_request_key: 'scheduled:2026-08-31:c1:room:r1', p_attachment: null });
    expect(rooms[1].p_body).toContain('PHÒNG r1');
    expect(rooms[1].p_body).not.toContain('Chờ cập nhật ảnh');
    expect(rooms[2].p_attachment).toBeNull();
    expect(rooms[2].p_body).toContain('PHÒNG r2');
    expect(rooms[2].p_body).toContain('\nChờ cập nhật ảnh\n');
    expect(rooms.filter(r => !r.p_attachment).every(r => r.p_body.endsWith('\n────────────────'))).toBe(true);
    expect(rooms.slice(0, 3).map(r => (Date.parse(r.p_not_before) - THU_HAI_0830.getTime()) / 1000)).toEqual([0, 20, 40]);
    expect(daChen.runs[0]).toMatchObject({ mode: 'full', messages_count: 6 });
    const first = rooms.filter(r => r.p_attachment).map(r => r.p_request_key);
    rpcCalls = []; phongGia[0].images.reverse();
    await tickTuDongHoa();
    expect(rpcCalls.filter(c => c.args.p_attachment).map(c => c.args.p_request_key)).toEqual(first);
  });
  it('marks a partial run when an existing room photo fails, instead of sending a misleading text-only room', async () => {
    vi.stubEnv('R2_PUBLIC_BASE', 'https://images.example.test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    phongGia[0].images = ['https://images.example.test/room-sale-images/u/one.jpg'];
    datCauHinh({ schedule: { time: '08:30', days: { mon: 'full' } }, template: { blocks: ['room_details'] } });
    await tickTuDongHoa();
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls.every(c => c.args.p_request_key.endsWith(':room:r2'))).toBe(true);
    expect(daChen.runs[0]).toMatchObject({ mode: 'failed', messages_count: 2, detail: { partial: true, khong_xep_duoc: 4 } });
  });
  it.each(['quota', 'window'])('does not start a photographed room that cannot fit wholly within the %s', async boundary => {
    vi.stubEnv('R2_PUBLIC_BASE', 'https://images.example.test');
    const bytes = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
    bytes.writeUInt32BE(640,16); bytes.writeUInt32BE(480,20);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    phongGia.splice(1); phongGia[0].images = ['https://images.example.test/room-sale-images/u/one.jpg'];
    duLieuConversations = [conv('c1')];
    if (boundary === 'window') vi.setSystemTime(new Date('2026-08-31T13:00:50Z'));
    datCauHinh({ schedule: { time: boundary === 'window' ? '20:00' : '08:30', days: { mon: 'full' } }, template: { blocks: ['room_details'] } },
      boundary === 'quota' ? { sentDate: '2026-08-31', sentToday: 119 } : {});
    await tickTuDongHoa();
    expect(rpcCalls).toHaveLength(0);
    expect(daChen.runs[0]).toMatchObject({ mode: 'failed', messages_count: 0 });
    expect(daChen.runs[0].detail[boundary === 'quota' ? 'bo_qua_tran' : 'bo_qua_khung_gio']).toBe(2);
  });
  it.each(['download', 'enqueue'])('does not claim complete room information after a later photo %s fails', async failure => {
    vi.stubEnv('R2_PUBLIC_BASE', 'https://images.example.test');
    const bytes = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
    bytes.writeUInt32BE(640,16); bytes.writeUInt32BE(480,20);
    vi.stubGlobal('fetch', vi.fn(async url => failure === 'download' && url.includes('two')
      ? new Response(null, { status: 404 }) : new Response(bytes)));
    phongGia[0].images = ['https://images.example.test/room-sale-images/u/one.jpg', 'https://images.example.test/room-sale-images/u/two.jpg'];
    duLieuConversations = [conv('c1')];
    if (failure === 'enqueue') rpcFailureFor = args => args.p_attachment ? { message: 'unavailable' } : null;
    datCauHinh({ schedule: { time: '08:30', days: { mon: 'full' } }, template: { blocks: ['room_details'] } });
    await tickTuDongHoa();
    expect(rpcCalls.some(c => c.args.p_request_key.endsWith(':room:r1'))).toBe(false);
    expect(rpcCalls.at(-1).args.p_request_key).toBe('scheduled:2026-08-31:c1:room:r2');
    expect(daChen.runs[0]).toMatchObject({ mode: 'failed', detail: { partial: true,
      khong_xep_duoc: 2, bo_qua_tran: 0 } });
  });
  it('shortens addresses before rendering the outgoing table without changing the room data', async () => {
    datCauHinh(); await tickTuDongHoa();
    expect(tableInputs[0][0].address).toBe('12 Đường A');
  });
  it('enqueues atomically with stable keys if the schedule state was not saved', async () => {
    datCauHinh();
    await tickTuDongHoa();
    const first = rpcCalls.map(call => call.args.p_request_key);
    expect(rpcCalls.every(call => call.name === 'zalo_enqueue_broadcast_v1')).toBe(true);
    expect(new Set(first).size).toBe(4);
    rpcCalls = [];
    // Same schedule/stats after a lost response or worker restart.
    await tickTuDongHoa();
    expect(rpcCalls.map(call => call.args.p_request_key)).toEqual(first);
  });

  it('reports enqueue failure without leaving an orphan pending message', async () => {
    datCauHinh(); rpcError = { message: 'database unavailable' };
    await tickTuDongHoa();
    expect(daChen.messages).toHaveLength(0);
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs[0].detail.khong_xep_duoc).toBe(4);
    expect(daChen.runs[0].mode).toBe('failed');
    expect(capNhatAutomations).toHaveLength(0);
    // The next tick still owns the same unfinished logical run.
    const firstKeys = rpcCalls.map(call => call.args.p_request_key);
    rpcError = null; rpcCalls = [];
    await tickTuDongHoa();
    expect(rpcCalls.map(call => call.args.p_request_key)).toEqual(firstKeys);
    expect(daChen.queue).toHaveLength(4);
    expect(capNhatAutomations.at(-1).stats.lastScheduledDate).toBe('2026-08-31');
  });

  it('keeps room and block idempotency keys stable when their display order changes', async () => {
    datCauHinh({ schedule: { time: '08:30', days: { mon: 'full' } },
      template: { blocks: ['link', 'room_details', 'table_image'], shareUrl: 'https://ptcrm.test/r/abc' } });
    await tickTuDongHoa();
    const keysByContent = () => Object.fromEntries(rpcCalls.map(({ args }) => [
      `${args.p_conversation_id}:${args.p_attachment ? 'table_image' : args.p_body}`, args.p_request_key,
    ]));
    const first = keysByContent();
    rpcCalls = []; phongGia.reverse();
    duLieuAutomations[0].config.template.blocks = ['table_image', 'room_details', 'link'];
    await tickTuDongHoa();
    expect(keysByContent()).toEqual(first);
  });

  it('reports a partially queued run explicitly and does not retry it implicitly', async () => {
    datCauHinh();
    rpcFailureFor = args => args.p_conversation_id === 'c2' ? { message: 'lost response' } : null;
    await tickTuDongHoa();
    expect(daChen.queue).toHaveLength(2);
    expect(daChen.runs[0]).toMatchObject({ mode: 'failed', messages_count: 2,
      detail: { partial: true, khong_xep_duoc: 2 } });
    expect(daChen.runs[0].reason).toMatch(/một phần/);
    // Mirror the successful stats save, then verify the schedule is closed.
    duLieuAutomations[0].stats = capNhatAutomations.at(-1).stats;
    rpcCalls = []; rpcFailureFor = () => null;
    await tickTuDongHoa();
    expect(rpcCalls).toHaveLength(0);
  });

  it('keeps an all-failed supplemental room event pending until enqueue succeeds', async () => {
    const previous = { lastScheduledDate: '2026-08-31', knownRoomIds: ['r1'],
      pendingSince: '2026-08-31T01:00:00Z', sentDate: '2026-08-31', sentToday: 4 };
    datCauHinh({ template: { blocks: ['room_details'] }, eventDriven: { enabled: true, debounceMinutes: 5 } }, previous);
    rpcError = { message: 'database unavailable' };
    await tickTuDongHoa();
    const firstKeys = rpcCalls.map(call => call.args.p_request_key);
    expect(capNhatAutomations).toHaveLength(0);
    expect(duLieuAutomations[0].stats).toEqual(previous);
    expect(daChen.runs[0]).toMatchObject({ mode: 'failed', detail: { retry_pending: true } });
    rpcError = null; rpcCalls = [];
    await tickTuDongHoa();
    expect(rpcCalls.map(call => call.args.p_request_key)).toEqual(firstKeys);
    expect(capNhatAutomations.at(-1).stats).toMatchObject({ knownRoomIds: ['r1', 'r2'], pendingSince: null, sentToday: 6 });
  });

  it('does not finish an image-only run when the table image failed to upload', async () => {
    datCauHinh({ template: { blocks: ['table_image'] } });
    uploadError = { message: 'storage unavailable' };
    await tickTuDongHoa();
    expect(rpcCalls).toHaveLength(0);
    expect(capNhatAutomations).toHaveLength(0);
    expect(daChen.runs[0]).toMatchObject({ mode: 'failed', detail: { retry_pending: true, khong_xep_duoc: 2 } });
  });

  it('không xếp người nhận sau giờ đóng cửa dù lượt bắt đầu còn trong giờ', async () => {
    vi.setSystemTime(new Date('2026-08-31T12:59:00Z'));
    datCauHinh({
      schedule: { time: '19:59', days: { mon: 'compact' } },
      template: { blocks: ['link'], shareUrl: 'https://ptcrm.test/r/abc' },
      antiSpam: { allowedHours: { from: '08:00', to: '20:00' }, gapBetweenRecipientsSec: 180 },
    });
    await tickTuDongHoa();
    expect(daChen.queue.map(j => j.conversation_id)).toEqual(['c1']);
    expect(daChen.runs[0].detail.bo_qua_khung_gio).toBe(1);
  });

  it('không trừ quota hôm nay cho tin hẹn sang ngày mai trong khung xuyên đêm', async () => {
    vi.setSystemTime(new Date('2026-08-31T16:59:00Z'));
    datCauHinh({
      schedule: { time: '23:59', days: { mon: 'compact' } },
      template: { blocks: ['link'], shareUrl: 'https://ptcrm.test/r/abc' },
      antiSpam: { allowedHours: { from: '20:00', to: '08:00' }, gapBetweenRecipientsSec: 180 },
    });
    await tickTuDongHoa();
    expect(daChen.queue.map(j => j.conversation_id)).toEqual(['c1']);
    expect(capNhatAutomations.at(-1).stats.sentToday).toBe(1);
  });

  it('xếp đủ 2 khối × 2 người nhận và ghi nhật ký', async () => {
    datCauHinh();
    await tickTuDongHoa();

    expect(daChen.queue).toHaveLength(4);          // (link + ảnh) × 2 người
    expect(daChen.messages).toHaveLength(4);
    expect(daChen.runs).toHaveLength(1);
    expect(daChen.runs[0]).toMatchObject({ kind: 'broadcast_vacant', mode: 'compact', recipients_count: 2, messages_count: 4 });
  });

  it('GIÃN NHỊP thật sự nằm trong not_before, không phải chỉ trong log', async () => {
    datCauHinh();
    await tickTuDongHoa();

    const moc = daChen.queue.map((j) => Date.parse(j.not_before)).sort((a, b) => a - b);
    const dau = moc[0];
    const lech = moc.map((t) => Math.round((t - dau) / 1000));
    // Người 1: 0s và 20s (giãn giữa tin). Người 2: 180s và 200s (giãn giữa người).
    expect(lech).toEqual([0, 20, 180, 200]);
  });

  it('TRẦN NGÀY chặn giữa chừng, không xếp quá phần còn lại', async () => {
    datCauHinh({}, { sentDate: '2026-08-31', sentToday: 118 });   // trần 120 → còn 2
    await tickTuDongHoa();
    expect(daChen.queue).toHaveLength(2);
    expect(daChen.runs[0].messages_count).toBe(2);
  });

  it('đã chạm trần thì bỏ lượt và NÓI RÕ lý do', async () => {
    datCauHinh({}, { sentDate: '2026-08-31', sentToday: 120 });
    await tickTuDongHoa();
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs[0].mode).toBe('skipped');
    expect(daChen.runs[0].reason).toContain('trần');
  });

  it('NGOÀI KHUNG GIỜ thì không gửi', async () => {
    // 22:00 giờ VN, lịch hẹn 22:00 để qua được cửa "tới giờ" — cửa khung giờ mới là cửa chặn.
    vi.setSystemTime(new Date('2026-08-31T15:00:00Z'));
    datCauHinh({ schedule: { time: '22:00', days: { mon: 'compact', tue: 'compact', wed: 'compact', thu: 'compact', fri: 'compact', sat: 'compact', sun: 'off' } } });
    await tickTuDongHoa();
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs[0].mode).toBe('skipped');
    expect(daChen.runs[0].reason).toContain('Ngoài khung giờ');
  });

  it('BỎ QUA hội thoại của tài khoản đã rớt phiên', async () => {
    duLieuConversations = [conv('c1', 'acc-1'), conv('c2', 'acc-DA-ROT')];
    datCauHinh();
    await tickTuDongHoa();
    // Chỉ c1 được xếp: xếp cho tài khoản không có phiên chỉ tạo ra job failed
    // và một khung chat đầy tin đỏ.
    expect(daChen.queue).toHaveLength(2);
    expect(new Set(daChen.queue.map((j) => j.conversation_id))).toEqual(new Set(['c1']));
  });

  it('KHÔNG gửi bảng rỗng khi hết phòng', async () => {
    phongGia.length = 0;
    datCauHinh();
    await tickTuDongHoa();
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs[0].reason).toContain('bảng rỗng');
  });

  it('chế độ ĐẦY ĐỦ xếp thêm tin chi tiết từng phòng', async () => {
    datCauHinh({
      schedule: { time: '08:30', days: { mon: 'full', tue: 'full', wed: 'full', thu: 'full', fri: 'full', sat: 'full', sun: 'off' } },
      template: { blocks: ['link', 'table_image', 'room_details'], shareUrl: '' },
    });
    await tickTuDongHoa();
    // (link + ảnh + 2 phòng) × 2 người = 8
    expect(daChen.queue).toHaveLength(8);
    expect(daChen.runs[0].mode).toBe('full');
  });

  it('ĐÓNG SỔ ngày ngay cả khi bỏ lượt — không xét lại mỗi phút', async () => {
    datCauHinh({}, { lastRoomsHash: 'khac', knownRoomIds: ['r1', 'r2'] });
    await tickTuDongHoa();
    const so = capNhatAutomations.at(-1)?.stats;
    expect(so.lastScheduledDate).toBe('2026-08-31');
    expect(so.sentToday).toBe(4);
  });

  it('automation TẮT thì không đụng gì', async () => {
    datCauHinh();
    duLieuAutomations = [];      // engine lọc enabled=true ở tầng query
    await tickTuDongHoa();
    expect(daChen.queue).toHaveLength(0);
    expect(daChen.runs).toHaveLength(0);
  });
});
