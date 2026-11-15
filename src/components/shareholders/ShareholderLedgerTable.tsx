// Bảng "Sổ tổng theo cổ đông" (E1) trên trang lợi nhuận của chủ (máy tính): mốc, được chia sau mốc,
// đã chi, chờ duyệt, qua lương, còn phải trả / đang tạm ứng. Cổ đông đã xoá còn số vẫn hiện (mờ,
// không nút Chi). Nút Chi khoá theo trạng thái sổ tổng và khi còn phiếu lương cần xem lại.

import { Button } from '@/components/ui/button';
import type { ShareholderLedgerRow } from '@/lib/profitLedger/ledgerReaders';
import {
  markerText, salaryNet, SHAREHOLDER_STATUS_LABEL, shareholderPayBlock, summarizeShareholderLedger,
} from '@/lib/profitLedger/ownerLedgerView';
import type { ProfitLedgerRouteState } from '@/lib/profitLedger/route';
import { formatCurrency } from '@/lib/utils';

export interface ShareholderLedgerTableProps {
  rows: readonly ShareholderLedgerRow[];
  routeState: ProfitLedgerRouteState;
  /** Quyền chi lợi nhuận (shareholder_profit.distribute): nút Chi + Mốc. */
  canDistribute: boolean;
  /** Cổ đông đang lọc ở thanh công cụ (null = tất cả). */
  selectedId: string | null;
  onSelect: (shareholderId: string | null) => void;
  onOpenEntries: (row: ShareholderLedgerRow) => void;
  onPay: (row: ShareholderLedgerRow) => void;
  onMarker: (row: ShareholderLedgerRow) => void;
}

const STATUS_CLASS: Record<ShareholderLedgerRow['status'], string> = {
  OWED: 'ph-state',
  SETTLED: 'ph-state ph-state--muted',
  ADVANCE: 'ph-state ph-state--danger',
};

export function ShareholderLedgerTable({
  rows, routeState, canDistribute, selectedId, onSelect, onOpenEntries, onPay, onMarker,
}: ShareholderLedgerTableProps) {
  const sum = summarizeShareholderLedger(rows);
  const markerTitle = routeState.canSetMarker ? undefined : 'Chỉ đặt mốc khi sổ tổng mở phần đặt mốc đã trả đủ.';
  return (
    <div className="ph-tbl__scroll">
      <table className="ph-tbl" data-testid="shareholder-ledger-table">
        <thead>
          <tr>
            <th>Cổ đông</th>
            <th>Mốc đã trả đủ</th>
            <th className="num">Được chia (sau mốc)</th>
            <th className="num">Đã chi</th>
            <th className="num">Chờ duyệt</th>
            <th className="num">Qua lương</th>
            <th className="num">Còn phải trả / tạm ứng</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--ph-ink-4)' }}>Chưa có cổ đông</td></tr>
          )}
          {rows.map((row) => {
            const active = selectedId === row.shareholder_id;
            const payBlock = shareholderPayBlock(row, routeState);
            const net = salaryNet(row);
            return (
              <tr
                key={row.shareholder_id}
                data-testid={`ledger-row-${row.shareholder_id}`}
                className={active ? 'is-current' : undefined}
                style={row.is_deleted ? { opacity: 0.6 } : undefined}
              >
                <td className="name">
                  {row.is_deleted ? (
                    <span>{row.name}</span>
                  ) : (
                    <button type="button" className="ph-row__link" onClick={() => onSelect(active ? null : row.shareholder_id)}>
                      {row.name}
                    </button>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {row.is_deleted && <span className="ph-state ph-state--muted">đã xoá</span>}
                    {!row.is_deleted && !row.is_active && <span className="ph-state ph-state--muted">đang ngưng</span>}
                    {!row.has_login && <span className="ph-state ph-state--muted">chưa có tài khoản</span>}
                    {row.needs_review_count > 0 && (
                      <span className="ph-state ph-state--warn">cần xem lại ({row.needs_review_count})</span>
                    )}
                  </div>
                </td>
                <td>{markerText(row.marker) ?? <span style={{ color: 'var(--ph-ink-4)' }}>—</span>}</td>
                <td className="num pos">{formatCurrency(row.allocated)}</td>
                <td className="num neg">{formatCurrency(row.payouts_approved)}</td>
                <td className="num">{formatCurrency(row.payouts_pending)}</td>
                <td
                  className="num"
                  title={row.salary_advance_offset !== 0
                    ? `Trả qua lương ${formatCurrency(row.salary_investment)} − lương bù tạm ứng ${formatCurrency(row.salary_advance_offset)}`
                    : undefined}
                >
                  {formatCurrency(net)}
                </td>
                <td className={`num strong${row.balance < 0 ? ' bad' : ''}`}>
                  {formatCurrency(Math.abs(row.balance))}
                  <div><span className={STATUS_CLASS[row.status]}>{SHAREHOLDER_STATUS_LABEL[row.status]}</span></div>
                </td>
                <td className="num">
                  <div className="flex justify-end gap-1">
                    <Button type="button" className="ph-mini-btn" onClick={() => onOpenEntries(row)}>Sổ</Button>
                    {canDistribute && (
                      <Button type="button" className="ph-mini-btn" disabled={!routeState.canSetMarker} title={markerTitle} onClick={() => onMarker(row)}>
                        Mốc
                      </Button>
                    )}
                    {canDistribute && !row.is_deleted && (
                      <Button type="button" className="ph-mini-btn" disabled={payBlock !== null} title={payBlock ?? undefined} onClick={() => onPay(row)}>
                        Chi
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr>
              <td>Tổng</td>
              <td />
              <td className="num pos">{formatCurrency(sum.allocated)}</td>
              <td className="num neg">{formatCurrency(sum.approved)}</td>
              <td className="num">{formatCurrency(sum.pending)}</td>
              <td className="num">{formatCurrency(sum.viaSalary)}</td>
              <td className="num" style={{ fontWeight: 800 }}>
                {formatCurrency(sum.owed)}
                {sum.advance > 0 && <div className="bad" style={{ fontWeight: 600 }}>tạm ứng {formatCurrency(sum.advance)}</div>}
              </td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export default ShareholderLedgerTable;
