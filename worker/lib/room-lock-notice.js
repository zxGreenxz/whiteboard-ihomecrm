import { createHash } from 'node:crypto';
import { gioVietNam, trongKhungGio } from './automation-scenario.js';

// Trang sale hiện hành gồm mọi tòa thật của công ty khi còn link hoạt động.
// Phòng rời trang chỉ được báo Lock nếu phòng và tòa vẫn còn trong phạm vi đó.
export async function readLockNotice(db, orgId, roomId) {
  const { data, error } = await db.from('rooms')
    .select('code,name,building:buildings!rooms_building_id_fkey!inner(name)')
    .eq('organization_id', orgId).eq('id', roomId).is('deleted_at', null)
    .eq('building.organization_id', orgId).eq('building.is_virtual', false).is('building.deleted_at', null)
    .maybeSingle();
  if (error) throw new Error(`Chưa kiểm được phòng để báo Lock: ${error.message}`);
  const code = data?.code?.trim() || data?.name?.trim();
  const building = data?.building?.name?.trim();
  if (!code || !building) return null;
  const body = `@all Lock ${code} – ${building}`;
  const fingerprint = createHash('sha256').update(JSON.stringify(['room-lock', orgId, roomId, body])).digest('hex');
  return { body, contentGuard: { version: 1, fingerprint } };
}

export function lockNoticeKey(payload) {
  if (payload?.tu_dong !== true) return null;
  const match = /^room-lock:([^:]+):(\d+):([^:]+)$/.exec(payload.automation_request_key);
  return match ? { roomId: match[1], since: Number(match[2]), groupId: match[3] } : null;
}

// Giữ mốc mỗi lần phòng xuất hiện và từng nhóm còn chờ trong sổ của automation.
// Worker khởi động lại hoặc mất phản hồi enqueue vẫn dùng đúng khóa của lần lock.
export async function processRoomLocks({ db, orgId, phong, watch, groups, online, now, antiSpam, remaining, earliestStart, enqueue, log }) {
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
  const gap = groups.size > 1 ? Math.max(antiSpam.gapBetweenRoomMsgsSec, antiSpam.gapBetweenRecipientsSec) : antiSpam.gapBetweenRoomMsgsSec;
  for (const entry of previous.values()) {
    if (!phong.trangSale || listedIds.has(entry.id)) continue;
    // Tin đã xếp có thể còn chờ trong ngày. Giữ mốc cho tới khi phòng mở lại
    // để một tin của đợt cũ không thể tag lần hai sau khi phòng vừa khóa lại.
    if (entry.completedOn) {
      if (entry.completedOn === today) next.push(entry);
      continue;
    }
    const pending = (entry.pending ?? [...groups.keys()]).filter(id => groups.has(id));
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
      const requestKey = `room-lock:${entry.id}:${entry.since}:${id}`;
      if (await enqueue({ conv: groups.get(id), khiNao: due, requestKey, ...notice })) {
        queued++;
        recipients.add(id);
        nextStart = due.getTime() + gap * 1000;
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
