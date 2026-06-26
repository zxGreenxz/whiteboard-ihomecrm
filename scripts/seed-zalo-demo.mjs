// Seed dữ liệu demo cho trang Chat Zalo (5 hội thoại đúng design) để test
// end-to-end NGAY trước khi có Zalo thật. KHÔNG phải migration đa-tenant —
// chèn cho 1 owner cụ thể (mặc định tài khoản test).
//
// Chạy:
//   SUPABASE_ACCESS_TOKEN=<PAT>  SUPABASE_PROJECT_REF=<ref>  \
//   SEED_OWNER_EMAIL=nguyentamca165@gmail.com  node scripts/seed-zalo-demo.mjs
//
// PAT đọc từ env (không hardcode). Dùng service_role key (lấy qua Management
// API) + supabase-js để chèn JSON/tiếng Việt sạch, bỏ qua RLS.
import { createClient } from '@supabase/supabase-js';

const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL || 'nguyentamca165@gmail.com';
if (!PAT || !REF) { console.error('Thiếu SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF'); process.exit(1); }

const api = (p, opts = {}) =>
  fetch(`https://api.supabase.com/v1/projects/${REF}${p}`, {
    ...opts,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });

const sql = async (query) => {
  const r = await api('/database/query', { method: 'POST', body: JSON.stringify({ query }) });
  if (!r.ok) throw new Error('SQL ' + r.status + ' ' + (await r.text()));
  return r.json();
};

// — base dates (Node: dùng new Date thoải mái) —
function at(dayOffset, hhmm) {
  const d = new Date();
  d.setDate(d.getDate() - dayOffset);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

// — 5 hội thoại (mirror src/components/chat-zalo/_mockConvs.ts) —
const CONVS = [
  {
    key: 'an', name: 'Nguyễn Văn An', initials: 'An', tone: 'emerald', day: 0,
    sub: 'Sunrise Home · P.305', subTone: 'emerald', unread: 0, listTag: null, online: false,
    headerTag: { l: 'Đang thuê', t: 'success' }, headerSub: 'Khách trọ · Sunrise Home P.305 · 0901 234 567', phone: '0901 234 567', kind: 'tenant',
    profile: { kind: 'tenant', room: 'P.305', roomSub: 'Sunrise Home · Tầng 3 · 28m²', price: '4.500.000₫', contractCode: 'HD-2026-0182', contractTerm: '01/2026 – 12/2026 · Cọc 4.500.000₫', contractStatus: 'Hiệu lực', debt: { amount: '1.200.000₫', overdue: 'quá hạn 3 ngày', note: 'Hoá đơn T6 · điện nước phát sinh' }, staff: { name: 'Nguyễn Thị Lan', role: 'Quản lý Sunrise Home', initials: 'Lan', tone: 'purple' }, tags: [{ l: 'Đã thuê', t: 'success' }, { l: 'Khách thân thiết', t: 'info' }] },
    messages: [
      { type: 'sys', text: 'Tự động gửi mẫu "Nhắc đóng tiền" · 08:00', t: '07:59' },
      { dir: 'out', text: 'Chào anh An, hoá đơn tiền phòng tháng 6 của P.305 là 4.500.000₫ (đã gồm điện nước). Anh thanh toán giúp em trước 25/06 nhé ạ 🙏', t: '08:00', tick: 'seen' },
      { dir: 'in', text: 'Ok em, để anh chuyển khoản luôn nhé', t: '09:30' },
      { dir: 'in', type: 'image', label: 'Ảnh chuyển khoản.jpg', imgTone: 'neutral', t: '09:41' },
      { dir: 'in', text: 'Anh chuyển 4.500.000₫ rồi nhé, em kiểm tra giúp anh', t: '09:42', react: '❤️' },
      { dir: 'out', text: 'Em nhận được rồi ạ, em xác nhận đã thanh toán đủ tháng 6 ✅ Em cảm ơn anh nhiều!', t: '09:43', tick: 'sent', reply: { name: 'Nguyễn Văn An', text: 'Anh chuyển 4.500.000₫ rồi nhé…' } },
    ],
  },
  {
    key: 'hong', name: 'Trần Thị Hồng', initials: 'Hồ', tone: 'blue', day: 0,
    sub: 'Khách hẹn · hỏi P.201', subTone: null, unread: 2, listTag: null, online: true,
    headerTag: { l: 'Lead · Quan tâm', t: 'info' }, headerSub: 'Nguồn: Facebook Ads · 0977 882 011', phone: '0977 882 011', kind: 'lead',
    profile: { kind: 'lead', room: 'P.201', roomSub: 'Sunrise Home · 20m² · có gác lửng', price: '3.800.000₫', stage: 'Quan tâm', source: 'Facebook Ads', staff: { name: 'Nguyễn Thị Lan', role: 'Tư vấn cho thuê', initials: 'Lan', tone: 'purple' }, tags: [{ l: 'Lead nóng', t: 'debt' }, { l: 'Quan tâm', t: 'info' }] },
    messages: [
      { dir: 'in', text: 'Phòng còn trống không ạ? Em xem trên Facebook thấy phòng đẹp quá 😍', t: '09:12' },
      { dir: 'out', text: 'Dạ còn ạ! P.201 rộng 20m², có gác lửng, giá 3.800.000₫/tháng (chưa gồm điện nước). Chị xem ảnh phòng nhé ạ 👇', t: '09:13', tick: 'seen' },
      { dir: 'out', type: 'image', label: 'P.201 — gác lửng.jpg', imgTone: 'room', t: '09:13', tick: 'seen' },
      { dir: 'in', text: 'Cọc bao nhiêu vậy em? Khi nào mình xem phòng được ạ?', t: '09:15' },
    ],
  },
  {
    key: 'hai', name: 'Hải · Đất Xanh', initials: 'Hả', tone: 'purple', day: 0,
    sub: 'Môi giới · CTV', subTone: 'purple', unread: 1, listTag: null, online: false,
    headerTag: { l: 'Môi giới', t: 'purple' }, headerSub: 'Cộng tác viên môi giới · 0938 555 222', phone: '0938 555 222', kind: 'broker',
    profile: { kind: 'broker', company: 'Đất Xanh', phone: '0938 555 222', rooms: 'P.401, P.402, P.405 (Sunrise Home)', stats: [{ label: 'Khách g.thiệu', value: '8' }, { label: 'Chốt tháng', value: '3' }, { label: 'Hoa hồng', value: '6,0tr' }], tags: [{ l: 'Môi giới', t: 'purple' }, { l: 'CTV', t: 'info' }] },
    messages: [
      { type: 'sys', text: 'Tự động · 08:00 — gửi 12 ảnh phòng trống → 8 môi giới', t: '07:59' },
      { dir: 'out', type: 'image', label: 'Phòng trống Sunrise (12 ảnh)', imgTone: 'room', t: '08:00', tick: 'seen' },
      { dir: 'out', text: '🏠 Phòng trống Sunrise Home — cập nhật 08:00. Anh tư vấn khách giúp em nhé! P.401 · 3.8tr · P.402 · 4.0tr · P.405 · 4.2tr', t: '08:00', tick: 'seen' },
      { dir: 'in', text: 'Gửi mình list phòng trống tầng 3 nhé, có khách đang hỏi', t: '08:58' },
      { dir: 'out', text: 'Dạ tầng 3 còn P.308 trống, P.305 sắp trả phòng 30/06. Em gửi ảnh chi tiết ngay nhé!', t: '09:00', tick: 'sent' },
    ],
  },
  {
    key: 'quan', name: 'Lê Minh Quân', initials: 'Qu', tone: 'orange', day: 1,
    sub: 'Khách trọ · P.502', subTone: null, unread: 0, listTag: { l: 'Sự cố', t: 'warning' }, online: false,
    headerTag: { l: 'Sự cố', t: 'warning' }, headerSub: 'Khách trọ · Sunrise Home P.502 · 0912 345 678', phone: '0912 345 678', kind: 'tenant',
    profile: { kind: 'tenant', room: 'P.502', roomSub: 'Sunrise Home · Tầng 5 · 25m²', price: '4.200.000₫', contractCode: 'HD-2026-0144', contractTerm: '03/2026 – 02/2027 · Cọc 4.200.000₫', contractStatus: 'Hiệu lực', issue: { text: 'Điều hoà hỏng — đã tạo công việc bảo trì, KTV xử lý sáng mai 9h.' }, staff: { name: 'Trần Văn Hùng', role: 'KTV bảo trì', initials: 'Hùng', tone: 'slate' }, tags: [{ l: 'Đang thuê', t: 'success' }, { l: 'Sự cố', t: 'warning' }] },
    messages: [
      { dir: 'in', text: 'Điều hoà phòng em (P.502) bị hỏng rồi ạ, bật không thấy mát', t: '20:14' },
      { dir: 'out', text: 'Dạ em ghi nhận sự cố P.502 và đã tạo công việc bảo trì. Em cho thợ qua kiểm tra 9h sáng mai nhé anh?', t: '20:20', tick: 'seen' },
      { dir: 'in', text: 'Ok em', t: '20:21' },
    ],
  },
  {
    key: 'ha', name: 'Phạm Thu Hà', initials: 'Hà', tone: 'rose', day: 1,
    sub: 'Khách trọ · P.A12', subTone: null, unread: 0, listTag: { l: 'Quá hạn', t: 'debt' }, online: false,
    headerTag: { l: 'Quá hạn', t: 'debt' }, headerSub: 'Khách trọ · Sunrise Home P.A12 · 0987 112 233', phone: '0987 112 233', kind: 'tenant',
    profile: { kind: 'tenant', room: 'P.A12', roomSub: 'Sunrise Home · Tầng 1 · 22m²', price: '3.500.000₫', contractCode: 'HD-2026-0098', contractTerm: '02/2026 – 01/2027 · Cọc 3.500.000₫', contractStatus: 'Hiệu lực', debt: { amount: '2.100.000₫', overdue: 'quá hạn 5 ngày', note: 'Hoá đơn T6' }, staff: { name: 'Nguyễn Thị Lan', role: 'Quản lý Sunrise Home', initials: 'Lan', tone: 'purple' }, tags: [{ l: 'Đã thuê', t: 'success' }, { l: 'Quá hạn', t: 'debt' }] },
    messages: [
      { dir: 'out', text: 'Chào chị Hà, hoá đơn T6 của P.A12 còn 2.100.000₫ chưa thanh toán ạ. Chị sắp xếp giúp em trước cuối tuần nhé.', t: '14:02', tick: 'seen' },
      { dir: 'in', text: 'Vâng em cảm ơn chị, mai chị chuyển nhé', t: '14:10' },
    ],
  },
];

const TEMPLATES = [
  { title: 'Nhắc đóng tiền phòng', color: 'hsl(25 95% 53%)', category: 'reminder' },
  { title: 'Bảng giá & tiện ích phòng', color: 'hsl(152 69% 38%)', category: 'info' },
  { title: 'Xác nhận đặt cọc', color: 'hsl(214 90% 56%)', category: 'deposit' },
  { title: 'Thông báo chỉ số điện nước', color: 'hsl(271 70% 60%)', category: 'meter' },
];

const AUTOMATIONS = [
  { kind: 'broadcast_vacant', enabled: true, config: { schedule: 'Mỗi giờ · 08–20h', recipients: '8 môi giới', next: "10:00 (52')" }, stats: { runs_today: 34 } },
  { kind: 'auto_reply', enabled: true, config: { window: '22:00–07:00', keywords: ['giá', 'cọc', 'wifi', 'xem phòng'] }, stats: { today: 24 } },
];

async function main() {
  // 1) lấy service_role key + owner id
  const keysRes = await api('/api-keys?reveal=true');
  const keys = await keysRes.json();
  const serviceKey = (keys.find((k) => k.name === 'service_role') || {}).api_key;
  if (!serviceKey) throw new Error('Không lấy được service_role key');
  const url = `https://${REF}.supabase.co`;
  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

  const ownerRows = await sql(`select id from auth.users where email = '${OWNER_EMAIL.replace(/'/g, "''")}' limit 1`);
  const ownerId = ownerRows?.[0]?.id;
  if (!ownerId) throw new Error('Không tìm thấy owner email ' + OWNER_EMAIL);
  console.log('owner', ownerId);

  // 2) dọn demo cũ (account có meta.seed='zalo-demo' → cascade messages/conversations)
  await sql(`delete from public.zalo_conversations c using public.zalo_accounts a where c.account_id=a.id and a.meta->>'seed'='zalo-demo';`);
  await sql(`delete from public.zalo_accounts where user_id='${ownerId}' and meta->>'seed'='zalo-demo';`);
  await sql(`delete from public.zalo_message_templates where user_id='${ownerId}' and (variables->>'seed')='zalo-demo';`);

  // 3) account
  const { data: acc, error: accErr } = await sb.from('zalo_accounts').insert({
    user_id: ownerId, kind: 'personal', name: 'Zalo cá nhân (demo)', status: 'connected',
    meta: { seed: 'zalo-demo' },
  }).select().single();
  if (accErr) throw accErr;

  // 4) conversations + messages
  for (const c of CONVS) {
    const last = c.messages[c.messages.length - 1];
    const { data: conv, error: cErr } = await sb.from('zalo_conversations').insert({
      user_id: ownerId, account_id: acc.id, thread_id: c.key, peer_name: c.name, peer_phone: c.phone,
      initials: c.initials, tone: c.tone, kind: c.kind, sub_label: c.sub, sub_tone: c.subTone,
      list_tag: c.listTag, header_tag: c.headerTag, header_sub: c.headerSub, profile: c.profile,
      last_message_text: last.text || (last.type === 'image' ? '[Hình ảnh]' : ''),
      last_message_at: at(c.day, last.t), last_message_dir: last.dir || 'in',
      unread_count: c.unread, is_online: c.online,
    }).select().single();
    if (cErr) throw cErr;

    const rows = c.messages.map((m) => ({
      user_id: ownerId, conversation_id: conv.id, account_id: acc.id,
      direction: m.type === 'sys' ? 'out' : m.dir, msg_type: m.type || 'text',
      body: m.text || null, media_label: m.label || null, media_tone: m.imgTone || null,
      reply_to: m.reply || null, reaction_emoji: m.react || null,
      status: m.tick === 'seen' ? 'seen' : m.tick === 'sent' ? 'sent' : (m.dir === 'in' ? 'delivered' : 'sent'),
      created_at: at(c.day, m.t), sent_at: m.dir === 'out' ? at(c.day, m.t) : null,
    }));
    const { error: mErr } = await sb.from('zalo_messages').insert(rows);
    if (mErr) throw mErr;
    console.log('conv', c.key, '→', conv.id, `(${rows.length} msg)`);
  }

  // 5) templates
  const { error: tErr } = await sb.from('zalo_message_templates').insert(
    TEMPLATES.map((t, i) => ({ user_id: ownerId, title: t.title, color: t.color, category: t.category, sort_order: i, variables: { seed: 'zalo-demo' } })),
  );
  if (tErr) throw tErr;

  // 6) automations (upsert theo (user_id, kind))
  for (const a of AUTOMATIONS) {
    const { error: aErr } = await sb.from('zalo_automations').upsert(
      { user_id: ownerId, kind: a.kind, enabled: a.enabled, config: a.config, stats: a.stats },
      { onConflict: 'user_id,kind' },
    );
    if (aErr) throw aErr;
  }

  console.log('✅ Seed Chat Zalo demo xong.');
}

main().catch((e) => { console.error('SEED ERROR', e.message || e); process.exit(1); });
