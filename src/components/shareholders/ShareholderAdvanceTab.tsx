// Tab "Tạm ứng LN" — người được chủ cấp riêng quyền tạm ứng lợi nhuận (shareholder_profit.advance_own_cashbook)
// mà KHÔNG có tab tự xem (không có trang Báo cáo Lợi Nhuận). Chỉ: giải thích ngắn, hai con số của chính mình
// ("Lợi nhuận chưa chi" · "Tạm ứng đang có" — R2), nút mở hộp tạm ứng cho CHÍNH MÌNH (chỉ sổ đang giữ, mọi
// khoản chờ chủ duyệt), các lần chủ chốt chi và các khoản mình đã lập (tự huỷ khi còn chờ).
// Không đọc sổ tổng của cổ đông khác, không cần quyền chi lợi nhuận. Số chỉ hiện khi sổ tổng đã chạy.

import { useMemo, useState } from 'react';
import { HandCoins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMyPositionView } from '@/hooks/profit-ledger/useMyPositionView';
import { useMyProfitLedger } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import type { Shareholder } from '@/hooks/useShareholders';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';
import {
  advancePendingText, isUnpaidNegative, POSITION_LABELS, settlementCashPendingText, UNPAID_NEGATIVE_NOTE,
} from '@/lib/profitLedger/positionView';
import {
  newestFirst, payoutStatusLabel, selfAdvanceBlockedNote, shareholderOrganizationId,
} from '@/lib/profitLedger/selfView';
import { cancelTargetFromMyPayout, type ProfitPayoutCancelTarget } from '@/lib/profitLedger/vouchers';
import { formatCurrency } from '@/lib/utils';
import { formatISODateVN } from '@/lib/vnDate';
import { ProfitHubSlot } from '@/pages/reports/finance/ProfitHubShell';
import { MyProfitLedgerGate } from './MyProfitLedgerGate';
import { ProfitPayoutCancelDialog } from './ProfitPayoutCancelDialog';
import ProfitSelfAdvanceDialog from './ProfitSelfAdvanceDialog';
import { MyPositionError, MySettlementsCard, MySettlementsMobile } from './ShareholderSelfPosition';
import { CARD } from './profitMobileShared';

export default function ShareholderAdvanceTab({ me, phone = false }: { me: Shareholder; phone?: boolean }) {
  const organizationId = shareholderOrganizationId(me);
  const ledgerQuery = useMyProfitLedger(organizationId);
  return (
    <MyProfitLedgerGate
      organizationId={organizationId}
      query={ledgerQuery}
      hiddenText="Bạn chưa được tạm ứng lợi nhuận ở công ty này — liên hệ chủ công ty."
    >
      {(ledger) => <AdvanceBody ledger={ledger} phone={phone} />}
    </MyProfitLedgerGate>
  );
}

const EXPLAIN = [
  'Chủ công ty cho bạn tạm ứng lợi nhuận từ sổ quỹ bạn đang giữ.',
  'Mỗi lần ứng là một phiếu chờ chủ duyệt — tiền chưa ra khỏi sổ cho tới khi chủ duyệt. Phiếu còn chờ duyệt thì bạn tự huỷ được.',
  'Tạm ứng cộng dồn. Khi chủ chốt chi lợi nhuận, tạm ứng đã duyệt được khấu trừ vào phần lợi nhuận chưa chi.',
];

function AdvanceBody({ ledger, phone }: { ledger: MyProfitLedger; phone: boolean }) {
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ProfitPayoutCancelTarget | null>(null);
  const note = selfAdvanceBlockedNote(ledger.route);
  // Hai con số là số sổ tổng: chỉ đọc và hiện khi máy chủ báo sổ đã chạy (`ready`), không thì không hiện như số chính thức.
  const positionView = useMyPositionView(ledger.organization_id, { enabled: ledger.ready });
  const position = ledger.ready ? positionView.position : null;
  const missing = positionView.pending ? '…' : '—';
  const advancePending = position ? advancePendingText(position, formatCurrency) : null;
  const cashPending = position ? settlementCashPendingText(position, formatCurrency) : null;
  const unpaidNegative = !!position && isUnpaidNegative(position);
  const mine = useMemo(() => newestFirst(ledger.payouts.filter((p) => p.is_mine)), [ledger.payouts]);
  const rows = mine.map((p) => ({
    payout: p,
    target: cancelTargetFromMyPayout(p, { organizationId: ledger.organization_id, subjectName: ledger.shareholder.name }),
  }));
  const openCancel = (target: ProfitPayoutCancelTarget) => { setCancelTarget(target); setCancelOpen(true); };

  const dialogs = (
    <>
      <ProfitSelfAdvanceDialog
        open={advanceOpen}
        onOpenChange={setAdvanceOpen}
        organizationId={ledger.organization_id}
        me={{ shareholderId: ledger.shareholder.id, name: ledger.shareholder.name }}
      />
      <ProfitPayoutCancelDialog open={cancelOpen} onOpenChange={setCancelOpen} target={cancelTarget} />
    </>
  );

  // Hai dòng số (chỉ khi sổ tổng đã chạy).
  const numbers = ledger.ready && (
    <div className={phone ? 'flex flex-col gap-0.5' : 'mt-3 space-y-0.5 text-sm'} data-testid="advance-balance">
      <p className={phone ? 'm-0 text-[13px] font-bold text-[#1b1813]' : 'm-0 font-semibold'}>
        {POSITION_LABELS.unpaid}: <span className={phone ? 'font-mono' : undefined}>{position ? formatCurrency(position.unpaid_profit) : missing}</span>
        {cashPending ? ` (${cashPending})` : ''}
      </p>
      <p className={phone ? 'm-0 text-[13px] font-bold text-[#1b1813]' : 'm-0 font-semibold'}>
        {POSITION_LABELS.advance}: <span className={phone ? 'font-mono' : undefined}>{position ? formatCurrency(position.advance_outstanding) : missing}</span>
        {advancePending ? ` (${advancePending})` : ''}
      </p>
      {unpaidNegative && <p className={phone ? 'm-0 text-[11.5px] font-semibold text-[#8d8678]' : 'm-0 text-muted-foreground'}>{UNPAID_NEGATIVE_NOTE}</p>}
    </div>
  );

  if (phone) {
    return (
      <div className="flex flex-col gap-3">
        <div className={`${CARD} !rounded-2xl px-[15px] py-3.5 flex flex-col gap-2`}>
          <span className="text-[14px] font-extrabold text-[#1b1813]">Tạm ứng lợi nhuận</span>
          {EXPLAIN.map((line) => <p key={line} className="m-0 text-[12.5px] font-semibold leading-snug text-[#514c42]">{line}</p>)}
          {numbers}
          {ledger.ready && <MyPositionError view={positionView} />}
          <button
            type="button"
            disabled={note !== null}
            onClick={() => setAdvanceOpen(true)}
            className="mt-1 flex items-center justify-center gap-2 rounded-2xl bg-[#1a6645] px-4 py-3 text-[13.5px] font-bold text-white disabled:opacity-50"
          >
            <HandCoins className="h-4 w-4" />Chi tạm ứng cho tôi
          </button>
          {note && <p role="note" className="m-0 text-center text-[11.5px] font-semibold text-[#8d8678]">{note}</p>}
        </div>
        {ledger.ready && <MySettlementsMobile view={positionView} />}
        <div className={`${CARD} !rounded-2xl overflow-hidden`}>
          <div className="px-[15px] py-3.5 border-b border-[#efece4]">
            <span className="text-[13.5px] font-extrabold text-[#1b1813]">Khoản bạn đã lập</span>
          </div>
          {rows.length === 0 && <p className="m-0 px-[15px] py-3.5 text-[12.5px] font-semibold text-[#8d8678]">Chưa có khoản nào.</p>}
          {rows.map(({ payout: p, target }) => (
            <div key={p.voucher_id} className="flex items-center gap-[11px] px-[15px] py-[11px] border-b border-[#f4f1ea] last:border-b-0">
              <div className="flex-1 min-w-0 flex flex-col gap-px">
                {/* Xuống dòng thay vì cắt "· Tạm ứng" (chữ mang nghĩa). */}
                <span className="text-[12.5px] font-bold leading-snug text-[#1b1813] [overflow-wrap:anywhere]">
                  {p.voucher_code ?? 'Phiếu chi'} · {payoutStatusLabel(p)}{p.is_advance ? ' · Tạm ứng' : ''}
                </span>
                <span className="font-mono text-[10.5px] font-bold text-[#8d8678]">{formatISODateVN(p.voucher_date)}</span>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className="font-mono text-[13px] font-bold text-[#c97a10] whitespace-nowrap">{formatCurrency(p.amount)}</span>
                {target && (
                  <button type="button" onClick={() => openCancel(target)} className="rounded-lg border border-[#e7e3da] bg-white px-2 py-0.5 text-[11px] font-bold text-[#514c42]">
                    Huỷ yêu cầu
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        {dialogs}
      </div>
    );
  }

  return (
    <>
      {ledger.ready && (
        <ProfitHubSlot name="kpis">
          <div className="ph-kpi ph-kpi--flex">
            <div className="ph-kpi__label">Cổ đông</div>
            <div className="ph-kpi__value">{ledger.shareholder.name}</div>
          </div>
          <div className="ph-kpi__div" />
          <div className="ph-kpi ph-kpi--flex" title={unpaidNegative ? UNPAID_NEGATIVE_NOTE : undefined}>
            <div className="ph-kpi__label">{POSITION_LABELS.unpaid}</div>
            <div className={`ph-kpi__value${unpaidNegative ? ' ph-kpi__value--peach' : ''}`}>{position ? formatCurrency(position.unpaid_profit) : missing}</div>
            <div className="ph-kpi__sub">{position ? cashPending ?? 'chờ chủ chốt chi' : positionView.pending ? '' : 'chưa tải được'}</div>
          </div>
          <div className="ph-kpi__div" />
          <div className="ph-kpi ph-kpi--flex">
            <div className="ph-kpi__label">{POSITION_LABELS.advance}</div>
            <div className="ph-kpi__value ph-kpi__value--gold">{position ? formatCurrency(position.advance_outstanding) : missing}</div>
            <div className="ph-kpi__sub">{position ? advancePending ?? 'khấu trừ khi chủ chốt chi' : positionView.pending ? '' : 'chưa tải được'}</div>
          </div>
        </ProfitHubSlot>
      )}
      <div className="ph-stack">
        <div className="ph-card ph-card__pad">
          <div className="ph-card__title">Tạm ứng lợi nhuận</div>
          <div className="mt-2 space-y-1 text-sm">
            {EXPLAIN.map((line) => <p key={line} className="m-0">{line}</p>)}
          </div>
          {numbers}
          {ledger.ready && <MyPositionError view={positionView} className="mt-3" />}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button className="ph-btn-primary" disabled={note !== null} onClick={() => setAdvanceOpen(true)}>
              <HandCoins className="h-4 w-4" />Chi tạm ứng cho tôi
            </Button>
            {note && <span role="note" className="ph-hint" style={{ marginTop: 0 }}>{note}</span>}
          </div>
        </div>
        {ledger.ready && <MySettlementsCard view={positionView} />}
        <div className="ph-card">
          <div className="ph-card__head"><div className="ph-card__title">Khoản bạn đã lập</div></div>
          <div className="ph-tbl__scroll">
            <table className="ph-tbl">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>Ngày</th>
                  <th>Phiếu</th>
                  <th>Trạng thái</th>
                  <th className="num" style={{ width: 140 }}>Số tiền</th>
                  <th style={{ width: 120 }} aria-label="Thao tác" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--ph-ink-4)' }}>Chưa có khoản nào</td></tr>
                )}
                {rows.map(({ payout: p, target }) => (
                  <tr key={p.voucher_id}>
                    <td>{formatISODateVN(p.voucher_date)}</td>
                    <td>
                      {p.voucher_code ?? '—'}
                      {p.is_advance && <span className="ph-inline ph-inline--first">Tạm ứng</span>}
                    </td>
                    <td>{payoutStatusLabel(p)}</td>
                    <td className="num neg strong">{formatCurrency(p.amount)}</td>
                    <td>{target && <button type="button" className="ph-mini-btn" onClick={() => openCancel(target)}>Huỷ yêu cầu</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {dialogs}
    </>
  );
}
