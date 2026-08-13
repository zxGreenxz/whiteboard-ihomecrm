// =============================================================
// lease.js — khoá ĐƠN-INSTANCE cho worker (bảng zalo_worker_lease).
//
// Vì sao bắt buộc (bài học WEB2 §13.22): refresh phiên Zalo là dùng-một-lần;
// 2 instance cùng giữ một bộ account sẽ luân phiên đá phiên của nhau
// (close 3000/3003) vô hạn. Lease này bảo đảm tại một thời điểm chỉ MỘT
// worker chạy: instance mới chờ lease cũ hết TTL (30s không heartbeat) hoặc
// được release lúc shutdown; instance cũ thấy lease đổi chủ thì tự thoát.
// =============================================================
import crypto from 'node:crypto';
import os from 'node:os';
import { sb, log } from './ctx.js';

export const INSTANCE_ID = crypto.randomUUID();
const LEASE_TTL_MS = 30_000;

// Trả true nếu giành/giữ được lease.
// ⚠ CỐ Ý không dùng .or(): PostgREST của project này trả 42703 ("column …
// does not exist") khi PATCH nhiều cột kèm ?or= — đã đo thật 13/08/2026
// (PATCH 1 cột + or thì chạy, ≥2 cột + or thì chết, .eq/.lt đơn luôn chạy).
// Ba bước dưới đây mỗi bước đều nguyên tử ở tầng DB nên tách ra vẫn an toàn.
export async function claimLease() {
  const cutoff = new Date(Date.now() - LEASE_TTL_MS).toISOString();
  const patch = {
    instance_id: INSTANCE_ID,
    hostname: os.hostname(),
    heartbeat_at: new Date().toISOString(),
    claimed_at: new Date().toISOString(),
  };

  // (1) lease đã là của mình → gia hạn
  const own = await sb.from('zalo_worker_lease').update(patch)
    .eq('id', 'singleton').eq('instance_id', INSTANCE_ID).select('instance_id');
  if (own.error) { log('claimLease error', own.error.message); return false; }
  if (own.data?.length) return true;

  // (2) chủ cũ im hơi quá TTL → tiếp quản (UPDATE nguyên tử: chỉ 1 kẻ thắng)
  const take = await sb.from('zalo_worker_lease').update(patch)
    .eq('id', 'singleton').lt('heartbeat_at', cutoff).select('instance_id');
  if (take.error) { log('claimLease error', take.error.message); return false; }
  if (take.data?.length) return true;

  // (3) chưa có dòng nào → insert (thua cuộc đua insert = chưa giành được)
  const ins = await sb.from('zalo_worker_lease').insert({ id: 'singleton', ...patch }).select('instance_id');
  if (!ins.error && ins.data?.length) return true;
  return false;
}

// Trả true nếu vẫn là chủ lease; false = instance khác đã lên → phải tự thoát.
export async function heartbeatLease() {
  const { data, error } = await sb.from('zalo_worker_lease')
    .update({ heartbeat_at: new Date().toISOString() })
    .eq('id', 'singleton')
    .eq('instance_id', INSTANCE_ID)
    .select('instance_id');
  if (error) { log('heartbeatLease error', error.message); return true; } // lỗi mạng ≠ mất lease
  return !!(data && data.length);
}

export async function releaseLease() {
  try {
    await sb.from('zalo_worker_lease')
      .update({ heartbeat_at: new Date(0).toISOString() })
      .eq('id', 'singleton')
      .eq('instance_id', INSTANCE_ID);
    log('lease released', INSTANCE_ID.slice(0, 8));
  } catch (e) { log('releaseLease error', e?.message || e); }
}
