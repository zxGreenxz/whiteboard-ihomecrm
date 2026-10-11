import type { ContractCommissionFollowup } from '@/lib/contractCommissionFollowup';

/** Immutable server evidence belongs to the saved request, not the retrying actor. */
export function CommissionRequestEvidence({ row }: { row: ContractCommissionFollowup | undefined }) {
  const evidence = row?.preparation;
  if (!row?.can_manage || !evidence || evidence.request_id !== row.request_id) return null;
  return <div className="space-y-1 text-xs" aria-label="Thông tin lập yêu cầu đã lưu">
    <p>{evidence.stage === 'REPREPARE' ? 'Lập lại yêu cầu' : 'Lập yêu cầu'} · {evidence.actor_name || 'Chưa xác định người thực hiện'} · {new Date(evidence.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</p>
    <p className="break-words">{evidence.reason ? `Lý do đã lưu: ${evidence.reason}` : 'Không có lý do điều chỉnh được ghi nhận.'}</p>
  </div>;
}
