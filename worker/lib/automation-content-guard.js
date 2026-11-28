import { createHash } from 'node:crypto';
import { mapPayloadSangToa } from './vacant-rooms.js';
import { lockNoticeKey, readLockNotice } from './room-lock-notice.js';

const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const byId = (a, b) => String(a.id).localeCompare(String(b.id), 'en');

export function broadcastHotline(phong, buildingId) {
  if (!buildingId) return phong?.hotline ?? '';
  const building = phong?.buildings?.find(b => b.id === buildingId);
  return building?.hotline || building?.phone || '';
}

// Hash only the existing public worker projection. Internal sale bonus/customer
// data never enters the queued metadata. Stable ordering avoids false changes
// from SQL row order; image/amenity order remains content and is preserved.
export function saleContentGuard(phong, template, buildingId = null) {
  const buildings = (phong?.buildings ?? []).filter(b => !buildingId || b.id === buildingId).sort(byId).map(building => ({
    ...building, rooms: [...(building.rooms ?? [])].sort(byId),
  }));
  const content = { ...(buildingId ? { buildingId } : {}), buildings, hotline: broadcastHotline(phong, buildingId), trangSale: phong?.trangSale ?? null, template };
  return { version: 1, fingerprint: createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex') };
}

export async function validateSaleContent(job, db, template, buildingId = null) {
  const guard = job?.payload?.sale_content_guard;
  const reject = reason => ({ ok: false, reason });
  if (!guard || Object.keys(guard).sort().join(',') !== 'fingerprint,version' || guard.version !== 1 ||
    typeof guard.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(guard.fingerprint)) {
    return reject('STALE_SALE_CONTENT: tin cũ thiếu phiên bản nội dung; cần dựng lại lượt gửi');
  }
  let response;
  try {
    response = await db.rpc('zalo_phong_trong_cho_worker_v1', { p_organization_id: job.organization_id });
  } catch {
    return reject('AUTOMATION_UNVERIFIED: chưa kiểm được nội dung phòng hiện tại');
  }
  const { data, error } = response ?? {};
  if (error || !data || !Array.isArray(data.rooms) || !Array.isArray(data.buildings)) {
    return reject('AUTOMATION_UNVERIFIED: chưa kiểm được nội dung phòng hiện tại');
  }
  const roomId = lockNoticeKey(job.payload)?.roomId;
  if (roomId) {
    if (!Number.isInteger(data.pages) || data.pages <= 0 || data.rooms.some(room => room.id === roomId)) {
      return reject('STALE_SALE_CONTENT: trang sale đã đóng hoặc phòng đã mở lại');
    }
    try {
      const notice = await readLockNotice(db, job.organization_id, roomId);
      return (!buildingId || notice?.buildingId === buildingId) && notice?.body === job.payload.body && notice?.contentGuard.fingerprint === guard.fingerprint
        ? { ok: true } : reject('STALE_SALE_CONTENT: phòng hoặc tòa của tin Lock đã thay đổi');
    } catch {
      return reject('AUTOMATION_UNVERIFIED: chưa kiểm được thông báo Lock phòng');
    }
  }
  const buildings = mapPayloadSangToa(data);
  const phong = { buildings, hotline: data.contact?.phone || buildings.find(b => b.phone)?.phone || '',
    trangSale: Number.isInteger(data.pages) ? data.pages : null };
  const current = saleContentGuard(phong, template, buildingId);
  const batch = job.payload.sale_batch_fingerprint;
  const matchesBatch = batch == null || batch === (buildingId ? saleContentGuard(phong, template) : current).fingerprint;
  return current.fingerprint === guard.fingerprint && matchesBatch ? { ok: true } : {
    ok: false, restartBatch: true, reason: 'STALE_SALE_CONTENT: phòng hoặc nội dung sale đã thay đổi; dừng và thu hồi đợt cũ',
  };
}
