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
let hermesCalls = [];
let hermesDue = [];
let hermesDueError = null;
let hermesRun = () => ({ data: { status: 'already_run' }, error: null });
const SWEEP_OK = () => ({ data: { prunedCommands: 0, expiredJobs: 0, observed: 0, closed: 0, expiry: 0, notified: 0, probes: [] }, error: null });
let hermesSweep = SWEEP_OK;
let hermesProbe = () => ({ data: { status: 'healthy' }, error: null });
let workerLogs = [];
let rpcFailureFor = () => null;
let uploadError = null;
let tableInputs = [];
let oneshotClaims = [];
let oneshotCalls = [];
let oneshotClaimError = null;
let locCapNhat = [];
let finishResult = null;

/** Query builder giả — đủ chuỗi phương thức mà engine dùng, không hơn. */
function taoQuery(bang) {
  const ctx = { bang, loc: {} };
  const q = {
    select: () => q,
    eq: (c, v) => { ctx.loc[c] = v; return q; },
    in: () => q,
    order: () => q,
    limit: () => q,
    maybeSingle: () => Promise.resolve({ data: bang === 'zalo_automations' ? structuredClone(duLieuAutomations[0] ?? null) : null, error: null }),
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
    if (name === 'hermes_room_schedule_due_v1') {
      expect(Object.keys(args).sort()).toEqual(['p_instance_id', 'p_organization_ids']);
      expect(args.p_instance_id).toBe(INSTANCE_ID);
      expect(Array.isArray(args.p_organization_ids)).toBe(true);
      hermesCalls.push({ name, args });
      return { data: structuredClone(hermesDue), error: hermesDueError };
    }
    if (name === 'hermes_room_schedule_run_v2' || name === 'hermes_room_schedule_run_v1') {
      expect(Object.keys(args).sort()).toEqual(['p_expected_revision', 'p_instance_id', 'p_schedule_id']);
      expect(args.p_instance_id).toBe(INSTANCE_ID);
      hermesCalls.push({ name, args });
      return hermesRun(args, name);
    }
    if (name === 'hermes_room_schedule_sweep_v1') {
      expect(Object.keys(args).sort()).toEqual(['p_instance_id', 'p_organization_ids']);
      expect(args.p_instance_id).toBe(INSTANCE_ID);
      hermesCalls.push({ name, args });
      return hermesSweep(args);
    }
    if (name === 'hermes_room_schedule_probe_v1') {
      expect(Object.keys(args).sort()).toEqual(['p_instance_id', 'p_schedule_id']);
      hermesCalls.push({ name, args });
      return hermesProbe(args);
    }
    if (name === 'zalo_worker_claim_oneshot_v1') {
      expect(Object.keys(args).sort()).toEqual(['p_instance_id', 'p_organization_ids']);
      expect(args.p_instance_id).toBe(INSTANCE_ID);
      oneshotCalls.push({ name, args });
      if (oneshotClaimError) return { data: null, error: oneshotClaimError };
      return { data: structuredClone(oneshotClaims.shift() ?? { status: 'none' }), error: null };
    }
    if (name === 'zalo_worker_finish_oneshot_v1') {
      expect(Object.keys(args).sort()).toEqual(['p_instance_id', 'p_ok', 'p_oneshot_id', 'p_result']);
      expect(args.p_instance_id).toBe(INSTANCE_ID);
      oneshotCalls.push({ name, args });
      return { data: finishResult ?? { ok: true, status: args.p_ok ? 'done' : 'failed' }, error: null };
    }
    if (name === 'zalo_enqueue_broadcast_oneshot_v2') {
      expect(Object.keys(args).sort()).toEqual(['p_attachment', 'p_body', 'p_content_guard', 'p_conversation_id', 'p_instance_id',
        'p_not_before', 'p_oneshot_id', 'p_request_key']);
      expect(args.p_instance_id).toBe(INSTANCE_ID);
    } else if (name !== 'zalo_enqueue_broadcast_v2') throw new Error(`unexpected_fixture_rpc:${name}`);
    expect(args.p_content_guard).toMatchObject({ version: 1, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    // Legacy assertions observe only its exact enqueue boundary. Hermes due
    // reads and runs have their own strict contract and never fabricate a send.
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
      q.update = (patch) => {
        const loc = [];
        const u = { eq: (c, v) => { loc.push([c, v]); return u; },
          then: (res, rej) => { capNhatAutomations.push(patch); locCapNhat.push(loc); return Promise.resolve({ error: null }).then(res, rej); } };
        return u;
      };
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
  log: (...args) => { workerLogs.push(args); },
  orgOf: () => 'org-1',
  sessions: phienDangSong,
  SUPABASE_URL: 'https://x.test',
}));

// Không gọi DB thật để lấy phòng, và không vẽ ảnh thật (chậm + cần font).
const phongGia = [];
let trangSaleGia = 1;
vi.mock('../lib/vacant-rooms.js', () => ({
  docPhongTrong: () => Promise.resolve({ buildings: [{ id: 'b1', address: '12 Đường A, Phường B, Quận C', rooms: phongGia }], rooms: phongGia, hotline: '0900', trangSale: trangSaleGia }),
}));
vi.mock('../lib/room-list-image.js', () => ({
  veAnhDanhSach: () => Promise.resolve(Buffer.from('png-gia')),
}));
vi.mock('../lib/room-list-table.js', () => ({
  buildRoomListTable: buildings => { tableInputs.push(buildings); return { totalRooms: phongGia.length, groups: [], title: '', contactLines: [], infoLines: [] }; },
}));

const { tickTuDongHoa } = await import('../lib/automation.js');
const { INSTANCE_ID } = await import('../lib/lease.js');

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
  hermesCalls = []; hermesDue = []; hermesDueError = null;
  hermesRun = () => ({ data: { status: 'already_run' }, error: null });
  hermesSweep = SWEEP_OK; hermesProbe = () => ({ data: { status: 'healthy' }, error: null });
  workerLogs = [];
  rpcFailureFor = () => null;
  uploadError = null;
  tableInputs = [];
  oneshotClaims = []; oneshotCalls = []; oneshotClaimError = null; trangSaleGia = 1; locCapNhat = []; finishResult = null;
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
  it('polls the exact Hermes due RPC once through the real tick without inventing a queued message', async () => {
    duLieuAutomations = [];
    await tickTuDongHoa(['org-1']);
    expect(hermesCalls).toEqual([{ name: 'hermes_room_schedule_due_v1', args: {
      p_instance_id: INSTANCE_ID, p_organization_ids: ['org-1'],
    } }, { name: 'hermes_room_schedule_sweep_v1', args: { p_instance_id: INSTANCE_ID, p_organization_ids: ['org-1'] } }]);
    expect(rpcCalls).toEqual([]);
    expect(daChen).toEqual({ messages: [], queue: [], runs: [] });
    await expect(sbGia.rpc('unexpected_rpc', {})).rejects.toThrow('unexpected_fixture_rpc');
    expect(daChen).toEqual({ messages: [], queue: [], runs: [] });
  });

  it('runs each Hermes candidate once with its revision and does not retry an unknown run while legacy still executes', async () => {
    datCauHinh();
    hermesDue = [{ scheduleId: 'schedule-a', revision: 2 }, { scheduleId: 'schedule-b', revision: 7 }];
    hermesRun = args => args.p_schedule_id === 'schedule-a'
      ? { data: null, error: { code: 'network_ack_lost' } }
      : { data: { status: 'already_run' }, error: null };
    await tickTuDongHoa(['org-1']);
    expect(hermesCalls).toEqual([
      { name: 'hermes_room_schedule_due_v1', args: { p_instance_id: INSTANCE_ID, p_organization_ids: ['org-1'] } },
      ...hermesDue.map(row => ({ name: 'hermes_room_schedule_run_v2', args: {
        p_schedule_id: row.scheduleId, p_expected_revision: row.revision, p_instance_id: INSTANCE_ID,
      } })),
      { name: 'hermes_room_schedule_sweep_v1', args: { p_instance_id: INSTANCE_ID, p_organization_ids: ['org-1'] } },
    ]);
    expect(workerLogs).toContainEqual(['hermes schedule run rejected', 'schedule-a', 'network_ack_lost']);
    expect(rpcCalls).toHaveLength(4);
    expect(rpcCalls.every(call => call.name === 'zalo_enqueue_broadcast_v2')).toBe(true);
    expect(daChen.queue).toHaveLength(4);
  });

  it('a failed or malformed Hermes due read dispatches no runs and leaves legacy scheduling available', async () => {
    for (const invalid of ['failed', 'malformed']) {
      datCauHinh(); hermesCalls = []; rpcCalls = []; daChen.queue = []; daChen.messages = [];
      hermesDueError = invalid === 'failed' ? { code: '42501' } : null;
      hermesDue = invalid === 'malformed' ? [{ scheduleId: 'schedule-a', revision: 0 }] : [];
      await tickTuDongHoa();
      expect(hermesCalls.map(call => call.name)).toEqual(['hermes_room_schedule_due_v1', 'hermes_room_schedule_sweep_v1']);
      expect(workerLogs.at(-1)[0]).toBe('hermes schedule tick unverified');
      expect(daChen.queue).toHaveLength(4);
      expect(rpcCalls).toHaveLength(4);
    }
  });

  it('records a blocked run, falls back to run_v1 only when run_v2 is not deployed, and probes sweep candidates once', async () => {
    datCauHinh();
    const PROBE = '12345678-1234-4123-8123-123456789abc';
    hermesDue = [{ scheduleId: 'schedule-a', revision: 2 }, { scheduleId: 'schedule-b', revision: 7 }];
    hermesRun = (args, name) => args.p_schedule_id === 'schedule-a'
      ? { data: { status: 'blocked', reason: 'user_permission_revoked' }, error: null }
      : name === 'hermes_room_schedule_run_v2' ? { data: null, error: { code: 'PGRST202' } } : { data: { status: 'already_run' }, error: null };
    hermesSweep = () => ({ data: { ...SWEEP_OK().data, notified: 1, probes: [PROBE] }, error: null });
    hermesProbe = () => ({ data: { status: 'blocked', reason: 'scope_narrowed' }, error: null });
    await tickTuDongHoa(['org-1']);
    expect(hermesCalls.map(call => [call.name, call.args.p_schedule_id ?? null])).toEqual([
      ['hermes_room_schedule_due_v1', null], ['hermes_room_schedule_run_v2', 'schedule-a'],
      ['hermes_room_schedule_run_v2', 'schedule-b'], ['hermes_room_schedule_run_v1', 'schedule-b'],
      ['hermes_room_schedule_sweep_v1', null], ['hermes_room_schedule_probe_v1', PROBE],
    ]);
    expect(workerLogs).toContainEqual(['hermes schedule blocked', 'schedule-a', 'user_permission_revoked']);
    expect(rpcCalls).toHaveLength(4);
  });

  it('a failed or malformed sweep is logged and neither retries runs nor blocks legacy scheduling', async () => {
    for (const sweep of [() => ({ data: null, error: { code: '42501' } }), () => ({ data: { probes: 'all' }, error: null })]) {
      datCauHinh(); hermesCalls = []; rpcCalls = []; daChen.queue = []; daChen.messages = []; workerLogs = [];
      hermesDue = [{ scheduleId: 'schedule-a', revision: 2 }]; hermesSweep = sweep;
      await tickTuDongHoa();
      expect(hermesCalls.map(call => call.name)).toEqual(['hermes_room_schedule_due_v1', 'hermes_room_schedule_run_v2', 'hermes_room_schedule_sweep_v1']);
      expect(workerLogs.some(entry => entry[0] === 'hermes schedule sweep unverified')).toBe(true);
      expect(rpcCalls).toHaveLength(4);
    }
  });

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
    expect(rpcCalls.every(call => call.name === 'zalo_enqueue_broadcast_v2')).toBe(true);
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
    // Sổ chỉ ghi khi dòng còn bật: sau dừng khẩn cấp, updated_at phải đứng yên ở mốc dừng.
    expect(locCapNhat.at(-1)).toEqual([['id', 'auto-1'], ['enabled', true]]);
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

/* ------------------------------------------------- lượt gửi MỘT LẦN (CRM/Hermes) */

const SHOT = 'shot-1';
const claimOf = (over = {}, config = {}, extra = {}) => ({
  status: 'claimed', con_lai: 120,
  oneshot: { id: SHOT, organization_id: 'org-1', recipients: ['c1', 'c2'], mode: 'full', origin: 'hermes',
    status: 'running', attempts: 1, ...over },
  config: { recipients: [], schedule: { time: '08:30', skipIfUnchanged: true },
    template: { shareUrl: 'https://ptcrm.test/r/abc' },
    antiSpam: { gapBetweenRecipientsSec: 180, gapBetweenRoomMsgsSec: 20, dailyCap: 120, maxRoomsPerRun: 5 }, ...config },
  ...extra,
});
const finishCalls = () => oneshotCalls.filter(c => c.name === 'zalo_worker_finish_oneshot_v1');

describe('engine broadcast — lượt gửi một lần', () => {
  it('gửi ngay khi lịch định kỳ TẮT: mặc định ĐẦY ĐỦ (link + ảnh bảng + chi tiết từng phòng) qua cổng SQL của lượt', async () => {
    duLieuAutomations = [];
    oneshotClaims = [claimOf()];
    await tickTuDongHoa(['org-1']);
    expect(oneshotCalls[0]).toMatchObject({ name: 'zalo_worker_claim_oneshot_v1', args: { p_organization_ids: ['org-1'] } });
    expect(rpcCalls).toHaveLength(8); // (link + ảnh bảng + 2 phòng) × 2 nhóm
    expect(rpcCalls.every(c => c.name === 'zalo_enqueue_broadcast_oneshot_v2' && c.args.p_oneshot_id === SHOT)).toBe(true);
    expect(rpcCalls.map(c => c.args.p_request_key).slice(0, 4)).toEqual([
      `oneshot:${SHOT}:c1:link`, `oneshot:${SHOT}:c1:table_image`, `oneshot:${SHOT}:c1:room:r1`, `oneshot:${SHOT}:c1:room:r2`]);
    expect(rpcCalls[0].args.p_body).toContain('https://ptcrm.test/r/abc');
    // Same pacing as the schedule: 20 s between messages, 180 s between groups.
    expect(rpcCalls.map(c => (Date.parse(c.args.p_not_before) - THU_HAI_0830.getTime()) / 1000)).toEqual([0, 20, 40, 60, 180, 200, 220, 240]);
    expect(finishCalls()).toHaveLength(1);
    expect(finishCalls()[0].args).toMatchObject({ p_oneshot_id: SHOT, p_ok: true, p_result: { so_tin: 8, so_nguoi_nhan: 2, che_do: 'full', partial: false } });
    expect(daChen.runs[0]).toMatchObject({ mode: 'full', messages_count: 8, recipients_count: 2, detail: { oneshot_id: SHOT, luot_mot_lan: true } });
  });

  it('chế độ GỌN chỉ gửi link + ảnh bảng', async () => {
    duLieuAutomations = [];
    oneshotClaims = [claimOf({ mode: 'compact' })];
    await tickTuDongHoa();
    expect(rpcCalls.map(c => c.args.p_request_key.split(':').at(-1))).toEqual(['link', 'table_image', 'link', 'table_image']);
    expect(daChen.runs[0]).toMatchObject({ mode: 'compact', messages_count: 4 });
  });

  it('KHÔNG áp skipIfUnchanged: danh sách y hệt lần gửi trước vẫn gửi, và chỉ cộng sổ trần (không đụng updated_at)', async () => {
    const { vanTayDanhSach } = await import('../lib/automation-scenario.js');
    datCauHinh({}, { lastScheduledDate: '2026-08-31', lastRoomsHash: vanTayDanhSach(phongGia), knownRoomIds: ['r1', 'r2'],
      sentDate: '2026-08-31', sentToday: 4 });
    oneshotClaims = [claimOf({ mode: 'compact' })];
    await tickTuDongHoa();
    expect(rpcCalls).toHaveLength(4);
    expect(rpcCalls.every(c => c.name === 'zalo_enqueue_broadcast_oneshot_v2')).toBe(true);
    expect(capNhatAutomations).toHaveLength(1);
    expect(capNhatAutomations[0]).toEqual({ stats: expect.objectContaining({ sentToday: 8, lastRoomsHash: vanTayDanhSach(phongGia) }) });
    expect(locCapNhat[0]).toContainEqual(['enabled', true]);
  });

  it('ngoài khung giờ lúc chạy thì chốt thất bại có mã, không xếp tin nào', async () => {
    vi.setSystemTime(new Date('2026-08-31T15:00:00Z')); // 22:00 giờ VN
    duLieuAutomations = [];
    oneshotClaims = [claimOf()];
    await tickTuDongHoa();
    expect(rpcCalls).toHaveLength(0);
    expect(finishCalls()[0].args).toMatchObject({ p_ok: false, p_result: { code: 'ngoai_khung_gio' } });
    expect(daChen.runs[0]).toMatchObject({ mode: 'failed', detail: { code: 'ngoai_khung_gio', oneshot_id: SHOT } });
  });

  it('trần ngày còn lại do SQL cấp chặn giữa chừng và báo một phần', async () => {
    duLieuAutomations = [];
    oneshotClaims = [claimOf({ mode: 'compact' }, {}, { con_lai: 3 })];
    await tickTuDongHoa();
    expect(rpcCalls).toHaveLength(3);
    expect(finishCalls()[0].args).toMatchObject({ p_ok: true, p_result: { so_tin: 3, so_chua_xep: 1, partial: true } });
    expect(daChen.runs[0]).toMatchObject({ mode: 'failed', messages_count: 3 });
    oneshotCalls = []; rpcCalls = [];
    oneshotClaims = [claimOf({}, {}, { con_lai: 0 })];
    await tickTuDongHoa();
    expect(rpcCalls).toHaveLength(0);
    expect(finishCalls()[0].args).toMatchObject({ p_ok: false, p_result: { code: 'het_tran_ngay' } });
  });

  it('chỉ gửi NHÓM sale còn hợp lệ có phiên sống; không còn nhóm nào thì chốt thất bại', async () => {
    duLieuAutomations = [];
    duLieuConversations = [conv('c1'), { ...conv('c2'), thread_type: 'user' }, { ...conv('c3'), is_sale_partner: false }, conv('c4', 'acc-DA-ROT')];
    oneshotClaims = [claimOf({ mode: 'compact', recipients: ['c1', 'c2', 'c3', 'c4'] })];
    await tickTuDongHoa();
    expect(new Set(rpcCalls.map(c => c.args.p_conversation_id))).toEqual(new Set(['c1']));
    oneshotCalls = []; rpcCalls = [];
    oneshotClaims = [claimOf({ recipients: ['c2', 'c3'] })];
    await tickTuDongHoa();
    expect(rpcCalls).toHaveLength(0);
    expect(finishCalls()[0].args).toMatchObject({ p_ok: false, p_result: { code: 'khong_co_nhom_san_sang' } });
  });

  it('lượt quá hạn được ghi nhật ký rồi chạy tiếp lượt kế; chạy lại cùng lượt dùng lại đúng khoá (không gửi trùng)', async () => {
    duLieuAutomations = [];
    oneshotClaims = [{ status: 'expired', code: 'qua_han', reason: 'Quá hạn', oneshot: { id: 'old', organization_id: 'org-1' } }, claimOf()];
    await tickTuDongHoa();
    expect(daChen.runs[0]).toMatchObject({ mode: 'failed', detail: { oneshot_id: 'old', code: 'qua_han' } });
    const first = rpcCalls.map(c => c.args.p_request_key);
    expect(first).toHaveLength(8);
    rpcCalls = []; phongGia.reverse();
    oneshotClaims = [claimOf({ attempts: 2 })]; // reclaimed after a worker crash
    await tickTuDongHoa();
    expect(new Set(rpcCalls.map(c => c.args.p_request_key))).toEqual(new Set(first));
  });

  it('công ty chưa có link chia sẻ trang Sale: báo đúng lý do, không gọi là hết phòng (cả lượt theo lịch)', async () => {
    phongGia.length = 0; trangSaleGia = 0;
    duLieuAutomations = [];
    oneshotClaims = [claimOf()];
    await tickTuDongHoa();
    expect(finishCalls()[0].args).toMatchObject({ p_ok: false, p_result: { code: 'khong_co_trang_sale' } });
    daChen.runs = [];
    datCauHinh();
    await tickTuDongHoa();
    expect(daChen.runs[0]).toMatchObject({ mode: 'skipped' });
    expect(daChen.runs[0].reason).toContain('chưa có link chia sẻ');
    daChen.runs = []; trangSaleGia = 1; datCauHinh();
    await tickTuDongHoa();
    expect(daChen.runs[0].reason).toContain('bảng rỗng');
  });

  it('P3b: bị dừng khẩn cấp giữa lượt thì nhật ký nói bị huỷ, không nói "đã xếp hàng", không cộng sổ trần', async () => {
    datCauHinh({}, { lastScheduledDate: '2026-08-31' });
    oneshotClaims = [claimOf({ mode: 'compact' })];
    finishResult = { ok: false, reason: 'cancelled', status: 'cancelled' };
    await tickTuDongHoa();
    expect(rpcCalls).toHaveLength(4);
    expect(daChen.runs[0]).toMatchObject({ mode: 'failed', messages_count: 4, detail: { huy_giua_chung: true, oneshot_id: SHOT } });
    expect(daChen.runs[0].reason).toContain('bị huỷ giữa chừng');
    expect(daChen.runs[0].reason).not.toContain('đã xếp hàng');
    expect(capNhatAutomations).toHaveLength(0);
  });

  it('lỗi chiếm lượt một lần không chặn lượt theo lịch', async () => {
    datCauHinh();
    oneshotClaimError = { message: 'offline' };
    await tickTuDongHoa();
    expect(workerLogs).toContainEqual(['automation: chiếm lượt một lần lỗi', 'offline']);
    expect(rpcCalls).toHaveLength(4);
    expect(rpcCalls.every(c => c.name === 'zalo_enqueue_broadcast_v2')).toBe(true);
  });
});
