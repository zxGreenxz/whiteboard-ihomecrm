// Khối "Lương điều hành" trên trang lợi nhuận của chủ, đọc sổ lương điều hành (E10):
// được nhận (sau mốc) − đã trả − chờ duyệt = còn lại. Người nhận đã xoá mà còn số vẫn hiện (mờ,
// không nút Chi). Máy tính: bảng + Sổ phiếu + Mốc + Chi. Điện thoại: thẻ + Chi + sổ phiếu từ dưới lên
// (đặt mốc chỉ làm trên máy tính).

import { useState } from 'react';
import { Briefcase } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useProfitManagerLedger } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import { isProfitLedgerForbidden } from '@/lib/profitLedger/errors';
import type { ManagerLedgerRow } from '@/lib/profitLedger/ledgerReaders';
import { MANAGER_STATUS_LABEL, managerPayBlock, markerText } from '@/lib/profitLedger/ownerLedgerView';
import { RETIRED_MANAGER_NOTE } from '@/lib/profitOverviewCoverage';
import { profitLedgerRouteState } from '@/lib/profitLedger/route';
import { formatCurrency } from '@/lib/utils';
import ManagerSalaryPayoutDialog from './ManagerSalaryPayoutDialog';
import { ManagerPayoutsSheet } from './ManagerPayoutsSheet';
import { ProfitLedgerMarkerDialog, type ProfitLedgerMarkerSubject } from './ProfitLedgerMarkerDialog';
import { ProfitLedgerReadError } from './ProfitLedgerRouteBanner';
import { CARD, fmtShort } from './profitMobileShared';

export interface ManagerLedgerSectionProps {
  /** Công ty đang chọn (sổ lương điều hành theo công ty). */
  organizationId: string | null;
  /** shareholder_profit.pay_manager — chi, huỷ, đặt mốc lương điều hành. */
  canPayManager: boolean;
  variant: 'desktop' | 'mobile';
}

export function ManagerLedgerSection({ organizationId, canPayManager, variant }: ManagerLedgerSectionProps) {
  const query = useProfitManagerLedger(organizationId);
  const [payOpen, setPayOpen] = useState(false);
  const [payManager, setPayManager] = useState<string | null>(null);
  const [payoutsFor, setPayoutsFor] = useState<{ id: string; name: string } | null>(null);
  const [markerFor, setMarkerFor] = useState<ProfitLedgerMarkerSubject | null>(null);
  const ledger = query.data;
  const routeState = profitLedgerRouteState(ledger?.route);
  const mobile = variant === 'mobile';

  // Không có công ty / không được xem sổ lương điều hành ⇒ ẩn khối (như trước: chỉ hiện khi có người nhận).
  if (!organizationId) return null;
  if (query.isError && isProfitLedgerForbidden(query.error)) return null;
  if (ledger && ledger.managers.length === 0) return null;

  const openPay = (managerId: string | null) => { setPayManager(managerId); setPayOpen(true); };
  const rows = ledger?.managers ?? [];
  const hasDeleted = rows.some((row) => row.is_deleted);

  const body = query.isError ? (
    <ProfitLedgerReadError className={mobile ? 'm-3' : 'mx-[18px] my-3'} error={query.error} onRetry={() => { void query.refetch(); }} />
  ) : !ledger ? (
    <div className={mobile ? 'p-3' : 'px-[18px] py-3'}><Skeleton className="h-20 w-full" aria-label="Đang tải sổ lương điều hành" /></div>
  ) : mobile ? (
    rows.map((row) => (
      <MobileManagerRow
        key={row.manager_id}
        row={row}
        payBlock={managerPayBlock(row, routeState)}
        canPayManager={canPayManager}
        onOpen={() => setPayoutsFor({ id: row.manager_id, name: row.name })}
        onPay={() => openPay(row.manager_id)}
      />
    ))
  ) : (
    <div className="ph-tbl__scroll">
      <table className="ph-tbl" data-testid="manager-ledger-table">
        <thead>
          <tr>
            <th>Quản lý</th>
            <th>Mốc đã trả đủ</th>
            <th className="num">Được nhận (sau mốc)</th>
            <th className="num">Đã trả</th>
            <th className="num">Chờ duyệt</th>
            <th className="num">Còn lại</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const payBlock = managerPayBlock(row, routeState);
            return (
              <tr key={row.manager_id} data-testid={`manager-row-${row.manager_id}`} title={row.is_deleted ? RETIRED_MANAGER_NOTE : undefined} style={row.is_deleted ? { opacity: 0.6 } : undefined}>
                <td className="name">
                  {row.name}
                  <div className="flex flex-wrap gap-1">
                    {row.is_deleted && <span className="ph-state ph-state--muted">đã nghỉ</span>}
                    {!row.is_deleted && !row.is_active && <span className="ph-state ph-state--muted">đang ngưng</span>}
                  </div>
                </td>
                <td>{markerText(row.marker) ?? <span style={{ color: 'var(--ph-ink-4)' }}>—</span>}</td>
                <td className="num exp">{formatCurrency(row.allocated)}</td>
                <td className="num neg">{formatCurrency(row.payouts_approved)}</td>
                <td className="num">{formatCurrency(row.payouts_pending)}</td>
                <td className={`num strong${row.balance < 0 ? ' bad' : row.balance === 0 ? ' pos' : ''}`}>
                  {formatCurrency(Math.abs(row.balance))}
                  <div><span className={`ph-state${row.status === 'ADVANCE' ? ' ph-state--danger' : row.status === 'SETTLED' ? ' ph-state--muted' : ''}`}>{MANAGER_STATUS_LABEL[row.status]}</span></div>
                </td>
                <td className="num">
                  <div className="flex justify-end gap-1">
                    <Button type="button" className="ph-mini-btn" onClick={() => setPayoutsFor({ id: row.manager_id, name: row.name })}>Sổ phiếu</Button>
                    {canPayManager && (
                      <Button
                        type="button"
                        className="ph-mini-btn"
                        disabled={!routeState.canSetMarker}
                        title={routeState.canSetMarker ? undefined : 'Chỉ đặt mốc khi sổ tổng mở phần đặt mốc đã trả đủ.'}
                        onClick={() => setMarkerFor({ id: row.manager_id, name: row.name, marker: row.marker })}
                      >
                        Mốc
                      </Button>
                    )}
                    {canPayManager && !row.is_deleted && (
                      <Button type="button" className="ph-mini-btn" disabled={payBlock !== null} title={payBlock ?? undefined} onClick={() => openPay(row.manager_id)}>
                        Chi
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      {mobile ? (
        <div className={`${CARD} overflow-hidden`} data-testid="manager-ledger-section">
          <div className="flex items-center gap-2 border-b border-[#efece4] px-3 py-3">
            <Briefcase className="h-3.5 w-3.5 text-[#c2570f]" />
            <span className="text-[12.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">Lương điều hành</span>
            <span className="text-[10.5px] font-semibold text-[#8d8678]">còn lại sau mốc</span>
          </div>
          {body}
          {hasDeleted && <p className="m-0 px-3 py-2 text-[10.5px] font-semibold text-[#8d8678]">{RETIRED_MANAGER_NOTE}</p>}
        </div>
      ) : (
        <div className="ph-card" data-testid="manager-ledger-section">
          <div className="ph-card__head">
            <div className="ph-card__title">Lương điều hành</div>
            {canPayManager && (
              <div className="ph-card__push">
                <Button
                  className="ph-control ph-control--strong"
                  disabled={!ledger || !routeState.canPayManager}
                  title={ledger && !routeState.canPayManager ? 'Sổ tổng đang đóng băng — tạm khoá chi lương điều hành.' : undefined}
                  onClick={() => openPay(null)}
                >
                  ＋ Chi lương điều hành
                </Button>
              </div>
            )}
          </div>
          {body}
          {hasDeleted && <div className="ph-hint" style={{ padding: '0 18px 12px' }}>{RETIRED_MANAGER_NOTE}</div>}
        </div>
      )}
      <ManagerSalaryPayoutDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        organizationId={organizationId}
        ledger={ledger}
        defaultManagerId={payManager}
      />
      <ManagerPayoutsSheet
        open={!!payoutsFor}
        onOpenChange={(next) => { if (!next) setPayoutsFor(null); }}
        organizationId={organizationId}
        manager={payoutsFor}
        route={ledger?.route}
        canPayManager={canPayManager}
        compact={mobile}
      />
      {!mobile && (
        <ProfitLedgerMarkerDialog
          open={!!markerFor}
          onOpenChange={(next) => { if (!next) setMarkerFor(null); }}
          organizationId={organizationId}
          subjectKind="MANAGER"
          subject={markerFor}
        />
      )}
    </>
  );
}

function MobileManagerRow({ row, payBlock, canPayManager, onOpen, onPay }: {
  row: ManagerLedgerRow;
  payBlock: string | null;
  canPayManager: boolean;
  onOpen: () => void;
  onPay: () => void;
}) {
  return (
    <div
      data-testid={`manager-row-${row.manager_id}`}
      className={`flex items-center gap-2.5 border-b border-[#f4f1ea] px-3 py-2.5 last:border-b-0 ${row.is_deleted ? 'bg-[#faf8f4]' : ''}`}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="flex items-center gap-1.5 text-[13px] font-extrabold text-[#1b1813]">
          <span className="truncate">{row.name}</span>
          {row.is_deleted && (
            <span className="shrink-0 rounded-[5px] border border-[#e7e3da] bg-white px-1 py-px text-[9.5px] font-bold text-[#8d8678]">đã nghỉ</span>
          )}
        </span>
        <span className="text-[10.5px] font-semibold text-[#8d8678]">
          Được nhận <b className="font-mono text-[#c2570f]">{fmtShort(row.allocated)}</b> · Đã trả{' '}
          <b className="font-mono text-[#c97a10]">{fmtShort(row.payouts_approved)}</b>
          {row.payouts_pending !== 0 && <> · Chờ duyệt <b className="font-mono">{fmtShort(row.payouts_pending)}</b></>}
        </span>
      </button>
      <div className="flex shrink-0 flex-col items-end">
        <span className={`font-mono text-[13.5px] font-bold tracking-[-0.3px] ${row.balance < 0 ? 'text-[#d6453f]' : 'text-[#1b1813]'}`}>
          {fmtShort(Math.abs(row.balance))}
        </span>
        <span className="text-[9.5px] font-semibold text-[#b6b0a3]">{MANAGER_STATUS_LABEL[row.status].toLowerCase()}</span>
      </div>
      {canPayManager && !row.is_deleted && (
        <button
          type="button"
          onClick={onPay}
          disabled={payBlock !== null}
          title={payBlock ?? undefined}
          className="shrink-0 rounded-[9px] border border-[#f3d6c4] bg-[#fdf0e8] px-3 py-[7px] text-[11.5px] font-bold text-[#c2570f] active:scale-95 disabled:opacity-50"
        >
          Chi
        </button>
      )}
    </div>
  );
}

export default ManagerLedgerSection;
