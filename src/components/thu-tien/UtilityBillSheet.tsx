// =============================================
// UtilityBillSheet — full sheet "Đóng tiền Điện nước" trong khung điện thoại.
// Khuôn sheet/scrim + tab y hệt HandoverSheet/CollectionReport.
//
// Chủ nhà đóng tiền điện/nước cho NHÀ CUNG CẤP theo từng toà + kỳ:
//  - Tab "Đóng tiền": mỗi toà 1 card → dòng Điện (trên) + Nước (dưới).
//    Mã PE/nước + tên chủ hộ sửa inline (autosave onBlur). Ô số tiền mặc
//    định trống; bấm nút ✓ → tạo phiếu CHI từ sổ "…Thu" của user.
//  - Tab "Báo cáo": các NGÀY có đóng trong kỳ (chỉ ngày có phiếu).
// =============================================

import { useState } from 'react';
import { X, Zap, Droplet, Check } from 'lucide-react';
import { toast } from 'sonner';
import { fmtFull, fmtBillingMonth } from '@/lib/collect';
import { useIncomeExpenseFormBuildings } from '@/hooks/useIncomeExpenseFormScope';
import {
  useUtilityAccounts,
  useUtilityPayments,
  usePayUtilityBill,
  useUpsertUtilityAccount,
  type UtilType,
} from '@/hooks/useUtilityBills';

interface Props {
  show: boolean;
  onClose: () => void;
  billingMonth: string;
  canRecordPayment: boolean;
}

type Tab = 'pay' | 'report';

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string) => {
  const d = s.replace(/\D/g, '');
  return d ? parseInt(d, 10) : 0;
};
const fmtDate = (d?: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

export function UtilityBillSheet({ show, onClose, billingMonth, canRecordPayment }: Props) {
  const { data: allBuildings = [], isLoading: loadingBld } = useIncomeExpenseFormBuildings();
  // Chỉ toà thật — bỏ toà ảo (Chung…) vì không đóng tiền điện/nước cho NCC.
  const buildings = allBuildings.filter((b) => !b.is_virtual);
  const { byKey, isLoading: loadingAccts } = useUtilityAccounts();
  const { paidThisKy, byDay, isLoading: loadingPay } = useUtilityPayments(billingMonth);
  const payMut = usePayUtilityBill();
  const upsertMut = useUpsertUtilityAccount();

  const [tab, setTab] = useState<Tab>('pay');
  const [draft, setDraft] = useState<Record<string, { code: string; holder: string }>>({});
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [payingKey, setPayingKey] = useState<string | null>(null);

  const key = (bId: string, t: UtilType) => `${bId}:${t}`;
  const codeOf = (bId: string, t: UtilType) => draft[key(bId, t)]?.code ?? byKey(bId, t)?.code ?? '';
  const holderOf = (bId: string, t: UtilType) => draft[key(bId, t)]?.holder ?? byKey(bId, t)?.holder ?? '';
  const amountOf = (bId: string, t: UtilType) => amounts[key(bId, t)] ?? 0;

  const setField = (bId: string, t: UtilType, patch: Partial<{ code: string; holder: string }>) =>
    setDraft((d) => ({
      ...d,
      [key(bId, t)]: { code: codeOf(bId, t), holder: holderOf(bId, t), ...patch },
    }));
  const setAmount = (bId: string, t: UtilType, v: number) =>
    setAmounts((a) => ({ ...a, [key(bId, t)]: v }));

  const saveAccount = (bId: string, t: UtilType) => {
    const code = codeOf(bId, t).trim();
    const holder = holderOf(bId, t).trim();
    const cur = byKey(bId, t);
    if ((cur?.code ?? '') === code && (cur?.holder ?? '') === holder) return; // không đổi
    if (!code && !holder) return;
    upsertMut.mutate({ buildingId: bId, type: t, code, holder });
  };

  const submitPay = async (bId: string, t: UtilType, name: string) => {
    const amount = amountOf(bId, t);
    if (amount <= 0) {
      toast.error('Nhập số tiền cần đóng');
      return;
    }
    setPayingKey(key(bId, t));
    try {
      await payMut.mutateAsync({
        buildingId: bId,
        type: t,
        billingMonth,
        amount,
        code: codeOf(bId, t).trim(),
        holder: holderOf(bId, t).trim(),
      });
      setAmounts((a) => {
        const n = { ...a };
        delete n[key(bId, t)];
        return n;
      });
      toast.success(`Đã chi ${fmtFull(amount)} tiền ${t === 'electric' ? 'điện' : 'nước'} · ${name}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPayingKey(null);
    }
  };

  const renderRow = (b: { id: string; name: string }, t: UtilType) => {
    const k = key(b.id, t);
    const paid = paidThisKy(b.id, t);
    const amount = amountOf(b.id, t);
    const paying = payingKey === k;
    const Icon = t === 'electric' ? Zap : Droplet;
    return (
      <div className={'ub-row ' + t} key={k}>
        <div className="ub-ic">
          <Icon />
        </div>
        <div className="ub-main">
          <div className="ub-codeline">
            <input
              className="ub-code"
              placeholder={t === 'electric' ? 'Mã PE' : 'Mã nước'}
              value={codeOf(b.id, t)}
              onChange={(e) => setField(b.id, t, { code: e.target.value })}
              onBlur={() => saveAccount(b.id, t)}
            />
            <input
              className="ub-holder"
              placeholder="Tên chủ hộ"
              value={holderOf(b.id, t)}
              onChange={(e) => setField(b.id, t, { holder: e.target.value })}
              onBlur={() => saveAccount(b.id, t)}
            />
          </div>
          {paid && (
            <span className="ub-paid">
              <Check /> Đã đóng {fmtFull(paid.amount)} · {fmtDate(paid.date)}
            </span>
          )}
        </div>
        <div className="ub-pay">
          <input
            className="ub-amt"
            type="text"
            inputMode="numeric"
            placeholder="Số tiền"
            value={formatVN(amount)}
            onChange={(e) => setAmount(b.id, t, parseVN(e.target.value))}
          />
          <button
            type="button"
            className="ub-paybtn"
            title={`Đóng tiền ${t === 'electric' ? 'điện' : 'nước'}`}
            disabled={!canRecordPayment || amount <= 0 || paying}
            onClick={() => submitPay(b.id, t, b.name)}
          >
            {paying ? <span className="ub-spin" /> : <Check />}
          </button>
        </div>
      </div>
    );
  };

  const loading = loadingBld || loadingAccts || loadingPay;

  return (
    <>
      <div className={'sheet-scrim' + (show ? ' show' : '')} onClick={onClose} />
      <div className={'sheet full' + (show ? ' show' : '')}>
        <div className="rp-topbar">
          <div>
            <div className="rp-title">Đóng tiền Điện nước</div>
            <div className="rp-sub">
              Kỳ {fmtBillingMonth(billingMonth)} · chi cho EVN / cấp nước theo từng tòa
            </div>
          </div>
          <button type="button" className="rp-x" onClick={onClose}>
            <X />
          </button>
        </div>

        <div className="ho-tabs">
          <button
            type="button"
            className={'cchip' + (tab === 'pay' ? ' on' : '')}
            onClick={() => setTab('pay')}
          >
            Đóng tiền <span className="cnt">{buildings.length}</span>
          </button>
          <button
            type="button"
            className={'cchip' + (tab === 'report' ? ' on' : '')}
            onClick={() => setTab('report')}
          >
            Báo cáo <span className="cnt">{byDay.length}</span>
          </button>
        </div>

        <div className="sheet-scroll rp-body">
          {tab === 'pay' &&
            (loading ? (
              <div className="c-empty">
                <div className="e-ic">⏳</div>
                <p>Đang tải dữ liệu điện nước…</p>
              </div>
            ) : buildings.length === 0 ? (
              <div className="c-empty">
                <div className="e-ic">🏢</div>
                <p>Chưa có tòa nhà nào trong phạm vi của bạn.</p>
              </div>
            ) : (
              <div className="ub-list">
                {buildings.map((b) => (
                  <div className="ub-bld" key={b.id}>
                    <div className="ub-bld-name">{b.name}</div>
                    {renderRow(b, 'electric')}
                    {renderRow(b, 'water')}
                  </div>
                ))}
              </div>
            ))}

          {tab === 'report' &&
            (byDay.length === 0 ? (
              <div className="c-empty">
                <div className="e-ic">🧾</div>
                <p>Kỳ {fmtBillingMonth(billingMonth)} chưa có ngày nào đóng điện nước.</p>
              </div>
            ) : (
              <div className="ub-report">
                {byDay.map((d) => (
                  <div className="ub-day" key={d.date}>
                    <div className="ub-day-head">
                      <span className="ub-day-d">{fmtDate(d.date)}</span>
                      <span className="ub-day-s">{fmtFull(d.sum)}</span>
                    </div>
                    {d.rows.map((r, i) => (
                      <div className="ub-day-row" key={i}>
                        <span className={'ub-day-ic ' + r.type}>
                          {r.type === 'electric' ? <Zap /> : <Droplet />}
                        </span>
                        <span className="ub-day-b">{r.buildingName}</span>
                        <span className="ub-day-t">{r.type === 'electric' ? 'Điện' : 'Nước'}</span>
                        <span className="ub-day-amt">{fmtFull(r.amount)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}

          <div className="rp-foot">
            <button type="button" className="rp-close" onClick={onClose}>
              Đóng
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export default UtilityBillSheet;
