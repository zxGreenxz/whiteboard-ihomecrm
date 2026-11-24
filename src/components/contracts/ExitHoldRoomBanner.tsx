import { AlertTriangle } from 'lucide-react';
import { useContractExitEarlyTerms } from '@/hooks/contracts/useContractExitEarlyTerms';
import { EARLY_REASON_LABELS, contractNumberLabel, isTransferReason, type ContractExitEarlyTerms } from '@/lib/contractExitEarlyTerms';
import { formatISODateVN } from '@/lib/vnDate';
import { cn } from '@/lib/utils';

export type ExitHoldRoomBannerVariant = 'contract' | 'deposit';

interface ExitHoldRoomBannerProps {
  roomId: string | null | undefined;
  variant: ExitHoldRoomBannerVariant;
  /** Ngày bắt đầu hợp đồng đang nhập: máy chủ chỉ tự nối hợp đồng bắt đầu từ ngày khách cũ trả phòng trở đi. */
  startDate?: string | null;
  enabled?: boolean;
  className?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Hồ sơ còn chờ nối mà máy chủ sẽ nối trước: cũ nhất trước, cùng thứ tự trigger tự nối. */
function pendingExitHold(rows: readonly ContractExitEarlyTerms[] | null | undefined) {
  return rows?.filter(row => row.pending_link && isTransferReason(row.early_reason))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.exit_case_id.localeCompare(b.exit_case_id))[0];
}

function exitHoldRoomMessages(terms: ContractExitEarlyTerms, variant: ExitHoldRoomBannerVariant, startDate?: string | null) {
  const moveOut = formatISODateVN(terms.actual_move_out_on);
  const saleName = terms.early_reason === 'SALE_ASSISTED' ? terms.sale_name?.trim() : '';
  const facts = [
    terms.old_customer_name?.trim() && `khách cũ ${terms.old_customer_name.trim()}`,
    terms.old_contract_number?.trim() && contractNumberLabel(terms.old_contract_number),
    `${EARLY_REASON_LABELS[terms.early_reason]}${saleName ? ` — sale ${saleName}` : ''}`,
  ].filter(Boolean).join(', ');
  const head = `Phòng đang chờ khách sang nhượng từ ${moveOut} (${facts}).`;
  const selfFound = terms.early_reason === 'SELF_FOUND';
  if (variant === 'deposit') return [head, 'Khách cọc phòng này là khách nhận; hợp đồng tạo sau sẽ tự nối với hồ sơ cũ.',
    ...(selfFound ? ['Ca khách tự tìm: hợp đồng khách nhận không có hoa hồng môi giới hay thưởng sale.'] : [])];
  if (startDate && ISO_DATE.test(startDate) && startDate < terms.actual_move_out_on)
    return [head, `Ngày bắt đầu đang trước ${moveOut}: hợp đồng chỉ tự nối với hồ sơ cũ khi bắt đầu từ ngày này.`];
  return [head, 'Hợp đồng này sẽ tự nối với hồ sơ cũ.', selfFound
    ? 'Hợp đồng nối với ca khách tự tìm: không có hoa hồng môi giới hay thưởng sale.'
    : 'Hoa hồng môi giới cho sale lập sau khi quyết toán khách cũ.'];
}

/**
 * Băng báo phòng đang giữ cho khách sang nhượng (trả phòng trước hạn: nhờ sale / tự tìm khách sang phòng). Dùng ở
 * form tạo hợp đồng và hộp tạo cọc. Đang đọc: không vẽ; không có quyền đọc hồ sơ trả phòng (42501): không vẽ;
 * lỗi khác: một dòng nhỏ kèm Thử lại.
 */
export function ExitHoldRoomBanner({ roomId, variant, startDate, enabled = true, className }: ExitHoldRoomBannerProps) {
  const active = enabled && !!roomId;
  const query = useContractExitEarlyTerms(roomId ? { roomId } : null, active);
  if (!active) return null;
  if (query.isError) {
    if ((query.error as { code?: string } | null)?.code === '42501') return null;
    return <p role="status" className={cn('text-xs text-muted-foreground', className)}>
      Chưa kiểm được phòng có đang chờ khách sang nhượng không.{' '}
      <button type="button" className="underline underline-offset-2" onClick={() => void query.refetch()}>Thử lại</button>
    </p>;
  }
  const terms = pendingExitHold(query.data);
  if (!terms) return null;
  const [head, ...rest] = exitHoldRoomMessages(terms, variant, startDate);
  return <div role="status" aria-label="Phòng đang chờ khách sang nhượng"
    className={cn('flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100', className)}>
    <AlertTriangle className="mt-px h-4 w-4 shrink-0" aria-hidden />
    <div className="min-w-0 space-y-1 break-words">
      <p className="font-medium">{head}</p>
      {rest.map(line => <p key={line}>{line}</p>)}
    </div>
  </div>;
}
