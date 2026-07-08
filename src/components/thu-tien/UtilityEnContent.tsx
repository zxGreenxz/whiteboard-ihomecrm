// =============================================================================
// UtilityEnContent — nội dung họ "Điện & Nước" (KHÔNG header) để nhúng vào
// PeriodFeePanel / PeriodFeeSheet. Giữ NGUYÊN luồng đồng hồ hiện có
// (useUtilityPayState + pay_utility_bill). Tách từ UtilityDesktopPanel body.
// =============================================================================

import { useMemo, useState } from 'react';
import { Zap, Droplet, Check, Camera, BarChart3, User, Plus, Trash2, X } from 'lucide-react';
import { fmtFull, fmtBillingMonth } from '@/lib/collect';
import { useUtilityChart, type UtilType } from '@/hooks/useUtilityBills';
import { useUtilityPayState, type MeterRow } from '@/hooks/useUtilityPayState';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import { UtilityChart } from './UtilityChart';
import { UtilityBookMenu } from './UtilityBookMenu';
import { UtilityCancelModal } from './UtilityCancelModal';
import { UtilityReceiptThumb } from './UtilityReceiptThumb';
import { BookIcon } from './utilityIcons';

interface Props {
  billingMonth: string;
  buildings: { id: string; name: string }[];
  canRecordPayment: boolean;
  loadingBuildings: boolean;
}

type Tab = 'pay' | 'report' | 'chart';
type TypeFilter = 'all' | 'electric' | 'water';

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string) => { const d = s.replace(/\D/g, ''); return d ? parseInt(d, 10) : 0; };
const fmtDate = (d?: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

export function UtilityEnContent({ billingMonth, buildings, canRecordPayment, loadingBuildings }: Props) {
  const S = useUtilityPayState(billingMonth, buildings);

  const [tab, setTab] = useState<Tab>('pay');
  const [bldFilter, setBldFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [onlyDue, setOnlyDue] = useState(false);
  const [reportBld, setReportBld] = useState<string>('all');
  const [chartBld, setChartBld] = useState<string>('all');

  const chart = useUtilityChart(billingMonth, { enabled: tab === 'chart', buildingId: chartBld === 'all' ? null : chartBld });

  const typeMatch = (t: UtilType) =>
    typeFilter === 'all' || (typeFilter === 'electric' && t === 'electric') || (typeFilter === 'water' && t === 'water');

  const statOf = (t: UtilType) => {
    let sum = 0; const paidList: string[] = []; const dueList: string[] = [];
    for (const b of buildings) {
      const ms = S.metersOf(b.id).filter((m) => m.type === t);
      let bSum = 0; let allPaid = ms.length > 0;
      for (const m of ms) { const p = S.paidThisKy(m.accountId); if (p) bSum += p.amount; else allPaid = false; }
      sum += bSum;
      if (allPaid) paidList.push(b.name); else dueList.push(b.name);
    }
    return { sum, paidList, dueList };
  };
  const statElec = statOf('electric');
  const statWater = statOf('water');

  const fBuildings = bldFilter === 'all' ? buildings : buildings.filter((b) => b.id === bldFilter);
  const tblRows: { row: MeterRow; first: boolean }[] = [];
  for (const b of fBuildings) {
    const rows = S.metersOf(b.id).filter((r) => typeMatch(r.type) && !(onlyDue && S.paidThisKy(r.accountId)));
    rows.forEach((row, i) => tblRows.push({ row, first: i === 0 }));
  }

  const loading = loadingBuildings || S.loadingAccts || S.loadingPay;

  const reportDays = reportBld === 'all'
    ? S.byDay
    : S.byDay
        .map((d) => { const rows = d.rows.filter((r) => r.building_id === reportBld); return rows.length ? { ...d, rows, sum: rows.reduce((s, r) => s + r.amount, 0) } : null; })
        .filter((d): d is typeof S.byDay[number] => d !== null);

  const StatCard = ({ t, stat }: { t: UtilType; stat: ReturnType<typeof statOf> }) => {
    const isElec = t === 'electric';
    return (
      <div className={'ud-stat ' + t}>
        <div className="ud-stat-top">
          <span className={'ud-stat-ic ' + t}>{isElec ? <Zap /> : <Droplet />}</span>
          <div className="ud-stat-h">
            <div className="ud-stat-title">{isElec ? 'Tiền điện · EVN' : 'Tiền nước · Cấp nước'}</div>
            <div className="ud-stat-sub">Đã thanh toán kỳ này</div>
          </div>
          <span className="ud-stat-amt">{fmtFull(stat.sum)}</span>
        </div>
        <div className="ud-stat-lines">
          <div className="ud-stat-line">
            <span className="ud-stat-lbl paid">{stat.paidList.length} tòa đã đóng</span>
            <div className="ud-stat-chips">
              {stat.paidList.length === 0 ? <span className="ud-stat-none">—</span> : stat.paidList.map((n) => <span className="ud-chip paid" key={n}>{n}</span>)}
            </div>
          </div>
          <div className="ud-stat-line">
            <span className="ud-stat-lbl due">{stat.dueList.length} tòa chưa đóng</span>
            <div className="ud-stat-chips">
              {stat.dueList.length === 0 ? <span className="ud-stat-done">Đã đóng đủ</span> : stat.dueList.map((n) => <span className="ud-chip due" key={n}>{n}</span>)}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <input ref={S.fileRef} type="file" accept="image/*" hidden onChange={S.onFileChange} />

      <div className="ud-tabs">
        <button type="button" className={'ud-tab' + (tab === 'pay' ? ' on' : '')} onClick={() => setTab('pay')}>Đóng tiền <span className="ud-tab-n">{buildings.length}</span></button>
        <button type="button" className={'ud-tab' + (tab === 'report' ? ' on' : '')} onClick={() => setTab('report')}>Báo cáo <span className="ud-tab-n">{S.byDay.length}</span></button>
        <button type="button" className={'ud-tab' + (tab === 'chart' ? ' on' : '')} onClick={() => setTab('chart')}><BarChart3 /> Biểu đồ</button>
      </div>

      {(tab === 'pay' || tab === 'report') && (
        <div className="ud-stats">
          <StatCard t="electric" stat={statElec} />
          <StatCard t="water" stat={statWater} />
        </div>
      )}

      {tab === 'pay' && (
        <>
          <div className="ud-toolbar">
            <label className="ud-dd">
              <span>Tòa nhà</span>
              <select value={bldFilter} onChange={(e) => setBldFilter(e.target.value)}>
                <option value="all">Tất cả tòa</option>
                {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <div className="ud-dd">
              <span>Loại</span>
              <div className="ud-seg">
                <button type="button" className={typeFilter === 'all' ? 'on' : ''} onClick={() => setTypeFilter('all')}>Tất cả</button>
                <button type="button" className={typeFilter === 'electric' ? 'on' : ''} onClick={() => setTypeFilter('electric')}><Zap />Điện</button>
                <button type="button" className={typeFilter === 'water' ? 'on' : ''} onClick={() => setTypeFilter('water')}><Droplet />Nước</button>
              </div>
            </div>
            <button type="button" className={'ud-due' + (onlyDue ? ' on' : '')} onClick={() => setOnlyDue((v) => !v)}>
              {onlyDue ? <Check /> : <span className="ud-due-box" />}Chỉ tòa chưa đóng
            </button>
          </div>

          <div className="ud-body">
            {loading ? (
              <div className="ud-empty">⏳ Đang tải dữ liệu điện nước…</div>
            ) : buildings.length === 0 ? (
              <div className="ud-empty">🏢 Chưa có tòa nhà nào trong phạm vi của bạn.</div>
            ) : tblRows.length === 0 ? (
              <div className="ud-empty">🎉 Không còn khoản nào khớp bộ lọc.</div>
            ) : (
              <div className="ud-tablewrap">
                <table className="ud-table">
                  <thead>
                    <tr>
                      <th>Tòa</th><th>Khoản</th><th>Mã NCC</th><th>Chủ hộ</th>
                      <th>Sổ quỹ ghi chi</th><th className="num">Số tiền</th><th className="act">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tblRows.map(({ row, first }) => {
                      const k = row.key; const t = row.type;
                      const paid = S.paidThisKy(row.accountId);
                      const amount = S.amountOf(k);
                      const paying = S.payingKey === k;
                      const Icon = t === 'electric' ? Zap : Droplet;
                      return (
                        <tr key={k} className={first ? 'ud-first' : ''}>
                          <td className="ud-td-bld">
                            {first ? (
                              <div className="ud-bldcell">
                                <span className="ud-bldcode">{row.buildingName}</span>
                                {canRecordPayment && (
                                  <span className="ud-add-wrap">
                                    <button type="button" className="ud-add" title="Thêm đồng hồ điện" disabled={S.adding} onClick={() => S.addMeter(row.buildingId, 'electric')}><Zap /><Plus /></button>
                                    <button type="button" className="ud-add" title="Thêm đồng hồ nước" disabled={S.adding} onClick={() => S.addMeter(row.buildingId, 'water')}><Droplet /><Plus /></button>
                                  </span>
                                )}
                              </div>
                            ) : null}
                          </td>
                          <td><span className="ud-khoan"><span className={'ud-khoan-ic ' + t}><Icon /></span>{t === 'electric' ? 'Điện' : 'Nước'}</span></td>
                          <td>
                            <span className="ud-codecell">
                              <input className="ud-code" placeholder={t === 'electric' ? 'Mã PE' : 'Mã nước'} value={S.codeOf(row)} onChange={(e) => S.setField(row, { code: e.target.value })} onBlur={() => S.saveMeter(row)} />
                              {row.canDelete && <button type="button" className="ud-del" title="Xoá đồng hồ này" onClick={() => S.deleteMeter(row.accountId!)}><Trash2 /></button>}
                            </span>
                          </td>
                          <td><input className="ud-holder" placeholder="Tên chủ hộ" value={S.holderOf(row)} onChange={(e) => S.setField(row, { holder: e.target.value })} onBlur={() => S.saveMeter(row)} /></td>
                          <td>
                            {paid ? (
                              <span className="ud-bookchip"><BookIcon size={14} />{paid.book}</span>
                            ) : (
                              <UtilityBookMenu accounts={S.myBooks} valueId={S.bookSel[k] ?? null} defaultId={S.defaultBookId} onPick={(id) => S.setBook(k, id)} disabled={!canRecordPayment} />
                            )}
                          </td>
                          <td className="num">
                            {paid ? (
                              <div className="ud-paidamt"><span className="ud-paidamt-a">{fmtFull(paid.amount)}</span><span className="ud-paidamt-m">{fmtDate(paid.date)} · {paid.by}</span></div>
                            ) : (
                              <input className="ud-amt" type="text" inputMode="numeric" placeholder="Số tiền" value={formatVN(amount)} onChange={(e) => S.setAmount(k, parseVN(e.target.value))} />
                            )}
                          </td>
                          <td className="act">
                            {paid ? (
                              <span className="ud-acts">
                                <span className="ud-check"><Check /></span>
                                <UtilityReceiptThumb attachments={paid.attachments} onView={S.viewReceipt} size="md" />
                                <button type="button" className="ud-cancel" title="Hủy phiếu thanh toán" disabled={!canRecordPayment} onClick={() => S.requestCancel(row)}><X /></button>
                              </span>
                            ) : (
                              <span className="ud-acts">
                                <button type="button" className={'ud-attach' + (S.attach[k] ? ' has' : '')} title={S.attach[k] ? 'Đã đính kèm ảnh phiếu' : 'Đính kèm ảnh phiếu'} disabled={!canRecordPayment || S.uploadingKey === k} onClick={() => S.onAttachClick(k)}>
                                  {S.uploadingKey === k ? <span className="ub-spin dark" /> : <Camera />}
                                </button>
                                <button type="button" className="ud-pay" title="Đóng tiền" disabled={!canRecordPayment || amount <= 0 || paying} onClick={() => S.submitPay(row, row.buildingName)}>
                                  {paying ? <span className="ub-spin" /> : <Check />}
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'report' && (
        <>
          <div className="ud-toolbar">
            <label className="ud-dd">
              <span>Tòa nhà</span>
              <select value={reportBld} onChange={(e) => setReportBld(e.target.value)}>
                <option value="all">Tất cả tòa</option>
                {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          </div>
          <div className="ud-body">
            {reportDays.length === 0 ? (
              <div className="ud-empty">🧾 {reportBld === 'all' ? `Kỳ ${fmtBillingMonth(billingMonth)} chưa có ngày nào đóng điện nước.` : 'Tòa này chưa có phiếu điện nước trong kỳ.'}</div>
            ) : (
              <div className="ud-report">
                {reportDays.map((d) => (
                  <div className="ud-rday" key={d.date}>
                    <div className="ud-rday-head">
                      <span className="ud-rday-d">{fmtDate(d.date)}</span>
                      <span className="ud-rday-c">{d.rows.length} phiếu</span>
                      <span className="ud-rday-lbl">Tổng chi trong ngày</span>
                      <span className="ud-rday-s">{fmtFull(d.sum)}</span>
                    </div>
                    <table className="ud-rtable">
                      <thead><tr><th>Giờ</th><th>Khoản</th><th>Tòa</th><th>Mã NCC</th><th>Người đóng</th><th>Sổ quỹ ghi chi</th><th className="ctr">Chứng từ</th><th className="num">Số tiền</th></tr></thead>
                      <tbody>
                        {d.rows.map((r) => (
                          <tr key={r.voucher_id}>
                            <td className="ud-mono2">{r.time}</td>
                            <td><span className="ud-khoan"><span className={'ud-khoan-ic ' + r.type}>{r.type === 'electric' ? <Zap /> : <Droplet />}</span>{r.type === 'electric' ? 'Điện' : 'Nước'}</span></td>
                            <td className="ud-mono">{r.buildingName}</td>
                            <td className="ud-mono2">{r.code || '—'}</td>
                            <td><span className="ud-by"><span className="ud-by-ic"><User /></span>{r.by || '—'}</span></td>
                            <td><span className="ud-bookchip"><BookIcon size={14} />{r.book}</span></td>
                            <td className="ctr"><UtilityReceiptThumb attachments={r.attachments} onView={S.viewReceipt} size="md" /></td>
                            <td className="num ud-mono">{fmtFull(r.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'chart' && (
        <>
          <div className="ud-toolbar">
            <label className="ud-dd">
              <span>Tòa nhà</span>
              <select value={chartBld} onChange={(e) => setChartBld(e.target.value)}>
                <option value="all">Tất cả tòa</option>
                {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          </div>
          <div className="ud-body">
            <div className="ud-chart-t">Chi điện nước qua các tháng</div>
            <div className="ud-chart-s">Tổng tiền đã chi cho EVN / cấp nước theo từng kỳ · {chartBld === 'all' ? 'toàn bộ tòa trong phạm vi' : buildings.find((b) => b.id === chartBld)?.name}</div>
            <div className="ud-chart-card">
              {chart.isLoading ? <div className="ud-empty">⏳ Đang tải biểu đồ…</div> : <UtilityChart months={chart.data ?? []} />}
            </div>
          </div>
        </>
      )}

      <UtilityCancelModal target={S.cancelTarget} busy={S.cancelling} onClose={S.closeCancel} onConfirm={S.confirmCancel} />
      <AttachmentLightbox attachments={S.receiptView.attachments} index={S.receiptView.index} onIndexChange={S.setReceiptIndex} />
    </>
  );
}

export default UtilityEnContent;
