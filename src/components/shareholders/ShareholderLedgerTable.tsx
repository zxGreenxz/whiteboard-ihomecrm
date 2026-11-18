// Bảng "Sổ tổng theo cổ đông" trên trang lợi nhuận của chủ (máy tính): mốc, được chia sau mốc, đã chi,
// chờ duyệt, qua lương (E1) và HAI con số của vị thế (R1): "Lợi nhuận chưa chi" · "Tạm ứng đang có".
// Cổ đông đã xoá còn số vẫn hiện (mờ, không nút Chi). Nút Chi mở hộp CHỐT chi lợi nhuận; khoá theo trạng
// thái sổ tổng và khi còn phiếu lương cần xem lại.

import { Button } from '@/components/ui/button';
import type { ShareholderLedgerRow } from '@/lib/profitLedger/ledgerReaders';
import {
  markerText, salaryNet, shareholderPayBlock, summarizeShareholderLedger,
} from '@/lib/profitLedger/ownerLedgerView';
import type { ShareholderPositionRow } from '@/lib/profitLedger/positionReaders';
import {
  advancePendingText, isUnpaidNegative, POSITION_EXPLAIN, POSITION_LABELS, settlementCashPendingText, summarizePositions,
  UNPAID_NEGATIVE_NOTE,
} from '@/lib/profitLedger/positionView';
import type { ProfitLedgerRouteState } from '@/lib/profitLedger/route';
import { formatCurrency } from '@/lib/utils';

export interface ShareholderLedgerTableProps {
  rows: readonly ShareholderLedgerRow[];
  /** Vị thế của từng cổ đông (R1); null = chưa có (đang tải hoặc lỗi — ô hiện "…" / "—", KHÔNG hiện 0). */
  positions: readonly ShareholderPositionRow[] | null;
  /** R1 đang tải lần đầu. */
  positionsPending: boolean;
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

const MUTED = { color: 'var(--ph-ink-4)' } as const;

export function ShareholderLedgerTable({
  rows, positions, positionsPending, routeState, canDistribute, selectedId, onSelect, onOpenEntries, onPay, onMarker,
}: ShareholderLedgerTableProps) {
  const sum = summarizeShareholderLedger(rows);
  const positionById = new Map((positions ?? []).map((row) => [row.shareholder_id, row] as const));
  const listed = rows.flatMap((row) => { const p = positionById.get(row.shareholder_id); return p ? [p] : []; });
  // Tổng chỉ hiện khi MỌI cổ đông trong bảng đều có vị thế (thiếu một người là tổng sai).
  const positionSum = positions && listed.length === rows.length ? summarizePositions(listed) : null;
  const missing = positionsPending ? '…' : '—';
  const markerTitle = routeState.canSetMarker ? undefined : 'Chỉ đặt mốc khi sổ tổng mở phần đặt mốc đã trả đủ.';
  return (
    <>
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
              <th className="num">{POSITION_LABELS.unpaid}</th>
              <th className="num">{POSITION_LABELS.advance}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: 'center', ...MUTED }}>Chưa có cổ đông</td></tr>
            )}
            {rows.map((row) => {
              const active = selectedId === row.shareholder_id;
              const payBlock = shareholderPayBlock(row, routeState);
              const net = salaryNet(row);
              const position = positionById.get(row.shareholder_id) ?? null;
              const cashPending = position ? settlementCashPendingText(position, formatCurrency) : null;
              const advancePending = position ? advancePendingText(position, formatCurrency) : null;
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
                      {position?.has_advance_right && <span className="ph-state ph-state--muted">được tạm ứng</span>}
                      {row.needs_review_count > 0 && (
                        <span className="ph-state ph-state--warn">cần xem lại ({row.needs_review_count})</span>
                      )}
                    </div>
                  </td>
                  <td>{markerText(row.marker) ?? <span style={MUTED}>—</span>}</td>
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
                  <td
                    className={`num strong${position && isUnpaidNegative(position) ? ' bad' : ''}`}
                    data-testid={`ledger-unpaid-${row.shareholder_id}`}
                    title={position && isUnpaidNegative(position) ? UNPAID_NEGATIVE_NOTE : undefined}
                  >
                    {position ? formatCurrency(position.unpaid_profit) : <span style={MUTED}>{missing}</span>}
                    {cashPending && <div><span className="ph-state ph-state--muted">{cashPending}</span></div>}
                  </td>
                  <td className="num strong" data-testid={`ledger-advance-${row.shareholder_id}`}>
                    {position ? formatCurrency(position.advance_outstanding) : <span style={MUTED}>{missing}</span>}
                    {advancePending && <div><span className="ph-state ph-state--warn">{advancePending}</span></div>}
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
                <td className="num" style={{ fontWeight: 800 }} data-testid="ledger-unpaid-total">
                  {positionSum ? formatCurrency(positionSum.unpaid) : <span style={MUTED}>{missing}</span>}
                </td>
                <td className="num" style={{ fontWeight: 800 }} data-testid="ledger-advance-total">
                  {positionSum ? formatCurrency(positionSum.advance) : <span style={MUTED}>{missing}</span>}
                  {positionSum && positionSum.advancePending !== 0 && (
                    <div style={{ fontWeight: 600 }}>chờ duyệt {formatCurrency(positionSum.advancePending)}</div>
                  )}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {rows.length > 0 && (
        <div className="ph-card__note" style={{ padding: '8px 18px 12px' }} data-testid="ledger-position-note">
          {POSITION_EXPLAIN}
          {positionSum?.hasNegativeUnpaid && <> {UNPAID_NEGATIVE_NOTE}</>}
        </div>
      )}
    </>
  );
}

export default ShareholderLedgerTable;
