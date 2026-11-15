// Tab "Tạm ứng LN" — người được chủ cấp riêng quyền tạm ứng lợi nhuận (shareholder_profit.advance_own_cashbook)
// mà KHÔNG có tab tự xem (không có trang Báo cáo Lợi Nhuận). Chỉ: giải thích ngắn, nút mở hộp chi tạm ứng
// cho CHÍNH MÌNH (chỉ sổ đang giữ, mọi khoản chờ chủ duyệt), và các khoản mình đã lập (tự huỷ khi còn chờ).
// Không đọc sổ tổng của cổ đông khác, không cần quyền chi lợi nhuận. Số dư chỉ hiện khi sổ tổng đã chạy.

import { useMemo, useState } from 'react';
import { HandCoins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMyProfitLedger } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import type { Shareholder } from '@/hooks/useShareholders';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';
import {
  newestFirst, payoutStatusLabel, selfAdvanceBlockedNote, selfBalanceView, shareholderOrganizationId,
} from '@/lib/profitLedger/selfView';
import { cancelTargetFromMyPayout, type ProfitPayoutCancelTarget } from '@/lib/profitLedger/vouchers';
import { formatCurrency } from '@/lib/utils';
import { formatISODateVN } from '@/lib/vnDate';
import { ProfitHubSlot } from '@/pages/reports/finance/ProfitHubShell';
import { MyProfitLedgerGate } from './MyProfitLedgerGate';
import ProfitDistributeDialog from './ProfitDistributeDialog';
import { ProfitPayoutCancelDialog } from './ProfitPayoutCancelDialog';
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
  'Chủ công ty cho bạn chi tạm ứng lợi nhuận từ sổ quỹ bạn đang giữ.',
  'Mỗi lần chi là một phiếu chờ chủ duyệt — tiền chưa ra khỏi sổ cho tới khi chủ duyệt.',
  'Phần tạm ứng được trừ dần vào lợi nhuận các tháng sau. Phiếu còn chờ duyệt thì bạn tự huỷ được.',
];

function AdvanceBody({ ledger, phone }: { ledger: MyProfitLedger; phone: boolean }) {
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ProfitPayoutCancelTarget | null>(null);
  const note = selfAdvanceBlockedNote(ledger.route);
  // Số dư là số sổ tổng: chỉ hiện khi máy chủ báo sổ đã chạy (`ready`), không thì không hiện như số chính thức.
  const balance = ledger.ready ? selfBalanceView(ledger) : null;
  const mine = useMemo(() => newestFirst(ledger.payouts.filter((p) => p.is_mine)), [ledger.payouts]);
  const rows = mine.map((p) => ({
    payout: p,
    target: cancelTargetFromMyPayout(p, { organizationId: ledger.organization_id, subjectName: ledger.shareholder.name }),
  }));
  const openCancel = (target: ProfitPayoutCancelTarget) => { setCancelTarget(target); setCancelOpen(true); };

  const dialogs = (
    <>
      <ProfitDistributeDialog
        open={advanceOpen}
        onOpenChange={setAdvanceOpen}
        organizationId={ledger.organization_id}
        mode="SELF_ADVANCE"
        me={{ shareholderId: ledger.shareholder.id, name: ledger.shareholder.name }}
      />
      <ProfitPayoutCancelDialog open={cancelOpen} onOpenChange={setCancelOpen} target={cancelTarget} />
    </>
  );

  if (phone) {
    return (
      <div className="flex flex-col gap-3">
        <div className={`${CARD} !rounded-2xl px-[15px] py-3.5 flex flex-col gap-2`}>
          <span className="text-[14px] font-extrabold text-[#1b1813]">Tạm ứng lợi nhuận</span>
          {EXPLAIN.map((line) => <p key={line} className="m-0 text-[12.5px] font-semibold leading-snug text-[#514c42]">{line}</p>)}
          {balance && (
            <p className="m-0 text-[13px] font-bold text-[#1b1813]" data-testid="advance-balance">
              {balance.label}: <span className="font-mono">{formatCurrency(balance.amount)}</span>
            </p>
          )}
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
        <div className={`${CARD} !rounded-2xl overflow-hidden`}>
          <div className="px-[15px] py-3.5 border-b border-[#efece4]">
            <span className="text-[13.5px] font-extrabold text-[#1b1813]">Khoản bạn đã lập</span>
          </div>
          {rows.length === 0 && <p className="m-0 px-[15px] py-3.5 text-[12.5px] font-semibold text-[#8d8678]">Chưa có khoản nào.</p>}
          {rows.map(({ payout: p, target }) => (
            <div key={p.voucher_id} className="flex items-center gap-[11px] px-[15px] py-[11px] border-b border-[#f4f1ea] last:border-b-0">
              <div className="flex-1 min-w-0 flex flex-col gap-px">
                <span className="text-[12.5px] font-bold text-[#1b1813] truncate">
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
      {balance && (
        <ProfitHubSlot name="kpis">
          <div className="ph-kpi ph-kpi--flex">
            <div className="ph-kpi__label">Cổ đông</div>
            <div className="ph-kpi__value">{ledger.shareholder.name}</div>
          </div>
          <div className="ph-kpi__div" />
          <div className="ph-kpi ph-kpi--flex">
            <div className="ph-kpi__label">{balance.label}</div>
            <div className={`ph-kpi__value${balance.status === 'ADVANCE' ? ' ph-kpi__value--peach' : ''}`}>{formatCurrency(balance.amount)}</div>
            <div className="ph-kpi__sub">{balance.note}</div>
          </div>
        </ProfitHubSlot>
      )}
      <div className="ph-stack">
        <div className="ph-card ph-card__pad">
          <div className="ph-card__title">Tạm ứng lợi nhuận</div>
          <div className="mt-2 space-y-1 text-sm">
            {EXPLAIN.map((line) => <p key={line} className="m-0">{line}</p>)}
          </div>
          {balance && (
            <p className="mt-3 text-sm font-semibold" data-testid="advance-balance">
              {balance.label}: {formatCurrency(balance.amount)}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button className="ph-btn-primary" disabled={note !== null} onClick={() => setAdvanceOpen(true)}>
              <HandCoins className="h-4 w-4" />Chi tạm ứng cho tôi
            </Button>
            {note && <span role="note" className="ph-hint" style={{ marginTop: 0 }}>{note}</span>}
          </div>
        </div>
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
