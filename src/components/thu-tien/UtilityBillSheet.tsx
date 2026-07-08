// =============================================
// UtilityBillSheet — sheet "Đóng tiền Điện nước" (khung điện thoại / mobile).
// Redesign 08/07/2026 theo mockup DienNuocPhone.dc.html: 3 tab
// (Đóng tiền · Báo cáo · Biểu đồ), lọc loại + "Chưa đóng", card mỗi toà với
// dòng Điện/Nước. Đóng tiền = phiếu CHI (chọn sổ + đính ảnh); Hủy phiếu trực tiếp.
//
// Mã PE/nước + tên chủ hộ vẫn sửa inline (autosave onBlur) — hiển thị như text
// theo mockup nhưng bấm vào là sửa được. Logic dùng chung useUtilityPayState.
// =============================================

import { useState } from 'react';
import { X, Zap, Droplet, Check, Camera } from 'lucide-react';
import { fmtFull, fmtBillingMonth } from '@/lib/collect';
import { openReceipt } from '@/lib/openReceipt';
import { useIncomeExpenseFormBuildings } from '@/hooks/useIncomeExpenseFormScope';
import { useUtilityChart, type UtilType } from '@/hooks/useUtilityBills';
import { useUtilityPayState } from '@/hooks/useUtilityPayState';
import { UtilityChart } from './UtilityChart';
import { UtilityBookMenu } from './UtilityBookMenu';
import { UtilityCancelModal } from './UtilityCancelModal';
import { BookIcon } from './utilityIcons';

interface Props {
  show: boolean;
  onClose: () => void;
  billingMonth: string;
  canRecordPayment: boolean;
}

type Tab = 'pay' | 'report' | 'chart';
type TypeFilter = 'all' | 'electric' | 'water';

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string) => {
  const d = s.replace(/\D/g, '');
  return d ? parseInt(d, 10) : 0;
};
const fmtDate = (d?: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

export function UtilityBillSheet({ show, onClose, billingMonth, canRecordPayment }: Props) {
  const { data: allBuildings = [], isLoading: loadingBld } = useIncomeExpenseFormBuildings();
  const buildings = allBuildings.filter((b) => !b.is_virtual);
  const S = useUtilityPayState(billingMonth, buildings);

  const [tab, setTab] = useState<Tab>('pay');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [onlyDue, setOnlyDue] = useState(false);

  const chart = useUtilityChart(billingMonth, { enabled: show && tab === 'chart' });

  const typeMatch = (t: UtilType) =>
    typeFilter === 'all' || (typeFilter === 'electric' && t === 'electric') || (typeFilter === 'water' && t === 'water');

  const renderRow = (b: { id: string; name: string }, t: UtilType) => {
    const k = S.key(b.id, t);
    const paid = S.paidThisKy(b.id, t);
    const amount = S.amountOf(b.id, t);
    const paying = S.payingKey === k;
    const Icon = t === 'electric' ? Zap : Droplet;
    return (
      <div className={'ubc-row ' + t} key={k}>
        <div className="ubc-rowhead">
          <span className={'ubc-ic ' + t}><Icon /></span>
          <input
            className="ubc-code"
            placeholder={t === 'electric' ? 'Mã PE' : 'Mã nước'}
            value={S.codeOf(b.id, t)}
            onChange={(e) => S.setField(b.id, t, { code: e.target.value })}
            onBlur={() => S.saveAccount(b.id, t)}
          />
          <input
            className="ubc-holder"
            placeholder="Tên chủ hộ"
            value={S.holderOf(b.id, t)}
            onChange={(e) => S.setField(b.id, t, { holder: e.target.value })}
            onBlur={() => S.saveAccount(b.id, t)}
          />
        </div>

        {paid ? (
          <div className="ubc-paid">
            <span className="ubc-paid-pill">
              {paid.hasReceipt && paid.receiptUrl && (
                <button type="button" className="ubc-paid-rc" title="Xem ảnh phiếu" onClick={() => openReceipt(paid.receiptUrl!)}>
                  <Camera />
                </button>
              )}
              <span className="ubc-paid-txt">
                <span className="ubc-paid-a">Đã đóng {paid.amount.toLocaleString('vi-VN')}</span>
                <span className="ubc-paid-m">{fmtDate(paid.date)} · {paid.by}</span>
              </span>
            </span>
            <span className="ubc-bookchip"><BookIcon size={13} />{paid.book}</span>
            <button
              type="button" className="ubc-cancel" title="Hủy phiếu thanh toán"
              disabled={!canRecordPayment}
              onClick={() => S.requestCancel(b.id, t)}
            >
              <X />
            </button>
          </div>
        ) : (
          <div className="ubc-pay">
            <input
              className="ub-amt" type="text" inputMode="numeric" placeholder="Số tiền"
              value={formatVN(amount)}
              onChange={(e) => S.setAmount(b.id, t, parseVN(e.target.value))}
            />
            <UtilityBookMenu
              accounts={S.myBooks}
              valueId={S.bookSel[k] ?? null}
              defaultId={S.defaultBookId}
              onPick={(id) => S.setBook(k, id)}
              compact
              disabled={!canRecordPayment}
            />
            <button
              type="button"
              className={'ub-attach' + (S.attach[k] ? ' has' : '')}
              title={S.attach[k] ? 'Đã đính kèm ảnh phiếu' : 'Chụp hoặc tải ảnh phiếu'}
              disabled={!canRecordPayment || S.uploadingKey === k}
              onClick={() => S.onAttachClick(k)}
            >
              {S.uploadingKey === k ? <span className="ub-spin dark" /> : <Camera />}
            </button>
            <button
              type="button" className="ub-paybtn" title="Đóng tiền"
              disabled={!canRecordPayment || amount <= 0 || paying}
              onClick={() => S.submitPay(b.id, t, b.name)}
            >
              {paying ? <span className="ub-spin" /> : <Check />}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderCard = (b: { id: string; name: string }) => {
    const rows: UtilType[] = (['electric', 'water'] as UtilType[]).filter((t) => {
      if (!typeMatch(t)) return false;
      if (onlyDue && S.paidThisKy(b.id, t)) return false;
      return true;
    });
    if (rows.length === 0) return null;
    const dueN = (S.paidThisKy(b.id, 'electric') ? 0 : 1) + (S.paidThisKy(b.id, 'water') ? 0 : 1);
    return (
      <div className="ubc" key={b.id}>
        <div className="ubc-head">
          <span className="ubc-bld">{b.name}</span>
          {dueN === 0 ? (
            <span className="ubc-badge done">Đã xong</span>
          ) : (
            <span className="ubc-badge pending">{dueN === 2 ? '2 khoản chưa đóng' : 'Còn 1 khoản'}</span>
          )}
        </div>
        {rows.map((t) => renderRow(b, t))}
      </div>
    );
  };

  const loading = loadingBld || S.loadingAccts || S.loadingPay;
  const visibleCards = buildings.map(renderCard).filter(Boolean);

  return (
    <>
      <input ref={S.fileRef} type="file" accept="image/*" hidden onChange={S.onFileChange} />
      <div className={'sheet-scrim' + (show ? ' show' : '')} onClick={onClose} />
      <div className={'sheet full' + (show ? ' show' : '')}>
        <div className="rp-topbar">
          <div>
            <div className="rp-title">Đóng tiền Điện nước</div>
            <div className="rp-sub">Kỳ {fmtBillingMonth(billingMonth)} · chi cho EVN / cấp nước</div>
          </div>
          <button type="button" className="rp-x" onClick={onClose}><X /></button>
        </div>

        <div className="ho-tabs">
          <button type="button" className={'cchip' + (tab === 'pay' ? ' on' : '')} onClick={() => setTab('pay')}>
            Đóng tiền <span className="cnt">{buildings.length}</span>
          </button>
          <button type="button" className={'cchip' + (tab === 'report' ? ' on' : '')} onClick={() => setTab('report')}>
            Báo cáo <span className="cnt">{S.byDay.length}</span>
          </button>
          <button type="button" className={'cchip' + (tab === 'chart' ? ' on' : '')} onClick={() => setTab('chart')}>
            Biểu đồ
          </button>
        </div>

        <div className="sheet-scroll rp-body">
          {tab === 'pay' && (
            <>
              <div className="ub-filter">
                <div className="ub-segs">
                  <button type="button" className={'ub-seg' + (typeFilter === 'all' ? ' on' : '')} onClick={() => setTypeFilter('all')}>Tất cả</button>
                  <button type="button" className={'ub-seg' + (typeFilter === 'electric' ? ' on' : '')} onClick={() => setTypeFilter('electric')}><Zap />Điện</button>
                  <button type="button" className={'ub-seg' + (typeFilter === 'water' ? ' on' : '')} onClick={() => setTypeFilter('water')}><Droplet />Nước</button>
                </div>
                <button type="button" className={'ub-due' + (onlyDue ? ' on' : '')} onClick={() => setOnlyDue((v) => !v)}>
                  {onlyDue ? <Check /> : <span className="ub-due-box" />}Chưa đóng
                </button>
              </div>

              {loading ? (
                <div className="c-empty"><div className="e-ic">⏳</div><p>Đang tải dữ liệu điện nước…</p></div>
              ) : buildings.length === 0 ? (
                <div className="c-empty"><div className="e-ic">🏢</div><p>Chưa có tòa nhà nào trong phạm vi của bạn.</p></div>
              ) : visibleCards.length === 0 ? (
                <div className="c-empty"><div className="e-ic">🎉</div><p>Không còn khoản nào khớp bộ lọc.</p></div>
              ) : (
                <div className="ubc-list">{visibleCards}</div>
              )}
            </>
          )}

          {tab === 'report' && (
            S.byDay.length === 0 ? (
              <div className="c-empty"><div className="e-ic">🧾</div><p>Kỳ {fmtBillingMonth(billingMonth)} chưa có ngày nào đóng điện nước.</p></div>
            ) : (
              <div className="ub-report">
                {S.byDay.map((d) => (
                  <div className="ub-day" key={d.date}>
                    <div className="ub-day-head">
                      <span className="ub-day-d">{fmtDate(d.date)}</span>
                      <span className="ub-day-c">{d.rows.length} khoản</span>
                      <span className="ub-day-s">{fmtFull(d.sum)}</span>
                    </div>
                    {d.rows.map((r) => (
                      <div className="ub-day-row" key={r.voucher_id}>
                        <span className={'ub-day-ic ' + r.type}>{r.type === 'electric' ? <Zap /> : <Droplet />}</span>
                        <div className="ub-day-main">
                          <div className="ub-day-l1">
                            <span className="ub-day-b">{r.buildingName}</span>
                            <span className="ub-day-t">{r.type === 'electric' ? 'Điện' : 'Nước'}</span>
                          </div>
                          <div className="ub-day-l2">{r.by} · {r.time} · {r.book}</div>
                        </div>
                        {r.hasReceipt && r.receiptUrl && (
                          <button type="button" className="ub-day-rc" title="Xem ảnh phiếu" onClick={() => openReceipt(r.receiptUrl!)}><Camera /></button>
                        )}
                        <span className="ub-day-amt">{fmtFull(r.amount)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'chart' && (
            <div className="ub-chart">
              <div className="ub-chart-t">Chi điện nước qua các tháng</div>
              <div className="ub-chart-s">Tổng chi cho EVN / cấp nước · toàn bộ tòa</div>
              {chart.isLoading ? (
                <div className="c-empty"><div className="e-ic">⏳</div><p>Đang tải biểu đồ…</p></div>
              ) : (
                <UtilityChart months={chart.data ?? []} compact />
              )}
            </div>
          )}

          <div className="rp-foot">
            <button type="button" className="rp-close" onClick={onClose}>Đóng</button>
          </div>
        </div>
      </div>

      <UtilityCancelModal
        target={S.cancelTarget}
        busy={S.cancelling}
        onClose={S.closeCancel}
        onConfirm={S.confirmCancel}
      />
    </>
  );
}

export default UtilityBillSheet;
