// "Sổ phiếu" lương điều hành của một người nhận: mọi phiếu (chờ duyệt, đã duyệt, đã chi, đã huỷ).
// Phiếu lập theo sổ tổng (`profit.manager_salary`) huỷ bằng hộp huỷ có lý do; phiếu cũ huỷ theo
// đường cũ ở Thu chi (chỉ ghi chú, không nút).

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useManagerLedgerPayouts } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import { cancelTargetFromManagerPayout, voucherStateLabel } from '@/lib/profitLedger/ownerLedgerView';
import { profitLedgerRouteState, type ProfitLedgerRoute } from '@/lib/profitLedger/route';
import type { ProfitPayoutCancelTarget } from '@/lib/profitLedger/vouchers';
import { cn, formatVND } from '@/lib/utils';
import { formatISODateVN } from '@/lib/vnDate';
import { ProfitPayoutCancelDialog } from './ProfitPayoutCancelDialog';
import { ProfitLedgerReadError } from './ProfitLedgerRouteBanner';

export interface ManagerPayoutsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string | null;
  manager: { id: string; name: string } | null;
  route: ProfitLedgerRoute | undefined;
  /** Quyền chi lương quản lý (shareholder_profit.pay_manager) — cũng là quyền huỷ phiếu lương điều hành. */
  canPayManager: boolean;
  compact?: boolean;
}

export function ManagerPayoutsSheet({
  open, onOpenChange, organizationId, manager, route, canPayManager, compact = false,
}: ManagerPayoutsSheetProps) {
  const query = useManagerLedgerPayouts(open ? organizationId : null, manager?.id ?? null);
  const routeState = profitLedgerRouteState(route);
  const [cancelTarget, setCancelTarget] = useState<ProfitPayoutCancelTarget | null>(null);
  const payouts = query.data;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side={compact ? 'bottom' : 'right'}
          className={compact ? 'max-h-[88vh] overflow-y-auto rounded-t-2xl px-3 pb-6' : 'w-full overflow-y-auto sm:max-w-xl'}
        >
          <SheetHeader className="pr-6 text-left">
            <SheetTitle>Phiếu lương điều hành · {manager?.name ?? '—'}</SheetTitle>
            <SheetDescription>Mọi phiếu chi lương điều hành của người này, mới nhất trước.</SheetDescription>
          </SheetHeader>
          <div className="mt-3">
            {query.isError ? (
              <ProfitLedgerReadError error={query.error} onRetry={() => { void query.refetch(); }} />
            ) : !payouts ? (
              <Skeleton className="h-32 w-full" aria-label="Đang tải phiếu lương điều hành" />
            ) : payouts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Chưa có phiếu lương điều hành nào.</p>
            ) : (
              <ul className="divide-y rounded-md border" data-testid="manager-payouts">
                {payouts.map((payout) => {
                  const target = organizationId
                    ? cancelTargetFromManagerPayout(payout, { organizationId, subjectName: manager?.name ?? null })
                    : null;
                  const cancelled = payout.approval_status === 'CANCELLED';
                  return (
                    <li
                      key={payout.id}
                      data-testid={`manager-payout-${payout.id}`}
                      className={cn('flex items-start gap-2 px-3 py-2.5 text-sm', cancelled && 'opacity-60')}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold">
                          {payout.code ?? 'Phiếu chưa có mã'}
                          {!payout.is_ledger_voucher && <Badge variant="outline" className="ml-1 px-1.5 py-0 text-[10px]">phiếu cũ</Badge>}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {formatISODateVN(payout.voucher_date)}{payout.account_name ? ` · sổ ${payout.account_name}` : ''}
                        </p>
                        <p className="text-xs text-muted-foreground">{voucherStateLabel(payout.approval_status, payout.posting_status)}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-mono font-semibold">{formatVND(payout.total_amount)}</p>
                        <div className="mt-1">
                          {target && canPayManager && routeState.canCancel ? (
                            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setCancelTarget(target)}>
                              Huỷ
                            </Button>
                          ) : !payout.is_ledger_voucher && !cancelled ? (
                            <span className="text-xs text-muted-foreground">phiếu cũ — huỷ theo đường cũ ở Thu chi</span>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <ProfitPayoutCancelDialog
        open={!!cancelTarget}
        onOpenChange={(next) => { if (!next) setCancelTarget(null); }}
        target={cancelTarget}
      />
    </>
  );
}

export default ManagerPayoutsSheet;
