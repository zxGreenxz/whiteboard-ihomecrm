// Test tích hợp engine broadcast: giả lập Supabase + phiên Zalo rồi chạy một
// lượt thật, xem nó XẾP GÌ vào hàng đợi.
//
// Vì sao cần dù đã có test cho bộ quyết định: bộ quyết định chỉ trả lời "gửi
// hay không, chế độ nào". Phần dễ sai nằm ở sau đó — giãn nhịp có thật sự vào
// `not_before` không, trần tin có chặn giữa chừng không, hội thoại của tài
// khoản đã rớt phiên có bị bỏ qua không. Đó đều là những thứ chỉ lộ ra khi
// chạy, và khi chạy thật thì hậu quả là tin gửi nhầm cho khách.
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ---------------------------------------------------------------- giả lập */

/** Bảng ghi lại mọi thứ engine chèn vào, để test soi. */
const daChen = { messages: [], queue: [], runs: [] };
let capNhatAutomations = [];
let duLieuAutomations = [];
let duLieuConversations = [];

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
      upload: () => Promise.resolve({ error: null }),
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
  docPhongTrong: () => Promise.resolve({ buildings: [{ id: 'b1', rooms: phongGia }], rooms: phongGia, hotline: '0900' }),
}));
vi.mock('../lib/room-list-image.js', () => ({
  veAnhDanhSach: () => Promise.resolve(Buffer.from('png-gia')),
}));
vi.mock('../lib/room-list-table.js', () => ({
  buildRoomListTable: () => ({ totalRooms: phongGia.length, groups: [], title: '', contactLines: [], infoLines: [] }),
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
  duLieuConversations = [conv('c1'), conv('c2')];
  phienDangSong.clear();
  phienDangSong.set('acc-1', { api: {}, ownId: 'own' });
  phongGia.length = 0;
  phongGia.push(phong('r1'), phong('r2'));
  vi.setSystemTime(THU_HAI_0830);
});

/* -------------------------------------------------------------------- test */

describe('engine broadcast — xếp hàng', () => {
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
