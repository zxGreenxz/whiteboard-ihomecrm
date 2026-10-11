import { sb } from './ctx.js';
import { INSTANCE_ID } from './lease.js';

// Keep canonical messages and their queue/idempotency receipt in one DB
// transaction. In particular, an echo must never make us delete the pending
// message: the queue has an ON DELETE CASCADE FK to that canonical row.
export async function finalizeSend(job, receipts) {
  const { data, error } = await sb.rpc('zalo_worker_finalize_send_v1', {
    p_job_id: job.id,
    p_instance_id: INSTANCE_ID,
    p_receipts: receipts,
  });
  if (error || data?.ok !== true || data?.status !== 'sent') {
    throw new Error(`Không ghi nhận được biên nhận gửi: ${error?.message || data?.reason || 'kết quả không hợp lệ'}`);
  }
}

export function sendReceipt(messageId, providerResult) {
  const providerId = providerResult?.msgId == null ? '' : String(providerResult.msgId).trim();
  if (!providerId) throw new Error(`PROVIDER_RECEIPT_MISSING: tin ${messageId} thiếu mã Zalo, cần đối soát`);
  return {
    message_id: messageId,
    zalo_msg_id: providerId,
    cli_msg_id: providerResult?.cliMsgId ? String(providerResult.cliMsgId) : null,
  };
}
