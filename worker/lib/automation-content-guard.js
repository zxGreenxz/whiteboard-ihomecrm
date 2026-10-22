import { createHash } from 'node:crypto';
import { mapPayloadSangToa } from './vacant-rooms.js';

const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const byId = (a, b) => String(a.id).localeCompare(String(b.id), 'en');

// Hash only the existing public worker projection. Internal sale bonus/customer
// data never enters the queued metadata. Stable ordering avoids false changes
// from SQL row order; image/amenity order remains content and is preserved.
export function saleContentGuard(phong, template) {
  const buildings = [...(phong?.buildings ?? [])].sort(byId).map(building => ({
    ...building, rooms: [...(building.rooms ?? [])].sort(byId),
  }));
  const content = { buildings, hotline: phong?.hotline ?? '', trangSale: phong?.trangSale ?? null, template };
  return { version: 1, fingerprint: createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex') };
}

export async function validateSaleContent(job, db, template) {
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
  const buildings = mapPayloadSangToa(data);
  const current = saleContentGuard({ buildings,
    hotline: data.contact?.phone || buildings.find(b => b.phone)?.phone || '',
    trangSale: Number.isInteger(data.pages) ? data.pages : null }, template);
  return current.fingerprint === guard.fingerprint ? { ok: true } :
    reject('STALE_SALE_CONTENT: phòng hoặc nội dung sale đã thay đổi; không gửi bản cũ');
}
