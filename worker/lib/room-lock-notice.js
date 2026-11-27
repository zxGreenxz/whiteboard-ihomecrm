import { createHash } from 'node:crypto';
import { gioVietNam, trongKhungGio } from './automation-scenario.js';

export const LOCK_NOTICE_GAP_MS = 3_000;

// Trang sale hiện hành gồm mọi tòa thật của công ty khi còn link hoạt động.
// Phòng rời trang chỉ được báo Lock nếu phòng và tòa vẫn còn trong phạm vi đó.
export async function readLockNotice(db, orgId, roomId) {
  const { data, error } = await db.from('rooms')
    .select('code,name,building_id,building:buildings!rooms_building_id_fkey!inner(name)')
    .eq('organization_id', orgId).eq('id', roomId).is('deleted_at', null)
    .eq('building.organization_id', orgId).eq('building.is_virtual', false).is('building.deleted_at', null)
    .maybeSingle();
  if (error) throw new Error(`Chưa kiểm được phòng để báo Lock: ${error.message}`);
  const code = data?.code?.trim() || data?.name?.trim();
  const building = data?.building?.name?.trim();
  if (!code || !building) return null;
  const body = `@all Lock ${code} – ${building}`;
  const fingerprint = createHash('sha256').update(JSON.stringify(['room-lock', orgId, roomId, body])).digest('hex');
  return { buildingId: data.building_id, body, contentGuard: { version: 1, fingerprint } };
}

export function lockNoticeKey(payload) {
  if (payload?.tu_dong !== true) return null;
  const match = /^room-lock:([^:]+):(\d+):([^:]+)$/.exec(payload.automation_request_key);
  return match ? { roomId: match[1], since: Number(match[2]), groupId: match[3] } : null;
}

// Hai tài khoản có thể trỏ tới cùng một nhóm qua hai hội thoại khác nhau.
// Tra theo thread để nhận ra cả các tin xếp trước khi worker được nâng cấp.
export function jobsForLockGroup(db, orgId, roomId, since, threadId) {
  return db.from('zalo_send_queue').select('id,conversation_id,status,provider_started_at,conv:zalo_conversations!inner(thread_id)')
    .eq('organization_id', orgId).eq('conv.thread_id', threadId)
    .eq('payload->>tu_dong', 'true').like('payload->>automation_request_key', `room-lock:${roomId}:${since}:%`);
}

async function pendingLockRecipients(db, orgId, entry, groupThreads, online) {
  const pending = entry.pending && new Set(entry.pending);
  const recipients = [];
  for (const aliases of groupThreads.values()) {
    if (pending && !aliases.some(group => pending.has(group.id))) continue;
    let candidates = aliases;
    if (aliases.length > 1) {
      const { data, error } = await jobsForLockGroup(db, orgId, entry.id, entry.since, aliases[0].thread_id);
      if (error) throw new Error(`Chưa kiểm được biên nhận Lock: ${error.message}`);
      if (data.some(job => job.status !== 'failed' || job.provider_started_at)) continue;
      // RPC dùng lại khóa cũ cả khi job thất bại trước khi gửi. Chỉ một hội
      // thoại khác còn nguyên khóa mới có thể báo được cho nhóm này.
      const failed = new Set(data.map(job => job.conversation_id));
      candidates = aliases.filter(group => !failed.has(group.id));
    }
    const recipient = candidates.find(group => online.has(group.account_id)) ?? candidates[0];
    if (recipient) recipients.push(recipient.id);
  }
  return recipients;
}

// Giữ mốc mỗi lần phòng xuất hiện và từng nhóm còn chờ trong sổ của automation.
// Worker khởi động lại hoặc mất phản hồi enqueue vẫn dùng đúng khóa của lần lock.
export async function processRoomLocks({ db, orgId, phong, watch, groups, groupBuildings = {}, online, now, antiSpam, remaining, earliestStart, enqueue, log }) {
  const listedIds = new Set(groups.size && phong.trangSale > 0 ? phong.rooms.map(room => room.id) : []);
  const previous = new Map((watch ?? []).map(entry => [entry.id, entry]));
  const next = [];
  for (const id of listedIds) {
    const entry = previous.get(id);
    next.push(entry && !entry.pending ? entry : { id, since: now.getTime() });
  }

  let queued = 0;
  const recipients = new Set();
  let nextStart = earliestStart;
  const today = gioVietNam(now).ngay;
  const windowOpen = trongKhungGio(now, antiSpam).trong;
  const groupThreads = new Map();
  for (const group of groups.values()) {
    const thread = group.thread_id || group.id;
    if (!groupThreads.has(thread)) groupThreads.set(thread, []);
    groupThreads.get(thread).push(group);
  }
  for (const aliases of groupThreads.values()) aliases.sort((a, b) => a.id.localeCompare(b.id));
  for (const entry of previous.values()) {
    if (!phong.trangSale || listedIds.has(entry.id)) continue;
    // Tin đã xếp có thể còn chờ trong ngày. Giữ mốc cho tới khi phòng mở lại
    // để một tin của đợt cũ không thể tag lần hai sau khi phòng vừa khóa lại.
    if (entry.completedOn) {
      if (entry.completedOn === today) next.push(entry);
      continue;
    }
    let pending;
    try { pending = await pendingLockRecipients(db, orgId, entry, groupThreads, online); }
    catch (error) {
      log('automation: báo Lock', error.message);
      next.push(entry);
      continue;
    }
    const waiting = [];
    let notice;
    for (const id of pending) {
      const due = new Date(Math.max(Date.now(), nextStart));
      if (!online.has(groups.get(id).account_id) || queued >= remaining || !windowOpen
          || gioVietNam(due).ngay !== today || !trongKhungGio(due, antiSpam).trong) {
        waiting.push(id);
        continue;
      }
      if (!notice) {
        try { notice = await readLockNotice(db, orgId, entry.id); }
        catch (error) {
          log('automation: báo Lock', error.message);
          waiting.push(...pending.slice(pending.indexOf(id)));
          break;
        }
      }
      if (!notice) { waiting.length = 0; break; }
      const buildingId = groupBuildings[groups.get(id).thread_id];
      if (buildingId && notice.buildingId !== buildingId) continue;
      const requestKey = `room-lock:${entry.id}:${entry.since}:${id}`;
      if (await enqueue({ conv: groups.get(id), khiNao: due, requestKey, ...notice })) {
        queued++;
        recipients.add(id);
        nextStart = due.getTime() + LOCK_NOTICE_GAP_MS;
      } else waiting.push(id);
    }
    next.push(waiting.length ? { ...entry, pending: waiting } : { ...entry, pending: [], completedOn: today });
  }
  // Thứ tự phòng và thứ tự khóa jsonb có thể đổi mà trạng thái vẫn như cũ.
  const changed = next.length !== previous.size || next.some(entry => {
    const old = previous.get(entry.id);
    return old?.since !== entry.since || old?.completedOn !== entry.completedOn || JSON.stringify(old?.pending) !== JSON.stringify(entry.pending);
  });
  return { watch: next, changed, queued, recipients: recipients.size, nextStart };
}
