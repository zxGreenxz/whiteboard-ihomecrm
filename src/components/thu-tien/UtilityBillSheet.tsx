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
import { X, Zap, Droplet, Check, Camera, Plus, Trash2 } from 'lucide-react';
import { fmtFull, fmtBillingMonth } from '@/lib/collect';
import { useIncomeExpenseFormBuildings } from '@/hooks/useIncomeExpenseFormScope';
import { useUtilityChart, type UtilType } from '@/hooks/useUtilityBills';
import { useUtilityPayState, type MeterRow } from '@/hooks/useUtilityPayState';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import { UtilityChart } from './UtilityChart';
import { UtilityBookMenu } from './UtilityBookMenu';
import { UtilityCancelModal } from './UtilityCancelModal';
import { UtilityReceiptThumb } from './UtilityReceiptThumb';
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
  const [reportBld, setReportBld] = useState<string>('all');
  const [chartBld, setChartBld] = useState<string>('all');

  const chart = useUtilityChart(billingMonth, {
    enabled: show && tab === 'chart',
    buildingId: chartBld === 'all' ? null : chartBld,
  });

  const typeMatch = (t: UtilType) =>
    typeFilter === 'all' || (typeFilter === 'electric' && t === 'electric') || (typeFilter === 'water' && t === 'water');

  const renderRow = (row: MeterRow) => {
    const k = row.key;
    const paid = S.paidThisKy(row.accountId);
    const amount = S.amountOf(k);
    const paying = S.payingKey === k;
    const Icon = row.type === 'electric' ? Zap : Droplet;
    return (
      <div className={'ubc-row ' + row.type} key={k} {...(paid ? {} : S.pasteProps(k))}>
        <div className="ubc-rowhead">
          <span className={'ubc-ic ' + row.type}><Icon /></span>
          <input
            className="ubc-code"
            placeholder={row.type === 'electric' ? 'Mã PE' : 'Mã nước'}
            value={S.codeOf(row)}
            onChange={(e) => S.setField(row, { code: e.target.value })}
            onBlur={() => S.saveMeter(row)}
          />
          <input
            className="ubc-holder"
            placeholder="Tên chủ hộ"
            value={S.holderOf(row)}
            onChange={(e) => S.setField(row, { holder: e.target.value })}
            onBlur={() => S.saveMeter(row)}
          />
          {row.canDelete && (
            <button type="button" className="ubc-del" title="Xoá đồng hồ này" onClick={() => S.deleteMeter(row.accountId!)}>
              <Trash2 />
            </button>
          )}
        </div>

        {paid ? (
          <div className="ubc-paid">
            <span className="ubc-paid-pill">
              <UtilityReceiptThumb attachments={paid.attachments} onView={S.viewReceipt} size="sm" />
              <span className="ubc-paid-txt">
                <span className="ubc-paid-a">Đã đóng {paid.amount.toLocaleString('vi-VN')}</span>
                <span className="ubc-paid-m">{fmtDate(paid.date)} · {paid.by}</span>
              </span>
            </span>
            <span className="ubc-bookchip"><BookIcon size={13} />{paid.book}</span>
            <button
              type="button" className="ubc-cancel" title="Hủy phiếu thanh toán"
              disabled={!canRecordPayment}
              onClick={() => S.requestCancel(row)}
            >
              <X />
            </button>
          </div>
        ) : (
          <div className="ubc-pay">
            <input
              className="ub-amt" type="text" inputMode="numeric" placeholder="Số tiền"
              value={formatVN(amount)}
              onFocus={() => S.setActiveKey(k)}
              onChange={(e) => S.setAmount(k, parseVN(e.target.value))}
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
              onClick={() => S.submitPay(row, row.buildingName)}
            >
              {paying ? <span className="ub-spin" /> : <Check />}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderCard = (b: { id: string; name: string }) => {
    const all = S.metersOf(b.id);
    const rows = all.filter((r) => typeMatch(r.type) && !(onlyDue && S.paidThisKy(r.accountId)));
    if (rows.length === 0) return null;
    const dueN = all.filter((r) => !S.paidThisKy(r.accountId)).length;
    return (
      <div className="ubc" key={b.id}>
        <div className="ubc-head">
          <span className="ubc-bld">{b.name}</span>
          {dueN === 0 ? (
            <span className="ubc-badge done">Đã xong</span>
          ) : (
            <span className="ubc-badge pending">{dueN} khoản chưa đóng</span>
          )}
          {canRecordPayment && (
            <span className="ubc-add-wrap">
              <button type="button" className="ubc-add" title="Thêm đồng hồ điện" disabled={S.adding} onClick={() => S.addMeter(b.id, 'electric')}>
                <Zap /><Plus />
              </button>
              <button type="button" className="ubc-add" title="Thêm đồng hồ nước" disabled={S.adding} onClick={() => S.addMeter(b.id, 'water')}>
                <Droplet /><Plus />
              </button>
            </span>
          )}
        </div>
        {rows.map((row) => renderRow(row))}
      </div>
    );
  };

  const loading = loadingBld || S.loadingAccts || S.loadingPay;
  const visibleCards = buildings.map(renderCard).filter(Boolean);

  // Báo cáo lọc theo tòa (client): giữ ngày còn phiếu, tính lại tổng.
  const reportDays = reportBld === 'all'
    ? S.byDay
    : S.byDay
        .map((d) => {
          const rows = d.rows.filter((r) => r.building_id === reportBld);
          return rows.length ? { ...d, rows, sum: rows.reduce((s, r) => s + r.amount, 0) } : null;
        })
        .filter((d): d is typeof S.byDay[number] => d !== null);

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
            <>
              <div className="ub-rfilter">
                <select value={reportBld} onChange={(e) => setReportBld(e.target.value)}>
                  <option value="all">Tất cả tòa</option>
                  {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              {reportDays.length === 0 ? (
                <div className="c-empty"><div className="e-ic">🧾</div><p>{reportBld === 'all' ? `Kỳ ${fmtBillingMonth(billingMonth)} chưa có ngày nào đóng điện nước.` : 'Tòa này chưa có phiếu điện nước trong kỳ.'}</p></div>
              ) : (
                <div className="ub-report">
                  {reportDays.map((d) => (
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
                          <UtilityReceiptThumb attachments={r.attachments} onView={S.viewReceipt} size="md" />
                          <span className="ub-day-amt">{fmtFull(r.amount)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'chart' && (
            <div className="ub-chart">
              <div className="ub-chart-t">Chi điện nước qua các tháng</div>
              <div className="ub-chart-s">
                Tổng chi cho EVN / cấp nước · {chartBld === 'all' ? 'toàn bộ tòa' : buildings.find((b) => b.id === chartBld)?.name}
              </div>
              <div className="ub-rfilter" style={{ padding: '0 0 14px' }}>
                <select value={chartBld} onChange={(e) => setChartBld(e.target.value)}>
                  <option value="all">Tất cả tòa</option>
                  {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
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
      <AttachmentLightbox
        attachments={S.receiptView.attachments}
        index={S.receiptView.index}
        onIndexChange={S.setReceiptIndex}
      />
    </>
  );
}

export default UtilityBillSheet;
