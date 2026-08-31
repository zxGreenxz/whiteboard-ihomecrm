// =============================================================
// inbound.js — nghe tin từ Zalo → ghi DB. Port 4 bài học WEB2:
//   §13.7  Tên hội thoại 1-1 không được nhiễm uid SHOP: tin isSelf tạo thread
//          mới → peer_zalo_uid = threadId (uid KHÁCH), KHÔNG lấy dName.
//   §13.11 unread CHỈ cộng khi tin THẬT SỰ mới chèn VÀ có msgId (dedup là
//          partial unique — tin thiếu msgId luôn "mới" giả).
//   §13.17 Lưu zalo_raw (subset thô) cho tin có msgId — nguyên liệu dựng
//          quote khi reply + params cho sendSeenEvent.
//   §13.9  Reaction ghi bằng MỘT UPDATE (atomic), có nhánh GỠ reaction.
// Mọi INSERT mang organization_id (tách bạch công ty nằm ở DB, worker là
// service-role bypass RLS nên PHẢI tự kỷ luật ở đây).
// =============================================================
import { ThreadType } from 'zca-js';
import { sb, log, chunk, orgOf, notifyPush, sessions } from './ctx.js';
import { xuLyTinDen } from './auto-reply.js';

// ── Map event message zca-js → row inbound ──
const MSGTYPE_LABEL = {
  'chat.photo': '[Hình ảnh]', 'chat.sticker': '[Sticker]', 'share.file': '[Tệp tin]',
  'chat.voice': '[Tin nhắn thoại]', 'chat.video.msg': '[Video]', 'chat.gif': '[GIF]',
  'chat.recommended': '[Danh thiếp]', 'share.contact': '[Danh thiếp]',
  'chat.location.new': '[Vị trí]', 'chat.location': '[Vị trí]', 'group.poll': '[Bình chọn]',
};
function pickText(m) {
  const d = m?.data || {};
  const c = d.content;
  if (typeof c === 'string' && c.trim()) return c;
  if (c && typeof c === 'object') {
    if (c.title && String(c.title).trim()) return String(c.title);
    if (c.description && String(c.description).trim()) return String(c.description);
    if (c.text && String(c.text).trim()) return String(c.text);
  }
  const lbl = MSGTYPE_LABEL[String(d.msgType || '')];
  if (lbl) return lbl;
  if (c && typeof c === 'object') return '[Hình ảnh / Tệp]';
  return typeof c === 'string' ? c : '[Tin nhắn]';
}

// Phân loại tin → {msg_type, body, media_url, media_label}. Ảnh giữ URL CDN để FE hiện thật.
export function classifyMessage(m) {
  const d = m?.data || {};
  const mt = String(d.msgType || '');
  const c = d.content;
  if (mt === 'chat.photo' && c && typeof c === 'object') {
    const url = c.href || c.thumb || c.normalUrl || null;
    const cap = c.title && String(c.title).trim() ? String(c.title) : '';
    return { msg_type: 'image', body: cap || '[Hình ảnh]', media_url: url, media_label: cap || 'Ảnh', media_meta: null };
  }
  if (mt === 'chat.video.msg' && c && typeof c === 'object') {
    const cap = c.title && String(c.title).trim() ? String(c.title) : '';
    let dur = null;
    try { dur = c.params ? JSON.parse(c.params).duration : null; } catch { /* */ }
    return { msg_type: 'video', body: cap || '[Video]', media_url: c.href || null, media_label: cap || 'Video', media_meta: { thumb: c.thumb || null, duration: dur } };
  }
  if (mt === 'chat.voice' && c && typeof c === 'object') {
    return { msg_type: 'voice', body: '[Tin nhắn thoại]', media_url: c.href || null, media_label: 'Voice', media_meta: null };
  }
  if (mt === 'share.file' && c && typeof c === 'object') {
    const name = c.title && String(c.title).trim() ? String(c.title) : 'Tệp tin';
    return { msg_type: 'file', body: name, media_url: c.href || null, media_label: name, media_meta: null };
  }
  return { msg_type: 'text', body: pickText(m), media_url: null, media_label: null, media_meta: null };
}

// Subset THÔ đủ để: dựng quote khi reply (§13.17) + params sendSeenEvent.
// Chỉ tin có msgId; content cắt ≤2KB chống phình jsonb.
export function rawSubset(m) {
  const d = m?.data || {};
  if (!d.msgId) return null;
  let content = null;
  if (typeof d.content === 'string') content = d.content.slice(0, 2000);
  return {
    uidFrom: d.uidFrom != null ? String(d.uidFrom) : null,
    idTo: d.idTo != null ? String(d.idTo) : null,
    ts: d.ts ?? null,
    msgType: d.msgType ?? null,
    propertyExt: d.propertyExt ?? null,
    st: d.st ?? null, at: d.at ?? null, cmd: d.cmd ?? null,
    content,
  };
}

// Reaction Zalo (zca code) ↔ emoji hiển thị
const ZCA_REACTIONS = [
  { emoji: '❤️', zca: '/-heart' }, { emoji: '👍', zca: '/-strong' }, { emoji: '😆', zca: ':>' },
  { emoji: '😮', zca: ':o' }, { emoji: '😢', zca: ':-((' }, { emoji: '😠', zca: ':-h' },
];
export const zcaToEmoji = (code) => (ZCA_REACTIONS.find((r) => r.zca === code) || {}).emoji || code;
export const emojiToZca = (e) => (ZCA_REACTIONS.find((r) => r.emoji === e) || {}).zca || e;

export function threadTypeOf(m) {
  return m?.type === ThreadType.Group ? 'group' : 'user';
}
export function threadIdOf(m) {
  return String(m?.threadId ?? m?.data?.threadId ?? m?.data?.uidFrom ?? '');
}

// Điền tên/avatar THẬT cho NHÓM mới tạo từ một tin nhắn — best-effort.
//
// Vì sao cần: `syncContacts` chỉ quét danh sách nhóm MỘT LẦN lúc đăng nhập. Nhóm
// lập sau đó chỉ vào CSDL khi có tin nhắn đầu tiên đi qua, mà tin nhắn KHÔNG mang
// tên nhóm — `dName` trong đó là tên NGƯỜI GỬI. Không có hàm này thì nhóm nằm
// trong danh sách dưới cái tên "Nhóm Zalo", và người dùng không thể chọn nó làm
// nơi nhận tin phòng trống định kỳ vì không biết nó là nhóm nào.
async function fillGroupInfo(api, convId, groupId) {
  try {
    const info = await api.getGroupInfo([String(groupId)]);
    const g = Object.values(info?.gridInfoMap || {}).find((x) => x && x.groupId);
    if (!g) return;
    await sb.from('zalo_conversations').update({
      ...(g.name ? { peer_name: g.name } : {}),
      ...(g.fullAvt || g.avt ? { peer_avatar_url: g.fullAvt || g.avt } : {}),
      profile: {
        kind: 'unknown', isGroup: true,
        members: g.totalMember || (Array.isArray(g.memberIds) ? g.memberIds.length : null),
        desc: g.desc || null,
        memberIds: Array.isArray(g.memberIds) ? g.memberIds.slice(0, 500) : null,
      },
    }).eq('id', convId);
    log('điền tên nhóm →', convId, g.name);
  } catch (e) { log('fillGroupInfo', e?.message || e); }
}

// Điền tên/avatar thật cho hội thoại 1-1 tạo từ tin isSelf — best-effort.
async function fillPeerInfo(api, convId, uid) {
  try {
    const r = await api.getUserInfo(String(uid));
    const p = r?.changed_profiles?.[String(uid)] || r?.[String(uid)] || r;
    const name = p?.displayName || p?.zaloName || p?.username || null;
    const avatar = p?.avatar || null;
    if (name || avatar) {
      await sb.from('zalo_conversations').update({
        ...(name ? { peer_name: name } : {}),
        ...(avatar ? { peer_avatar_url: avatar } : {}),
      }).eq('id', convId);
    }
  } catch (e) { log('fillPeerInfo', e?.message || e); }
}

async function upsertConversation(accountId, ownerId, m, api) {
  const threadId = threadIdOf(m);
  const ttype = threadTypeOf(m);
  // Lấy kèm user_id/organization_id/is_sale_partner: auto-reply cần cả ba ngay
  // sau khi ghi tin, và một truy vấn ở đây rẻ hơn một truy vấn thứ hai sau đó.
  const COT_CONV = 'id, unread_count, user_id, organization_id, is_sale_partner';
  let { data: conv } = await sb.from('zalo_conversations')
    .select(COT_CONV).eq('account_id', accountId).eq('thread_id', threadId).maybeSingle();
  if (!conv) {
    const isSelf = !!m?.isSelf;
    // §13.7 — tin MÌNH gửi tạo thread mới: uidFrom/dName là của SHOP, không
    // phải khách → uid khách = threadId (1-1), tên đặt tạm rồi điền async.
    const peerUid = ttype === 'user'
      ? (isSelf ? threadId : String(m?.data?.uidFrom ?? threadId))
      : String(m?.data?.uidFrom ?? '');
    // NHÓM: `dName`/`fromName` là tên NGƯỜI GỬI, không phải tên nhóm — dùng nó
    // sẽ đặt cho nhóm cái tên của người tình cờ nhắn đầu tiên. Đặt tạm rồi hỏi
    // Zalo tên thật ở dưới.
    const peerName = ttype === 'group'
      ? 'Nhóm Zalo'
      : ((!isSelf && (m?.data?.dName || m?.data?.fromName)) || 'Khách Zalo');
    const ins = await sb.from('zalo_conversations').insert({
      user_id: ownerId, organization_id: orgOf(accountId),
      account_id: accountId, thread_id: threadId, thread_type: ttype,
      peer_name: peerName, peer_zalo_uid: peerUid, kind: 'unknown',
    }).select(COT_CONV).single();
    conv = ins.data;
    if (conv && api) {
      if (ttype === 'group') fillGroupInfo(api, conv.id, threadId);
      else if (isSelf) fillPeerInfo(api, conv.id, threadId);
    }
  }
  return conv;
}

/**
 * Echo của MEDIA mình vừa gửi từ web: gắn vào đúng dòng đang chờ thay vì đẻ dòng mới.
 *
 * VÌ SAO CẦN — lỗi đã cắn thật 31/08/2026: mỗi ảnh gửi từ web hiện HAI lần trong
 * khung chat. Dòng thứ nhất do web tạo (trỏ ảnh tự host, trạng thái `pending`),
 * dòng thứ hai là echo `selfListen` từ Zalo. Cơ chế chống trùng sẵn có dựa hoàn
 * toàn vào `zalo_msg_id`, mà zca **không phải lúc nào cũng trả msgId cho
 * attachment** — chính `media.js` đã ghi chú điều đó và trông cậy vào "unique sẽ
 * tự vá". Không có id chung thì unique không vá được gì, và ta còn lại hai dòng.
 *
 * Ghép theo (hội thoại + loại media + đang chờ + trong 5 phút), lấy dòng CŨ NHẤT
 * để khớp thứ tự gửi khi có nhiều ảnh liên tiếp. Giữ `media_url` tự host của dòng
 * cũ — người dùng xem lại được vĩnh viễn, không phụ thuộc CDN Zalo hết hạn.
 *
 * @returns true nếu đã gắn vào dòng có sẵn (chỗ gọi khỏi chèn dòng mới).
 */
async function gopVaoTinDangCho(accountId, convId, cm, msgId, m) {
  if (!msgId || !['image', 'file', 'voice', 'video'].includes(cm.msg_type)) return false;
  const tuLuc = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: cho } = await sb.from('zalo_messages')
    .select('id')
    .eq('conversation_id', convId).eq('account_id', accountId)
    .eq('direction', 'out').eq('status', 'pending').eq('msg_type', cm.msg_type)
    .is('zalo_msg_id', null)
    .gte('created_at', tuLuc)
    .order('created_at', { ascending: true })
    .limit(1).maybeSingle();
  if (!cho) return false;

  const { error } = await sb.from('zalo_messages').update({
    status: 'sent',
    zalo_msg_id: msgId,
    cli_msg_id: m?.data?.cliMsgId ? String(m.data.cliMsgId) : null,
    zalo_raw: rawSubset(m),
    // media_url GIỮ NGUYÊN bản tự host — xem mục trên.
  }).eq('id', cho.id);
  if (error) { log('gộp echo media lỗi', error.message); return false; }
  log('gộp echo media vào dòng đang chờ', cho.id);
  return true;
}

export async function handleInbound(accountId, ownerId, m, api) {
  try {
    // isSelf = tin do CHÍNH tài khoản gửi (kể cả từ điện thoại) → lưu là 'out'.
    const out = !!m?.isSelf;
    const conv = await upsertConversation(accountId, ownerId, m, api);
    if (!conv) return;
    const cm = classifyMessage(m);
    const body = cm.body;
    const msgId = m?.data?.msgId ? String(m.data.msgId) : null;

    // Tin media do CHÍNH MÌNH gửi: thử gắn vào dòng đang chờ trước đã.
    if (out && await gopVaoTinDangCho(accountId, conv.id, cm, msgId, m)) return;
    const { data: insData } = await sb.from('zalo_messages').upsert({
      user_id: ownerId, organization_id: orgOf(accountId),
      conversation_id: conv.id, account_id: accountId,
      direction: out ? 'out' : 'in', msg_type: cm.msg_type, body,
      media_url: cm.media_url, media_label: cm.media_label, media_meta: cm.media_meta || null,
      zalo_msg_id: msgId,
      cli_msg_id: m?.data?.cliMsgId ? String(m.data.cliMsgId) : null,
      zalo_raw: rawSubset(m),
      status: out ? 'sent' : 'delivered', created_at: new Date().toISOString(),
    }, { onConflict: 'account_id,zalo_msg_id', ignoreDuplicates: true }).select('id');

    // §13.11 — unread chỉ cộng khi dòng THẬT SỰ mới VÀ có msgId. Tin thiếu
    // msgId không dedup được (partial unique) nên double-fire sẽ cộng ảo.
    const isNew = Array.isArray(insData) && insData.length > 0;
    const bump = isNew && !out && !!msgId;
    await sb.from('zalo_conversations').update({
      last_message_text: body || '[Tin nhắn]', last_message_at: new Date().toISOString(),
      last_message_dir: out ? 'out' : 'in',
      unread_count: out ? 0 : (conv.unread_count || 0) + (bump ? 1 : 0),
    }).eq('id', conv.id);
    log(out ? 'self →' : 'inbound →', conv.id, (body || '').slice(0, 40));

    if (!out && isNew) {
      const peerName = m?.data?.dName || m?.data?.fromName || 'Zalo';
      notifyPush({
        userId: ownerId,
        title: `Tin nhắn Zalo · ${peerName}`,
        body: (body || '[Tin nhắn]').slice(0, 120),
        url: '/chat-zalo',
        tag: `zalo-${conv.id}`,
      });
      // Tự động trả lời sale — fire & forget. Hàm tự nuốt mọi lỗi: đường NHẬN
      // tin không được hỏng vì một tính năng phụ, và người dùng thà mất một tin
      // trả lời tự động còn hơn mất một tin của khách.
      xuLyTinDen({ accountId, conv: { ...conv, user_id: conv.user_id || ownerId }, body })
        .catch((e) => log('auto-reply (nuốt)', e?.message || e));
    }
  } catch (e) { log('handleInbound error', e.message); }
}

// ── Upsert N tin vào 1 hội thoại; tạo hội thoại nếu chưa có ──
// `api` là TUỲ CHỌN và chỉ dùng để hỏi tên nhóm thật; thiếu nó thì hội thoại
// nhóm vẫn được tạo, chỉ mang tên tạm "Nhóm Zalo".
export async function upsertMessagesForThread(accountId, ownerId, threadId, tt, msgs, api = null) {
  if (!Array.isArray(msgs) || !msgs.length) return 0;
  let { data: conv } = await sb.from('zalo_conversations').select('id').eq('account_id', accountId).eq('thread_id', threadId).maybeSingle();
  if (!conv) {
    const f = msgs.find((x) => !x?.isSelf) || msgs[0];
    const isSelf = !!f?.isSelf;
    const ins = await sb.from('zalo_conversations').insert({
      user_id: ownerId, organization_id: orgOf(accountId),
      account_id: accountId, thread_id: threadId, thread_type: tt,
      // Cùng lý do như upsertConversation: với NHÓM thì `dName` là tên người
      // gửi, không phải tên nhóm.
      peer_name: tt === 'group' ? 'Nhóm Zalo' : ((!isSelf && f?.data?.dName) || 'Khách Zalo'),
      peer_zalo_uid: tt === 'user' ? (isSelf ? threadId : String(f?.data?.uidFrom || threadId)) : String(f?.data?.uidFrom || ''),
    }).select('id').single();
    conv = ins.data;
    if (conv && tt === 'group' && api) fillGroupInfo(api, conv.id, threadId);
  }
  if (!conv) return 0;
  const rows = msgs.map((m) => {
    const cm = classifyMessage(m);
    return {
      user_id: ownerId, organization_id: orgOf(accountId),
      conversation_id: conv.id, account_id: accountId,
      direction: m.isSelf ? 'out' : 'in', msg_type: cm.msg_type, body: cm.body,
      media_url: cm.media_url, media_label: cm.media_label, media_meta: cm.media_meta || null,
      zalo_msg_id: m?.data?.msgId ? String(m.data.msgId) : null,
      cli_msg_id: m?.data?.cliMsgId ? String(m.data.cliMsgId) : null,
      zalo_raw: rawSubset(m),
      status: m.isSelf ? 'sent' : 'delivered',
      created_at: m?.data?.ts ? new Date(Number(m.data.ts)).toISOString() : new Date().toISOString(),
    };
  }).filter((r) => r.zalo_msg_id);
  if (rows.length) await sb.from('zalo_messages').upsert(rows, { onConflict: 'account_id,zalo_msg_id', ignoreDuplicates: false });
  // cập nhật preview từ tin mới nhất (chỉ khi mới hơn)
  const last = msgs[msgs.length - 1];
  const lastTs = last?.data?.ts ? new Date(Number(last.data.ts)).toISOString() : null;
  if (lastTs) {
    const cmLast = classifyMessage(last);
    await sb.from('zalo_conversations').update({ last_message_text: cmLast.body || '[Tin nhắn]', last_message_at: lastTs, last_message_dir: last.isSelf ? 'out' : 'in' }).eq('id', conv.id).lt('last_message_at', lastTs);
  }
  return rows.length;
}

// ── Đồng bộ TIN GẦN ĐÂY (event old_messages) — gom theo thread rồi upsert ──
export async function handleOldMessages(accountId, ownerId, messages, type, api = null) {
  try {
    if (!Array.isArray(messages) || !messages.length) return;
    const tt = type === ThreadType.Group ? 'group' : 'user';
    const byThread = new Map();
    for (const m of messages) {
      const tid = threadIdOf(m);
      if (!tid) continue;
      if (!byThread.has(tid)) byThread.set(tid, []);
      byThread.get(tid).push(m);
    }
    let total = 0;
    for (const [tid, msgs] of byThread) total += await upsertMessagesForThread(accountId, ownerId, tid, tt, msgs, api);
    log('old_messages', tt, '→', total, 'tin /', byThread.size, 'hội thoại');
  } catch (e) { log('handleOldMessages', e?.message || e); }
}

// ── Đồng bộ bạn bè + nhóm → zalo_conversations ──
async function upsertConvRows(rows) {
  for (const c of chunk(rows, 200)) {
    const { error } = await sb.from('zalo_conversations').upsert(c, { onConflict: 'account_id,thread_id', ignoreDuplicates: false });
    if (error) log('upsert conv error', error.message);
  }
}

export async function syncContacts(api, accountId, ownerId) {
  const orgId = orgOf(accountId);
  // Bạn bè
  let friends = [];
  try { friends = await api.getAllFriends(20000, 0); } catch (e) { log('getAllFriends', e?.message || e); }
  const friendRows = (friends || []).filter((u) => u && u.userId).map((u) => ({
    user_id: ownerId, organization_id: orgId,
    account_id: accountId, thread_id: String(u.userId), thread_type: 'user',
    peer_name: u.displayName || u.zaloName || 'Bạn Zalo', peer_avatar_url: u.avatar || null,
    peer_phone: u.phoneNumber || null, peer_zalo_uid: String(u.userId),
  }));
  if (friendRows.length) await upsertConvRows(friendRows);

  // Nhóm: getAllGroups trả map id→version; chi tiết qua getGroupInfo
  let gids = [];
  try { const g = await api.getAllGroups(); gids = Object.keys(g?.gridVerMap || {}); } catch (e) { log('getAllGroups', e?.message || e); }
  let groupCount = 0;
  for (const ids of chunk(gids, 50)) {
    try {
      const info = await api.getGroupInfo(ids);
      const map = info?.gridInfoMap || {};
      const rows = Object.values(map).filter((g) => g && g.groupId).map((g) => ({
        user_id: ownerId, organization_id: orgId,
        account_id: accountId, thread_id: String(g.groupId), thread_type: 'group',
        peer_name: g.name || 'Nhóm Zalo', peer_avatar_url: g.fullAvt || g.avt || null,
        profile: { kind: 'unknown', isGroup: true, members: g.totalMember || (Array.isArray(g.memberIds) ? g.memberIds.length : null), desc: g.desc || null, memberIds: Array.isArray(g.memberIds) ? g.memberIds.slice(0, 500) : null },
      }));
      if (rows.length) { await upsertConvRows(rows); groupCount += rows.length; }
    } catch (e) { log('getGroupInfo', e?.message || e); }
  }
  log('synced', friendRows.length, 'bạn,', groupCount, 'nhóm →', accountId);

  // Gắn hội thoại ↔ hồ sơ CRM theo SĐT vừa đổ về từ danh bạ (matcher nằm trọn
  // trong SQL — trigger phủ dòng mới, RPC này phủ dòng đã tồn tại trước đó).
  try {
    const { data, error } = await sb.rpc('zalo_backfill_crm_links', { p_account_id: accountId });
    if (error) log('backfill CRM', error.message);
    else log('backfill CRM →', data, 'hội thoại gắn hồ sơ');
  } catch (e) { log('backfill CRM', e?.message || e); }
}

// ── Đồng bộ NHÃN "Phân loại" (getLabels) → zalo_labels + gắn vào hội thoại ──
export async function syncLabels(api, accountId, ownerId) {
  let labels = [];
  try { const r = await api.getLabels(); labels = r?.labelData || []; } catch (e) { log('getLabels', e?.message || e); return; }
  const rows = labels.filter((l) => l && l.id != null).map((l, i) => ({
    user_id: ownerId, organization_id: orgOf(accountId),
    account_id: accountId, label_id: Number(l.id),
    name: l.text || ('Nhãn ' + l.id), color: l.color || null, emoji: l.emoji || null, sort_order: l.offset ?? i,
  }));
  if (rows.length) await sb.from('zalo_labels').upsert(rows, { onConflict: 'account_id,label_id' });
  const ids = rows.map((r) => r.label_id);
  if (ids.length) await sb.from('zalo_labels').delete().eq('account_id', accountId).not('label_id', 'in', '(' + ids.join(',') + ')');
  else await sb.from('zalo_labels').delete().eq('account_id', accountId);
  // thread → [label_id]. Nhóm có thể mang tiền tố 'g' → thử cả 2 biến thể.
  const threadToLabels = new Map();
  const addThread = (raw, labId) => {
    const variants = new Set([String(raw)]);
    const s = String(raw);
    if (/^g/i.test(s)) variants.add(s.replace(/^g/i, ''));
    for (const k of variants) {
      if (!threadToLabels.has(k)) threadToLabels.set(k, new Set());
      threadToLabels.get(k).add(Number(labId));
    }
  };
  for (const l of labels) for (const t of (l.conversations || [])) addThread(t, l.id);

  await sb.from('zalo_conversations').update({ label_ids: [] }).eq('account_id', accountId).neq('label_ids', '[]');
  const bySet = new Map();
  for (const [t, labSet] of threadToLabels) {
    const labs = [...labSet].sort((a, b) => a - b);
    const key = labs.join(',');
    if (!bySet.has(key)) bySet.set(key, { labs, threads: [] });
    bySet.get(key).threads.push(t);
  }
  let tagged = 0;
  for (const { labs, threads } of bySet.values()) {
    for (const ch of chunk(threads, 300)) {
      const { data } = await sb.from('zalo_conversations').update({ label_ids: labs })
        .eq('account_id', accountId).in('thread_id', ch).select('id');
      tagged += (data || []).length;
    }
  }
  log('labels synced', rows.length, 'nhãn /', threadToLabels.size, 'thread →', tagged, 'hội thoại khớp');
}

// ── Inbound: reaction / undo / seen (best-effort, defensive) ──
function evMsgIds(e) {
  const d = e?.data || e;
  const ids = [];
  const push = (x) => { if (x) ids.push(String(x)); };
  push(d?.msgId); push(d?.globalMsgId); push(d?.content?.rMsg?.[0]?.gMsgID);
  if (Array.isArray(d?.msgIds)) d.msgIds.forEach(push);
  return ids;
}
function evThreadId(e) { const d = e?.data || e; return String(e?.threadId ?? d?.threadId ?? d?.idTo ?? d?.uidFrom ?? ''); }

export async function handleReaction(accountId, e) {
  try {
    const d = e?.data || e;
    const icon = d?.content?.rIcon || d?.rIcon || d?.icon;
    const ids = evMsgIds(e);
    if (!ids.length) return;
    // icon rỗng / '-1' = GỠ reaction. Một UPDATE duy nhất (atomic) cho cả hai nhánh.
    const removed = !icon || icon === '-1';
    await sb.from('zalo_messages')
      .update({ reaction_emoji: removed ? null : zcaToEmoji(icon) })
      .eq('account_id', accountId).in('zalo_msg_id', ids);
    log('reaction', accountId, removed ? '(gỡ)' : zcaToEmoji(icon));
  } catch (err) { log('handleReaction', err?.message || err); }
}
export async function handleUndo(accountId, e) {
  try {
    const ids = evMsgIds(e);
    if (!ids.length) return;
    await sb.from('zalo_messages').update({ body: '(Tin đã được thu hồi)', msg_type: 'sys' }).eq('account_id', accountId).in('zalo_msg_id', ids);
    log('undo', accountId, ids.join(','));
  } catch (err) { log('handleUndo', err?.message || err); }
}
export async function handleSeen(accountId, e) {
  try {
    const tid = evThreadId(e);
    if (!tid) return;
    const { data: conv } = await sb.from('zalo_conversations').select('id').eq('account_id', accountId).eq('thread_id', tid).maybeSingle();
    if (!conv) return;
    await sb.from('zalo_messages').update({ status: 'seen' })
      .eq('conversation_id', conv.id).eq('direction', 'out').in('status', ['sent', 'delivered']);
    log('seen', accountId, tid);
  } catch (err) { log('handleSeen', err?.message || err); }
}

// ── Gắn toàn bộ listener cho 1 phiên vừa login ──
// onClosed(code): login.js truyền vào để xử lý kick/reconnect (tránh import vòng).
export async function attachSession(accountId, ownerId, api, { onClosed, sessionSavedAt } = {}) {
  let ownId = '';
  try { ownId = await api.getOwnId?.(); } catch { /* ignore */ }
  sessions.set(accountId, {
    api, ownId,
    connectedAt: Date.now(),
    probeFails: 0,
    sessionSavedAt: sessionSavedAt || Date.now(),
  });
  try {
    api.listener.on('message', (m) => handleInbound(accountId, ownerId, m, api));
    api.listener.on('old_messages', (msgs, type) => handleOldMessages(accountId, ownerId, msgs, type, api));
    api.listener.on('reaction', (e) => handleReaction(accountId, e));
    api.listener.on('undo', (e) => handleUndo(accountId, e));
    api.listener.on('seen_messages', (e) => handleSeen(accountId, e));
    api.listener.on('error', (e) => {
      log('listener error', accountId, e?.message || e);
      onClosed?.(1006);
    });
    // zca-js phát 'closed' kèm CloseReason (3000 DuplicateConnection / 3003 Kick).
    try { api.listener.on('closed', (code) => onClosed?.(Number(code) || 1006)); } catch { /* phiên bản không có event này → watchdog lo */ }
    api.listener.start();
    // Yêu cầu Zalo đẩy TIN GẦN ĐÂY (1-1 + nhóm); tin về qua event 'old_messages'.
    setTimeout(() => {
      try { api.listener.requestOldMessages(ThreadType.User); } catch (e) { log('reqOld user', e?.message || e); }
      try { api.listener.requestOldMessages(ThreadType.Group); } catch (e) { log('reqOld group', e?.message || e); }
    }, 2000);
  } catch (e) { log('listener start error', e.message); }
  syncContacts(api, accountId, ownerId).catch((e) => log('syncContacts error', e?.message || e));
  syncLabels(api, accountId, ownerId).catch((e) => log('syncLabels error', e?.message || e));
}
