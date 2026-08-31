// =============================================================================
// UtilityEnContent — nội dung họ "Điện & Nước" (KHÔNG header) để nhúng vào
// PeriodFeePanel / PeriodFeeSheet. Giữ NGUYÊN luồng đồng hồ hiện có
// (useUtilityPayState + pay_utility_bill). Tách từ body của surface
// UtilityDesktopPanel cũ (file đó + UtilityBillSheet đã XOÁ 31/08 — dead code
// 758 dòng, audit P3-01; cần khảo cổ thì xem git history).
//
// 30/07/2026 (Slice −1) — ba trạng thái ô thay vì hai:
//   đã đóng (phiếu đã duyệt) · ĐÃ TẠO CHỜ DUYỆT (§−1.1: `pay_utility_bill` sinh
//   phiếu UNAPPROVED khi tiền ≥ ngưỡng org; trước đây reader lọc cứng APPROVED
//   nên ô vẫn nói "chưa đóng" và mời bấm lại) · chưa đóng.
//   Dòng tổng hợp của toà CHƯA KHAI ĐỒNG HỒ không còn nút đóng tiền — đổi thành
//   "Tạo công tơ" (§−1.5: bấm đóng ở dòng đó gửi meter id NULL, server tự tạo
//   công tơ trong im lặng và ô không bao giờ hiện đã đóng).
// =============================================================================

import { useMemo, useState } from 'react';
import { Zap, Droplet, Check, Camera, BarChart3, User, Plus, Trash2, X, Gauge } from 'lucide-react';
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
    let sum = 0; let pendingSum = 0;
    let noMeterSum = 0; let noMeterCount = 0;
    const paidList: string[] = []; const dueList: string[] = []; const pendingList: string[] = [];
    const noMeterList: string[] = [];
    for (const b of buildings) {
      const ms = S.metersOf(b.id).filter((m) => m.type === t);
      let bSum = 0; let bPending = 0; let allPaid = ms.length > 0; let anyPending = false; let anyDue = false;
      for (const m of ms) {
        const p = S.paidThisKy(m.accountId);
        const q = S.pendingThisKy(m.accountId);
        if (p) bSum += p.amount; else allPaid = false;
        if (q) { bPending += q.amount; anyPending = true; }
        if (!p && !q) anyDue = true;
      }
      // Phiếu KHÔNG gắn đồng hồ: không thuộc ô nào nên trước đây bị bỏ khỏi mọi
      // tổng tính-từ-ô (org thật 9 phiếu / 7.956.000đ). Tiền đã ra két thì phải
      // vào "Đã thanh toán kỳ này", và toà đó phải được nêu tên để rà tay.
      const nm = S.noMeterThisKy(b.id, t);
      if (nm) {
        bSum += nm.amount; bPending += nm.pendingAmount;
        noMeterSum += nm.amount + nm.pendingAmount;
        noMeterCount += nm.count;
        noMeterList.push(b.name);
        if (nm.pendingAmount > 0) anyPending = true;
      }
      sum += bSum; pendingSum += bPending;
      // Toà có phiếu chờ duyệt KHÔNG bị gọi là "chưa đóng" (tiền chưa ra két
      // nhưng phiếu đã có) — nó có dòng riêng để chủ đi duyệt.
      if (allPaid) paidList.push(b.name);
      else {
        if (anyDue) dueList.push(b.name);
        if (anyPending) pendingList.push(b.name);
      }
    }
    return { sum, pendingSum, paidList, dueList, pendingList, noMeterSum, noMeterCount, noMeterList };
  };
  const statElec = statOf('electric');
  const statWater = statOf('water');

  const fBuildings = bldFilter === 'all' ? buildings : buildings.filter((b) => b.id === bldFilter);
  const tblRows: { row: MeterRow; first: boolean }[] = [];
  for (const b of fBuildings) {
    // "Chỉ tòa chưa đóng": ô đã có phiếu (duyệt HOẶC chờ duyệt) đều không còn là
    // việc phải làm → ẩn cả hai, đừng để phiếu chờ duyệt nằm trong danh sách nhắc.
    const rows = S.metersOf(b.id).filter((r) => typeMatch(r.type)
      && !(onlyDue && (S.paidThisKy(r.accountId) || S.pendingThisKy(r.accountId))));
    rows.forEach((row, i) => tblRows.push({ row, first: i === 0 }));
  }

  const loading = loadingBuildings || S.loadingAccts || S.loadingPay;

  const reportDays = reportBld === 'all'
    ? S.byDay
    : S.byDay
        .map((d) => {
          const rows = d.rows.filter((r) => r.building_id === reportBld);
          // Tổng ngày CHỈ cộng phiếu đã duyệt — phiếu chờ duyệt tách riêng.
          return rows.length ? {
            ...d, rows,
            sum: rows.filter((r) => !r.pending).reduce((s, r) => s + r.amount, 0),
            pendingSum: rows.filter((r) => r.pending).reduce((s, r) => s + r.amount, 0),
          } : null;
        })
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
          {stat.pendingList.length > 0 && (
            <div className="ud-stat-line">
              <span className="ud-stat-lbl due">{stat.pendingList.length} tòa chờ duyệt · {fmtFull(stat.pendingSum)}</span>
              <div className="ud-stat-chips">
                {stat.pendingList.map((n) => <span className="ud-chip due" key={n}>{n}</span>)}
              </div>
            </div>
          )}
          {/* GHI NHẬN, KHÔNG tự sửa: phiếu tay không gắn công tơ nào. Tiền đã tính
              vào tổng ở trên, nhưng không ô nào của bảng bên dưới nhận nó — nêu ra
              đây để đi rà, xem chi tiết ở tab Báo cáo. */}
          {stat.noMeterCount > 0 && (
            <div className="ud-stat-line">
              <span className="ud-stat-lbl due" title="Phiếu điện/nước không gắn đồng hồ nào — không hiện được trên dòng công tơ">
                {stat.noMeterCount} phiếu chưa gắn công tơ · {fmtFull(stat.noMeterSum)}
              </span>
              <div className="ud-stat-chips">
                {stat.noMeterList.map((n) => <span className="ud-chip due" key={n}>{n}</span>)}
              </div>
            </div>
          )}
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
                      const pending = paid ? undefined : S.pendingThisKy(row.accountId);
                      // Vừa gửi RPC, reader chưa refetch — ô phải khoá lại ngay.
                      const justPaid = paid || pending ? undefined : S.justPaidThisKy(row.accountId);
                      const locked = !!paid || !!pending || justPaid != null;
                      const amount = S.amountOf(k);
                      const paying = S.payingKey === k;
                      const Icon = t === 'electric' ? Zap : Droplet;
                      // Dòng synthetic không có đồng hồ để đính ảnh vào (ảnh sẽ
                      // mất khi dòng đổi khoá sau khi tạo công tơ) → không nhận dán.
                      return (
                        <tr key={k} className={first ? 'ud-first' : ''} {...(locked || row.isSynthetic ? {} : S.pasteProps(k))}>
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
                            ) : pending ? (
                              <span className={'ud-bookchip' + (pending.book ? '' : ' empty')}><BookIcon size={14} />{pending.book || 'chưa có sổ'}</span>
                            ) : row.isSynthetic ? (
                              <span className="ud-stat-none">—</span>
                            ) : (
                              <UtilityBookMenu accounts={S.myBooks} valueId={S.bookSel[k] ?? null} defaultId={S.defaultBookId} onPick={(id) => S.setBook(k, id)} disabled={!canRecordPayment} />
                            )}
                          </td>
                          <td className="num">
                            {paid ? (
                              <div className="ud-paidamt"><span className="ud-paidamt-a">{fmtFull(paid.amount)}</span><span className="ud-paidamt-m">{fmtDate(paid.date)} · {paid.by}</span></div>
                            ) : pending ? (
                              <div className="ud-paidamt">
                                <span className="ud-paidamt-a draft">{fmtFull(pending.amount)}</span>
                                <span className="ud-paidamt-m">đã tạo, chờ duyệt · {fmtDate(pending.date)} · {pending.by}</span>
                              </div>
                            ) : justPaid != null ? (
                              <div className="ud-paidamt">
                                <span className="ud-paidamt-a draft">{fmtFull(justPaid)}</span>
                                <span className="ud-paidamt-m">đã tạo phiếu — đang cập nhật danh sách</span>
                              </div>
                            ) : row.isSynthetic ? (
                              <span className="ud-stat-none">chưa khai công tơ</span>
                            ) : (
                              <input className="ud-amt" type="text" inputMode="numeric" placeholder="Số tiền" value={formatVN(amount)} onFocus={() => S.setActiveKey(k)} onChange={(e) => S.setAmount(k, parseVN(e.target.value))} />
                            )}
                          </td>
                          <td className="act">
                            {paid ? (
                              <span className="ud-acts">
                                <span className="ud-check"><Check /></span>
                                <UtilityReceiptThumb attachments={paid.attachments} onView={S.viewReceipt} size="md" />
                                <button type="button" className="ud-cancel" title="Hủy phiếu thanh toán" disabled={!canRecordPayment} onClick={() => S.requestCancel(row)}><X /></button>
                              </span>
                            ) : pending ? (
                              <span className="ud-acts">
                                <span className="ptt-badge-draft">CHỜ DUYỆT</span>
                                <UtilityReceiptThumb attachments={pending.attachments} onView={S.viewReceipt} size="md" />
                                <button type="button" className="ud-cancel" title="Hủy phiếu chờ duyệt" disabled={!canRecordPayment} onClick={() => S.requestCancel(row)}><X /></button>
                              </span>
                            ) : justPaid != null ? (
                              <span className="ud-acts"><span className="ptt-badge-draft">ĐÃ TẠO</span></span>
                            ) : row.isSynthetic ? (
                              // §−1.5: KHÔNG cho bấm đóng ở dòng chưa có đồng hồ —
                              // phải khai công tơ trước, tường minh.
                              <span className="ud-acts">
                                <button type="button" className="ptt-btn ghost sm" title={`Khai công tơ ${t === 'electric' ? 'điện' : 'nước'} cho ${row.buildingName} rồi mới đóng tiền được`}
                                  disabled={!canRecordPayment || S.creatingMeter} onClick={() => S.createMeter(row)}>
                                  {S.creatingMeter ? <span className="ub-spin dark" /> : <Gauge />}Tạo công tơ
                                </button>
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
                      <span className="ud-rday-lbl">Tổng chi trong ngày{d.pendingSum > 0 ? ` · chờ duyệt ${fmtFull(d.pendingSum)}` : ''}</span>
                      <span className="ud-rday-s">{fmtFull(d.sum)}</span>
                    </div>
                    <table className="ud-rtable">
                      <thead><tr><th>Giờ</th><th>Khoản</th><th>Tòa</th><th>Mã NCC</th><th>Người đóng</th><th>Sổ quỹ ghi chi</th><th className="ctr">Chứng từ</th><th className="num">Số tiền</th></tr></thead>
                      <tbody>
                        {d.rows.map((r) => (
                          <tr key={r.voucher_id}>
                            <td className="ud-mono2">{r.time}</td>
                            <td>
                              <span className="ud-khoan"><span className={'ud-khoan-ic ' + r.type}>{r.type === 'electric' ? <Zap /> : <Droplet />}</span>{r.type === 'electric' ? 'Điện' : 'Nước'}</span>
                              {r.pending && <span className="ptt-badge-draft">CHỜ DUYỆT</span>}
                            </td>
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
