// =============================================
// UtilityDesktopPanel — panel "Đóng tiền Điện nước" trên DESKTOP (cột trái).
// Thay chỗ ManagePanel khi mở Điện nước; ẩn <1024px (.tt-udesk). Port 100% từ
// mockup "Đóng tiền Điện nước.dc.html" (nửa trái .lp): header + 3 tab
// (Đóng tiền · Báo cáo · Biểu đồ) + 2 thẻ tổng điện/nước + bộ lọc + bảng +
// modal Hủy phiếu. Logic dùng chung useUtilityPayState (khớp mobile).
// =============================================

import { useMemo, useState } from 'react';
import {
  ArrowLeft, X, Zap, Droplet, Check, Camera, BarChart3, User, Image as ImageIcon,
} from 'lucide-react';
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
  billingMonth: string;
  onBillingMonthChange: (m: string) => void;
  onClose: () => void;
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

export function UtilityDesktopPanel({ billingMonth, onBillingMonthChange, onClose, canRecordPayment }: Props) {
  const { data: allBuildings = [], isLoading: loadingBld } = useIncomeExpenseFormBuildings();
  const buildings = useMemo(() => allBuildings.filter((b) => !b.is_virtual), [allBuildings]);
  const S = useUtilityPayState(billingMonth, buildings);

  const [tab, setTab] = useState<Tab>('pay');
  const [bldFilter, setBldFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [onlyDue, setOnlyDue] = useState(false);

  const chart = useUtilityChart(billingMonth, { enabled: tab === 'chart' });

  const typeMatch = (t: UtilType) =>
    typeFilter === 'all' || (typeFilter === 'electric' && t === 'electric') || (typeFilter === 'water' && t === 'water');

  // ── Thẻ tổng theo loại ──
  const statOf = (t: UtilType) => {
    let sum = 0;
    const paidList: string[] = [];
    const dueList: string[] = [];
    for (const b of buildings) {
      const p = S.paidThisKy(b.id, t);
      if (p) { sum += p.amount; paidList.push(b.name); }
      else dueList.push(b.name);
    }
    return { sum, paidList, dueList };
  };
  const statElec = statOf('electric');
  const statWater = statOf('water');

  // ── Hàng bảng ──
  const fBuildings = bldFilter === 'all' ? buildings : buildings.filter((b) => b.id === bldFilter);
  const tblRows: { b: { id: string; name: string }; t: UtilType; first: boolean }[] = [];
  for (const b of fBuildings) {
    const types = (['electric', 'water'] as UtilType[]).filter(
      (t) => typeMatch(t) && !(onlyDue && S.paidThisKy(b.id, t)),
    );
    types.forEach((t, i) => tblRows.push({ b, t, first: i === 0 }));
  }

  const loading = loadingBld || S.loadingAccts || S.loadingPay;

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
              {stat.paidList.length === 0
                ? <span className="ud-stat-none">—</span>
                : stat.paidList.map((n) => <span className="ud-chip paid" key={n}>{n}</span>)}
            </div>
          </div>
          <div className="ud-stat-line">
            <span className="ud-stat-lbl due">{stat.dueList.length} tòa chưa đóng</span>
            <div className="ud-stat-chips">
              {stat.dueList.length === 0
                ? <span className="ud-stat-done">Đã đóng đủ</span>
                : stat.dueList.map((n) => <span className="ud-chip due" key={n}>{n}</span>)}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="tt-udesk">
      <input ref={S.fileRef} type="file" accept="image/*" hidden onChange={S.onFileChange} />

      <div className="ud-head">
        <button type="button" className="ud-back" title="Về Thu tiền" onClick={onClose}><ArrowLeft /></button>
        <span className="ud-appic"><Zap /></span>
        <div className="ud-title">
          <h1>Đóng tiền Điện nước</h1>
          <p>Kỳ {fmtBillingMonth(billingMonth)} · chi cho EVN / cấp nước theo từng tòa</p>
        </div>
        <input
          className="ud-ky" type="month" value={billingMonth}
          onChange={(e) => e.target.value && onBillingMonthChange(e.target.value)}
        />
        <button type="button" className="ud-x" title="Tắt — quay lại Thu tiền" onClick={onClose}><X /></button>
      </div>

      <div className="ud-tabs">
        <button type="button" className={'ud-tab' + (tab === 'pay' ? ' on' : '')} onClick={() => setTab('pay')}>
          Đóng tiền <span className="ud-tab-n">{buildings.length}</span>
        </button>
        <button type="button" className={'ud-tab' + (tab === 'report' ? ' on' : '')} onClick={() => setTab('report')}>
          Báo cáo <span className="ud-tab-n">{S.byDay.length}</span>
        </button>
        <button type="button" className={'ud-tab' + (tab === 'chart' ? ' on' : '')} onClick={() => setTab('chart')}>
          <BarChart3 /> Biểu đồ
        </button>
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
                    {tblRows.map(({ b, t, first }) => {
                      const k = S.key(b.id, t);
                      const paid = S.paidThisKy(b.id, t);
                      const amount = S.amountOf(b.id, t);
                      const paying = S.payingKey === k;
                      const Icon = t === 'electric' ? Zap : Droplet;
                      return (
                        <tr key={k} className={first ? 'ud-first' : ''}>
                          <td className="ud-td-bld">{first ? <span className="ud-bldcode">{b.name}</span> : null}</td>
                          <td>
                            <span className="ud-khoan">
                              <span className={'ud-khoan-ic ' + t}><Icon /></span>
                              {t === 'electric' ? 'Điện' : 'Nước'}
                            </span>
                          </td>
                          <td>
                            <input
                              className="ud-code" placeholder={t === 'electric' ? 'Mã PE' : 'Mã nước'}
                              value={S.codeOf(b.id, t)}
                              onChange={(e) => S.setField(b.id, t, { code: e.target.value })}
                              onBlur={() => S.saveAccount(b.id, t)}
                            />
                          </td>
                          <td>
                            <input
                              className="ud-holder" placeholder="Tên chủ hộ"
                              value={S.holderOf(b.id, t)}
                              onChange={(e) => S.setField(b.id, t, { holder: e.target.value })}
                              onBlur={() => S.saveAccount(b.id, t)}
                            />
                          </td>
                          <td>
                            {paid ? (
                              <span className="ud-bookchip"><BookIcon size={14} />{paid.book}</span>
                            ) : (
                              <UtilityBookMenu
                                accounts={S.myBooks}
                                valueId={S.bookSel[k] ?? null}
                                defaultId={S.defaultBookId}
                                onPick={(id) => S.setBook(k, id)}
                                disabled={!canRecordPayment}
                              />
                            )}
                          </td>
                          <td className="num">
                            {paid ? (
                              <div className="ud-paidamt">
                                <span className="ud-paidamt-a">{fmtFull(paid.amount)}</span>
                                <span className="ud-paidamt-m">{fmtDate(paid.date)} · {paid.by}</span>
                              </div>
                            ) : (
                              <input
                                className="ud-amt" type="text" inputMode="numeric" placeholder="Số tiền"
                                value={formatVN(amount)}
                                onChange={(e) => S.setAmount(b.id, t, parseVN(e.target.value))}
                              />
                            )}
                          </td>
                          <td className="act">
                            {paid ? (
                              <span className="ud-acts">
                                <span className="ud-check"><Check /></span>
                                {paid.hasReceipt && paid.receiptUrl && (
                                  <button type="button" className="ud-rc" title="Xem ảnh phiếu" onClick={() => openReceipt(paid.receiptUrl!)}><ImageIcon /></button>
                                )}
                                <button type="button" className="ud-cancel" title="Hủy phiếu thanh toán" disabled={!canRecordPayment} onClick={() => S.requestCancel(b.id, t)}><X /></button>
                              </span>
                            ) : (
                              <span className="ud-acts">
                                <button
                                  type="button"
                                  className={'ud-attach' + (S.attach[k] ? ' has' : '')}
                                  title={S.attach[k] ? 'Đã đính kèm ảnh phiếu' : 'Đính kèm ảnh phiếu'}
                                  disabled={!canRecordPayment || S.uploadingKey === k}
                                  onClick={() => S.onAttachClick(k)}
                                >
                                  {S.uploadingKey === k ? <span className="ub-spin dark" /> : <Camera />}
                                </button>
                                <button
                                  type="button" className="ud-pay" title="Đóng tiền"
                                  disabled={!canRecordPayment || amount <= 0 || paying}
                                  onClick={() => S.submitPay(b.id, t, b.name)}
                                >
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
        <div className="ud-body">
          {S.byDay.length === 0 ? (
            <div className="ud-empty">🧾 Kỳ {fmtBillingMonth(billingMonth)} chưa có ngày nào đóng điện nước.</div>
          ) : (
            <div className="ud-report">
              {S.byDay.map((d) => (
                <div className="ud-rday" key={d.date}>
                  <div className="ud-rday-head">
                    <span className="ud-rday-d">{fmtDate(d.date)}</span>
                    <span className="ud-rday-c">{d.rows.length} phiếu</span>
                    <span className="ud-rday-lbl">Tổng chi trong ngày</span>
                    <span className="ud-rday-s">{fmtFull(d.sum)}</span>
                  </div>
                  <table className="ud-rtable">
                    <thead>
                      <tr>
                        <th>Giờ</th><th>Khoản</th><th>Tòa</th><th>Mã NCC</th>
                        <th>Người đóng</th><th>Sổ quỹ ghi chi</th><th className="ctr">Chứng từ</th><th className="num">Số tiền</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.rows.map((r) => (
                        <tr key={r.voucher_id}>
                          <td className="ud-mono2">{r.time}</td>
                          <td>
                            <span className="ud-khoan">
                              <span className={'ud-khoan-ic ' + r.type}>{r.type === 'electric' ? <Zap /> : <Droplet />}</span>
                              {r.type === 'electric' ? 'Điện' : 'Nước'}
                            </span>
                          </td>
                          <td className="ud-mono">{r.buildingName}</td>
                          <td className="ud-mono2">{S.byKey(r.building_id, r.type)?.code ?? '—'}</td>
                          <td>
                            <span className="ud-by"><span className="ud-by-ic"><User /></span>{r.by || '—'}</span>
                          </td>
                          <td><span className="ud-bookchip"><BookIcon size={14} />{r.book}</span></td>
                          <td className="ctr">
                            {r.hasReceipt && r.receiptUrl ? (
                              <button type="button" className="ud-rc" title="Xem ảnh phiếu chi" onClick={() => openReceipt(r.receiptUrl!)}><ImageIcon /></button>
                            ) : (
                              <span className="ud-nodoc">Chưa có</span>
                            )}
                          </td>
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
      )}

      {tab === 'chart' && (
        <div className="ud-body">
          <div className="ud-chart-t">Chi điện nước qua các tháng</div>
          <div className="ud-chart-s">Tổng tiền đã chi cho EVN / cấp nước theo từng kỳ · toàn bộ tòa trong phạm vi</div>
          <div className="ud-chart-card">
            {chart.isLoading ? (
              <div className="ud-empty">⏳ Đang tải biểu đồ…</div>
            ) : (
              <UtilityChart months={chart.data ?? []} />
            )}
          </div>
        </div>
      )}

      <UtilityCancelModal
        target={S.cancelTarget}
        busy={S.cancelling}
        onClose={S.closeCancel}
        onConfirm={S.confirmCancel}
      />
    </div>
  );
}

export default UtilityDesktopPanel;
