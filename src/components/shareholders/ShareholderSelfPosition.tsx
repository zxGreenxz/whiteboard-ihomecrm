// Phần VẼ dùng chung của các màn cổ đông TỰ XEM (máy tính, điện thoại, tab "Tạm ứng LN") cho vị thế của chính
// mình (R2, đọc qua useMyPositionView): câu báo chưa đọc được hai con số và thẻ "Các lần chốt chi lợi nhuận"
// (chỉ xem — cổ đông không huỷ chốt). Chưa đọc được số ⇒ "…" / "—" + câu báo có nút tải lại; KHÔNG hiện 0.

import { Button } from '@/components/ui/button';
import type { MyPositionView } from '@/hooks/profit-ledger/useMyPositionView';
import type { ProfitSettlementRow } from '@/lib/profitLedger/positionReaders';
import { settleMonthLabel, settlementCashLabel } from '@/lib/profitLedger/positionView';
import { formatCurrency } from '@/lib/utils';
import { CARD, fmtShort } from './profitMobileShared';

/** Câu báo chưa đọc được hai con số — đặt ngay dưới khối số. */
export function MyPositionError({ view, className }: { view: MyPositionView; className?: string }) {
  if (!view.errorMessage) return null;
  return (
    <div role="alert" className={`rounded-md border border-destructive/40 p-3 text-sm ${className ?? ''}`} data-testid="self-position-error">
      <p className="font-medium text-destructive">Chưa tải được lợi nhuận chưa chi và tạm ứng của bạn.</p>
      <p className="mt-1 text-muted-foreground">{view.errorMessage}</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={view.retry}>Tải lại</Button>
    </div>
  );
}

const MUTED = { color: 'var(--ph-ink-4)' } as const;

export function MyFundBreakdown({ view }: { view: MyPositionView }) {
  const parts = view.position?.components;
  const payable = parts?.shared_fund_payable ?? 0;
  const offset = parts?.shared_fund_offset ?? 0;
  const opening = parts?.opening_advance ?? 0;
  const pool = view.position?.house_pool;
  if (!pool && payable + offset + opening === 0) return null;
  return (
    <dl className="grid gap-2 rounded-xl border bg-card p-4 text-sm sm:grid-cols-2" aria-label="Quỹ chung và tạm ứng đầu kỳ của bạn">
      {pool && <>
        <div><dt className="font-semibold">Phần góp của bạn trong quỹ công ty</dt><dd>{formatCurrency(pool.available)}</dd></div>
        <div><dt>Đã góp</dt><dd>{formatCurrency(pool.contributed)}</dd></div>
        <div><dt>Đang chờ hoàn</dt><dd>{formatCurrency(pool.reserved)}</dd></div>
        <div><dt>Đã hoàn qua phiếu chi</dt><dd>{formatCurrency(pool.paid)}</dd></div>
      </>}
      {payable + offset > 0 && <>
        <div><dt className="font-semibold">Được chia từ quỹ chung</dt><dd>{formatCurrency(payable + offset)}</dd></div>
        <div><dt>Phần dùng để cấn tạm ứng</dt><dd>{formatCurrency(offset)}</dd></div>
        <div><dt>Phần ghi vào lợi nhuận chưa chi khi chia quỹ</dt><dd>{formatCurrency(payable)}</dd></div>
      </>}
      {opening > 0 && <div><dt>Tạm ứng đầu kỳ đã đối soát</dt><dd>{formatCurrency(opening)}</dd></div>}
    </dl>
  );
}

const rowDim = (row: ProfitSettlementRow) => (row.excluded_by_marker ? { opacity: 0.6 } : undefined);

/** Thẻ "Các lần chốt chi lợi nhuận" — máy tính. Không hiện khi chưa có số (khối lỗi đã nói ở trên). */
export function MySettlementsCard({ view }: { view: MyPositionView }) {
  if (!view.position) return null;
  const rows = view.position.settlements;
  return (
    <div className="ph-card" data-testid="self-settlements-card">
      <div className="ph-card__head">
        <div className="ph-card__title">Các lần chốt chi lợi nhuận</div>
        <div className="ph-card__note">Tiền theo phiếu là phần lợi nhuận còn lại sau khi cấn ứng. Trạng thái cho biết phiếu đã ghi chi hay còn chờ.</div>
      </div>
      <div className="ph-tbl__scroll">
        <table className="ph-tbl">
          <thead>
            <tr>
              <th style={{ width: 130 }}>Chốt đến hết</th>
              <th className="num">Lợi nhuận ghi nhận</th>
              <th className="num">Khấu trừ tạm ứng</th>
              <th className="num">Tiền theo phiếu</th>
              <th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', ...MUTED }}>Chủ công ty chưa chốt chi lợi nhuận lần nào</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} style={rowDim(row)} data-testid={`self-settlement-${row.id}`}>
                <td className="name">
                  {settleMonthLabel(row.through_month)}
                  {row.excluded_by_marker && <span className="ph-keep" style={{ marginLeft: 4 }}>trước mốc</span>}
                </td>
                <td className="num pos">{formatCurrency(row.recognized_amount)}</td>
                <td className="num">{formatCurrency(row.advance_offset_amount)}</td>
                <td className="num neg strong">{formatCurrency(row.cash_amount)}</td>
                <td>{settlementCashLabel(row)}{row.cash_voucher_code ? ` · ${row.cash_voucher_code}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Thẻ "Các lần chốt chi lợi nhuận" — điện thoại. */
export function MySettlementsMobile({ view }: { view: MyPositionView }) {
  if (!view.position) return null;
  const rows = view.position.settlements;
  return (
    <div className={`${CARD} !rounded-2xl overflow-hidden`} data-testid="self-settlements-card">
      <div className="px-[15px] py-3.5 border-b border-[#efece4]">
        <span className="text-[13.5px] font-extrabold tracking-[-0.1px] text-[#1b1813]">Các lần chốt chi lợi nhuận</span>
      </div>
      {rows.length === 0 && (
        <p className="m-0 px-[15px] py-3.5 text-[12.5px] font-semibold text-[#8d8678]">Chủ công ty chưa chốt chi lợi nhuận lần nào.</p>
      )}
      {rows.map((row) => (
        <div
          key={row.id}
          data-testid={`self-settlement-${row.id}`}
          className={`flex flex-col gap-0.5 px-[15px] py-[10px] border-b border-[#f4f1ea] last:border-b-0${row.excluded_by_marker ? ' opacity-60' : ''}`}
        >
          <div className="flex items-center gap-2">
            <span className="flex-1 min-w-0 text-[12.5px] font-bold leading-snug text-[#1b1813] [overflow-wrap:anywhere]">
              Đến hết {settleMonthLabel(row.through_month)}{row.excluded_by_marker ? ' · trước mốc' : ''}
            </span>
            <span className="font-mono text-[13px] font-bold text-[#c97a10] whitespace-nowrap">{fmtShort(row.cash_amount)}</span>
          </div>
          <span className="font-mono text-[11px] font-bold text-[#514c42]">
            Ghi nhận {fmtShort(row.recognized_amount)} · khấu trừ tạm ứng {fmtShort(row.advance_offset_amount)}
          </span>
          <span className="text-[11px] font-semibold text-[#8d8678]">
            {settlementCashLabel(row)}{row.cash_voucher_code ? ` · ${row.cash_voucher_code}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
