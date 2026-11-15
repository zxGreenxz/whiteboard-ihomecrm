// "Sổ chi tiết" một cổ đông (E2): từng khoản được chia / phiếu chi / phần trả qua lương, số dư chạy.
// Dòng nằm trước mốc hiện mờ (không vào số dư). Phiếu chi lập theo sổ tổng còn huỷ được có nút Huỷ
// (hộp huỷ dùng chung, có lý do). Phiếu lương "cần xem lại" có nút "Xác nhận phần lương" (máy tính).
// Điện thoại (`compact`): mở từ dưới lên, chỉ xem + huỷ — xác nhận phần lương làm trên máy tính.

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useShareholderProfitLedgerEntries } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import type { ShareholderLedgerEntries, ShareholderLedgerEntry } from '@/lib/profitLedger/ledgerReaders';
import {
  canCancelLedgerEntry, LEDGER_ENTRY_KIND_LABEL, ledgerBalanceText, ledgerMonthLabel, markerText,
  SHAREHOLDER_STATUS_LABEL, voucherStateLabel,
} from '@/lib/profitLedger/ownerLedgerView';
import { profitLedgerRouteState, type ProfitLedgerRoute } from '@/lib/profitLedger/route';
import { cancelTargetFromLedgerEntry, type ProfitPayoutCancelTarget } from '@/lib/profitLedger/vouchers';
import { cn, formatDate, formatVND } from '@/lib/utils';
import { ProfitPayoutCancelDialog } from './ProfitPayoutCancelDialog';
import { ProfitLedgerReadError, ProfitLedgerRouteBanner } from './ProfitLedgerRouteBanner';
import { SalaryProfitResolveDialog } from './SalaryProfitResolveDialog';

export interface ShareholderLedgerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Công ty của sổ tổng. */
  organizationId: string | null;
  shareholder: { id: string; name: string } | null;
  /** Trạng thái sổ tổng theo E1 (undefined = chưa biết ⇒ đóng an toàn như LEGACY). */
  route: ProfitLedgerRoute | undefined;
  /** Quyền chi lợi nhuận: huỷ mọi phiếu + xác nhận phần lương. */
  canDistribute: boolean;
  /** Điện thoại: sheet từ dưới lên, ẩn "Xác nhận phần lương". */
  compact?: boolean;
}

const signed = (amount: number): string => (amount > 0 ? `+${formatVND(amount)}` : amount < 0 ? `−${formatVND(-amount)}` : formatVND(0));

function entryWhen(entry: ShareholderLedgerEntry): string {
  if (entry.kind === 'PAYOUT' && entry.voucher_date) return formatDate(entry.voucher_date);
  if (entry.period_month) return `kỳ ${ledgerMonthLabel(entry.period_month)}`;
  return formatDate(entry.created_at);
}

function entryDetail(entry: ShareholderLedgerEntry): string {
  switch (entry.kind) {
    case 'ALLOCATION': return entry.building_name ?? '—';
    case 'PAYOUT':
      return [entry.voucher_code, entry.account_name ? `sổ ${entry.account_name}` : null].filter(Boolean).join(' · ') || '—';
    case 'SALARY_REVIEW':
      return [entry.voucher_code, entry.suggested !== null ? `máy gợi ý ${formatVND(entry.suggested)}` : null].filter(Boolean).join(' · ') || '—';
    default:
      return entry.voucher_code ? `phiếu lương ${entry.voucher_code}` : '—';
  }
}

export function ShareholderLedgerSheet({
  open, onOpenChange, organizationId, shareholder, route, canDistribute, compact = false,
}: ShareholderLedgerSheetProps) {
  const query = useShareholderProfitLedgerEntries(open ? organizationId : null, shareholder?.id ?? null);
  const routeState = profitLedgerRouteState(route);
  const [cancelTarget, setCancelTarget] = useState<ProfitPayoutCancelTarget | null>(null);
  const [resolveEntry, setResolveEntry] = useState<ShareholderLedgerEntry | null>(null);
  const data = query.data;
  const name = data?.shareholder.name ?? shareholder?.name ?? null;

  const actionFor = (entry: ShareholderLedgerEntry) => {
    if (entry.kind === 'PAYOUT') {
      const target = organizationId
        ? cancelTargetFromLedgerEntry(entry, { organizationId, subjectName: name })
        : null;
      if (target && routeState.canCancel && canCancelLedgerEntry(entry, canDistribute)) {
        return (
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setCancelTarget(target)}>
            Huỷ
          </Button>
        );
      }
      // Phiếu cũ (lập trước sổ tổng) không có dòng sổ: huỷ theo đường cũ ở Thu chi.
      if (!entry.maker_user_id) return <span className="text-xs text-muted-foreground">phiếu cũ — huỷ ở Thu chi</span>;
      return null;
    }
    if (entry.kind === 'SALARY_REVIEW' && !compact && canDistribute && routeState.canResolveSalary && entry.line_id) {
      return (
        <Button type="button" size="sm" className="h-7 px-2 text-xs" onClick={() => setResolveEntry(entry)}>
          Xác nhận phần lương
        </Button>
      );
    }
    return null;
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side={compact ? 'bottom' : 'right'}
          className={compact ? 'max-h-[88vh] overflow-y-auto rounded-t-2xl px-3 pb-6' : 'w-full overflow-y-auto sm:max-w-3xl'}
        >
          <SheetHeader className="pr-6 text-left">
            <SheetTitle>Sổ chi tiết · {name ?? '—'}</SheetTitle>
            <SheetDescription>Từng khoản được chia, đã chi và trả qua lương; số dư cộng dồn theo thời điểm vào sổ.</SheetDescription>
          </SheetHeader>
          <div className="mt-3 space-y-3">
            <ProfitLedgerRouteBanner route={route} />
            {query.isError ? (
              <ProfitLedgerReadError error={query.error} onRetry={() => { void query.refetch(); }} />
            ) : !data ? (
              <div className="space-y-2" aria-busy="true" aria-label="Đang tải sổ chi tiết">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : (
              <>
                <LedgerTotals data={data} compact={compact} />
                {data.entries.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Chưa có khoản nào trong sổ.</p>
                ) : compact ? (
                  <ul className="divide-y rounded-md border" data-testid="ledger-entries">
                    {data.entries.map((entry) => (
                      <li
                        key={entry.key}
                        data-testid={`ledger-entry-${entry.key}`}
                        data-excluded={entry.excluded_by_marker ? 'true' : undefined}
                        className={cn('flex items-start gap-2 px-3 py-2.5 text-sm', entry.excluded_by_marker && 'opacity-50')}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold">{LEDGER_ENTRY_KIND_LABEL[entry.kind]} <EntryChips entry={entry} /></div>
                          <p className="truncate text-xs text-muted-foreground">{entryWhen(entry)} · {entryDetail(entry)}</p>
                          {entry.kind === 'PAYOUT' && (
                            <p className="text-xs text-muted-foreground">{voucherStateLabel(entry.voucher_status, entry.posting_status)}</p>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <p className={cn('font-mono font-semibold', entry.amount < 0 ? 'text-amber-700' : 'text-emerald-700')}>{signed(entry.amount)}</p>
                          <p className="font-mono text-xs text-muted-foreground">{ledgerBalanceText(entry.running_balance)}</p>
                          <div className="mt-1">{actionFor(entry)}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm" data-testid="ledger-entries">
                      <thead className="bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-2 py-2 text-left font-medium">Ngày / kỳ</th>
                          <th className="px-2 py-2 text-left font-medium">Khoản</th>
                          <th className="px-2 py-2 text-left font-medium">Chi tiết</th>
                          <th className="px-2 py-2 text-right font-medium">Số tiền</th>
                          <th className="px-2 py-2 text-right font-medium">Số dư</th>
                          <th className="px-2 py-2 text-left font-medium">Trạng thái</th>
                          <th className="px-2 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {data.entries.map((entry) => (
                          <tr
                            key={entry.key}
                            data-testid={`ledger-entry-${entry.key}`}
                            data-excluded={entry.excluded_by_marker ? 'true' : undefined}
                            className={cn('border-t align-top', entry.excluded_by_marker && 'opacity-50')}
                          >
                            <td className="whitespace-nowrap px-2 py-2">{entryWhen(entry)}</td>
                            <td className="px-2 py-2">{LEDGER_ENTRY_KIND_LABEL[entry.kind]} <EntryChips entry={entry} /></td>
                            <td className="px-2 py-2 text-muted-foreground">{entryDetail(entry)}</td>
                            <td className={cn('whitespace-nowrap px-2 py-2 text-right font-mono', entry.amount < 0 ? 'text-amber-700' : 'text-emerald-700')}>
                              {signed(entry.amount)}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-right font-mono">{ledgerBalanceText(entry.running_balance)}</td>
                            <td className="px-2 py-2 text-xs">
                              {entry.kind === 'PAYOUT' ? voucherStateLabel(entry.voucher_status, entry.posting_status) : ''}
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-right">{actionFor(entry)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <ProfitPayoutCancelDialog
        open={!!cancelTarget}
        onOpenChange={(next) => { if (!next) setCancelTarget(null); }}
        target={cancelTarget}
      />
      {!compact && (
        <SalaryProfitResolveDialog
          open={!!resolveEntry}
          onOpenChange={(next) => { if (!next) setResolveEntry(null); }}
          organizationId={organizationId}
          shareholderId={shareholder?.id ?? null}
          entry={resolveEntry}
          shareholderName={name}
        />
      )}
    </>
  );
}

function EntryChips({ entry }: { entry: ShareholderLedgerEntry }) {
  return (
    <>
      {entry.is_advance && <Badge variant="destructive" className="ml-1 px-1.5 py-0 text-[10px]">tạm ứng</Badge>}
      {entry.excluded_by_marker && <Badge variant="outline" className="ml-1 px-1.5 py-0 text-[10px]">trước mốc</Badge>}
    </>
  );
}

function LedgerTotals({ data, compact }: { data: ShareholderLedgerEntries; compact: boolean }) {
  const { totals } = data;
  const excluded = totals.excluded_before_marker;
  const hasExcluded = excluded.allocated !== 0 || excluded.payouts !== 0 || excluded.salary !== 0;
  const marker = markerText(data.marker);
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-sm" data-testid="ledger-totals">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-muted-foreground">{SHAREHOLDER_STATUS_LABEL[totals.status]}</span>
        <strong className={cn('font-mono text-lg', totals.balance < 0 && 'text-destructive')}>{formatVND(Math.abs(totals.balance))}</strong>
        {data.shareholder.is_deleted && <Badge variant="outline">đã xoá</Badge>}
      </div>
      <div className={cn('grid gap-x-4 gap-y-1', compact ? 'grid-cols-2' : 'grid-cols-4')}>
        <span>Được chia: <b className="font-mono">{formatVND(totals.allocated)}</b></span>
        <span>Đã chi: <b className="font-mono">{formatVND(totals.payouts_approved)}</b></span>
        <span>Chờ duyệt: <b className="font-mono">{formatVND(totals.payouts_pending)}</b></span>
        <span>Qua lương: <b className="font-mono">{formatVND(totals.salary_investment - totals.salary_advance_offset)}</b></span>
      </div>
      <p className="text-muted-foreground">Mốc đã trả đủ: {marker ?? 'chưa có'}</p>
      {hasExcluded && (
        <p className="text-muted-foreground">
          Trước mốc (không tính): được chia {formatVND(excluded.allocated)} · đã chi {formatVND(excluded.payouts)} · qua lương {formatVND(excluded.salary)}.
        </p>
      )}
      {totals.needs_review.count > 0 && (
        <p className="font-medium text-amber-700">
          {totals.needs_review.count} phiếu lương cần chủ xem lại phần lợi nhuận (máy gợi ý {formatVND(totals.needs_review.suggested)}) — chưa chi lợi nhuận được tới khi xác nhận.
        </p>
      )}
    </div>
  );
}

export default ShareholderLedgerSheet;
