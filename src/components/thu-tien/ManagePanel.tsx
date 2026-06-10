// =============================================
// ManagePanel — cột quản lý Thu tiền trên DESKTOP (75% trái).
// CSS ẩn dưới 1024px (.tt-manage) — mobile vẫn chỉ thấy khung thu tiền.
// Data: useCollectionReport (TẤT CẢ toà của kỳ, RLS tự giới hạn) rồi lọc
// client-side theo toà → 1 query phục vụ cả KPI, bảng theo toà lẫn chi tiết.
// Đồng bộ với khung demo bên phải: dùng chung billingMonth; click 1 toà
// trong bảng → đổi toà đang mở trên khung demo (onPickBuilding).
// =============================================

import { useMemo, useState } from 'react';
import { ArrowLeft, Smartphone } from 'lucide-react';
import { useCollectionReport } from '@/hooks/useCollectionReport';
import {
  collectStatus,
  fmtBillingMonth,
  fmtFull,
  fmtK,
  paymentsInRange,
  remainingOf,
  todayISO,
} from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  buildings: { id: string; name: string }[];
  billingMonth: string;
  onBillingMonthChange: (m: string) => void;
  /** Toà đang mở trên khung demo mobile (đánh dấu icon điện thoại). */
  phoneBuildingId: string;
  onPickBuilding: (id: string) => void;
  onBack: () => void;
}

type TimeSel = 'all' | 'today' | 'date';

const bName = (inv: InvoiceWithRelations) => inv.building?.name ?? '—';
const byBuildingRoom = (a: InvoiceWithRelations, z: InvoiceWithRelations) =>
  bName(a) === bName(z)
    ? (a.room?.name ?? '').localeCompare(z.room?.name ?? '', 'vi', { numeric: true })
    : bName(a).localeCompare(bName(z), 'vi');

export function ManagePanel({
  buildings,
  billingMonth,
  onBillingMonthChange,
  phoneBuildingId,
  onPickBuilding,
  onBack,
}: Props) {
  const [bSel, setBSel] = useState('all');
  const [tSel, setTSel] = useState<TimeSel>('all');
  const [day, setDay] = useState(todayISO());

  const { invoices, isLoading } = useCollectionReport({ billing_month: billingMonth });

  // Phạm vi thời gian — cùng ngữ nghĩa với CollectionReport trong khung mobile.
  const scopeDay = tSel === 'today' ? todayISO() : day;
  const scopeCollected = (inv: InvoiceWithRelations) =>
    tSel === 'all' ? inv.paid_amount ?? 0 : paymentsInRange(inv, scopeDay, scopeDay).sum;
  const inScope = (inv: InvoiceWithRelations) =>
    tSel === 'all' ? (inv.paid_amount ?? 0) > 0 : paymentsInRange(inv, scopeDay, scopeDay).has;

  const filtered = useMemo(
    () => (bSel === 'all' ? invoices : invoices.filter((i) => i.building_id === bSel)),
    [invoices, bSel],
  );
  const collectedRows = useMemo(
    () => filtered.filter(inScope).slice().sort(byBuildingRoom),
    [filtered, tSel, day],
  );
  const dueRows = useMemo(
    () => filtered.filter((i) => collectStatus(i) !== 'paid').slice().sort(byBuildingRoom),
    [filtered],
  );

  const totalCollected = collectedRows.reduce((s, r) => s + scopeCollected(r), 0);
  const totalRemaining = dueRows.reduce((s, r) => s + remainingOf(r), 0);
  const periodPaid = filtered.reduce((s, r) => s + (r.paid_amount ?? 0), 0);
  const periodTotal = filtered.reduce((s, r) => s + (r.total_amount ?? 0), 0);
  const periodPct = periodTotal > 0 ? Math.round((periodPaid / periodTotal) * 100) : 0;

  // Bảng "Theo tòa nhà" luôn tính trên MỌI toà (không theo bSel) để so sánh nhanh.
  const buildingStats = useMemo(
    () =>
      buildings
        .map((b) => {
          const rows = invoices.filter((i) => i.building_id === b.id);
          const paid = rows.reduce((s, r) => s + (r.paid_amount ?? 0), 0);
          const total = rows.reduce((s, r) => s + (r.total_amount ?? 0), 0);
          return {
            b,
            rooms: rows.length,
            done: rows.filter((r) => collectStatus(r) === 'paid').length,
            collected: rows.filter(inScope).reduce((s, r) => s + scopeCollected(r), 0),
            remaining: rows
              .filter((r) => collectStatus(r) !== 'paid')
              .reduce((s, r) => s + remainingOf(r), 0),
            pct: total > 0 ? Math.round((paid / total) * 100) : 0,
          };
        })
        .filter((g) => g.rooms > 0),
    [buildings, invoices, tSel, day],
  );

  const timeName =
    tSel === 'all'
      ? `Cả kỳ ${fmtBillingMonth(billingMonth)}`
      : tSel === 'today'
        ? 'Hôm nay'
        : `Ngày ${day.split('-').reverse().slice(0, 2).join('/')}`;
  const showBuildingCol = bSel === 'all';

  const dueByBuilding = buildings
    .map((b) => ({ b, rows: dueRows.filter((r) => r.building_id === b.id) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="tt-manage">
      <div className="tm-head">
        <button type="button" className="tm-back" title="Quay lại" onClick={onBack}>
          <ArrowLeft />
        </button>
        <div className="tm-title">
          <h1>Thu tiền</h1>
          <p>Quản lý &amp; báo cáo thu tiền mặt · thao tác thu trên khung mobile bên phải</p>
        </div>
        <input
          className="ky-input"
          type="month"
          value={billingMonth}
          onChange={(e) => e.target.value && onBillingMonthChange(e.target.value)}
        />
      </div>

      <div className="tm-toolbar">
        <label className="tm-dd">
          <span>Tòa nhà</span>
          <select value={bSel} onChange={(e) => setBSel(e.target.value)}>
            <option value="all">Tất cả tòa</option>
            {buildings.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>
        <div className="tm-dd">
          <span>Thời gian</span>
          <div className="tm-seg">
            {([
              ['all', `Cả kỳ ${fmtBillingMonth(billingMonth)}`],
              ['today', 'Hôm nay'],
              ['date', 'Chọn ngày'],
            ] as [TimeSel, string][]).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={tSel === v ? 'on' : ''}
                onClick={() => setTSel(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {tSel === 'date' && (
          <label className="tm-dd">
            <span>Ngày</span>
            <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </label>
        )}
      </div>

      <div className="tm-kpis">
        <div className="tm-kpi">
          <span className="tm-kpi-l">Đã thu · {timeName}</span>
          <span className="tm-kpi-v paid">{fmtFull(totalCollected)}</span>
          <span className="tm-kpi-s">{collectedRows.length} phòng có phiếu thu</span>
        </div>
        <div className="tm-kpi">
          <span className="tm-kpi-l">Còn phải thu</span>
          <span className="tm-kpi-v due">{fmtFull(totalRemaining)}</span>
          <span className="tm-kpi-s">{dueRows.length} phòng chưa thu đủ</span>
        </div>
        <div className="tm-kpi">
          <span className="tm-kpi-l">Hoá đơn trong kỳ</span>
          <span className="tm-kpi-v">{filtered.length}</span>
          <span className="tm-kpi-s">{filtered.length - dueRows.length} phòng đã thu đủ</span>
        </div>
        <div className="tm-kpi">
          <span className="tm-kpi-l">Tiến độ kỳ</span>
          <span className="tm-kpi-v">{periodPct}%</span>
          <span className="tm-bar"><i style={{ width: `${periodPct}%` }} /></span>
          <span className="tm-kpi-s">{fmtFull(periodPaid)} / {fmtFull(periodTotal)}</span>
        </div>
      </div>

      {isLoading ? (
        <div className="tm-empty">⏳ Đang tải hoá đơn kỳ {fmtBillingMonth(billingMonth)}…</div>
      ) : invoices.length === 0 ? (
        <div className="tm-empty">🔍 Không có hoá đơn nào trong kỳ {fmtBillingMonth(billingMonth)}.</div>
      ) : (
        <div className="tm-body">
          <div className="tm-sec">
            <div className="tm-sec-head">
              <span className="tm-sec-title">Theo tòa nhà</span>
              <span className="tm-sec-sub">Đã thu tính theo {timeName.toLowerCase()} · click 1 tòa để mở trên khung demo</span>
            </div>
            <table className="tm-table">
              <thead>
                <tr>
                  <th>Tòa</th>
                  <th className="num">Phòng</th>
                  <th className="num">Đã thu</th>
                  <th className="num">Còn phải thu</th>
                  <th className="bar">Tiến độ kỳ</th>
                </tr>
              </thead>
              <tbody>
                {buildingStats.map(({ b, rooms, done, collected, remaining, pct }) => (
                  <tr
                    key={b.id}
                    className={'tm-brow' + (phoneBuildingId === b.id ? ' on' : '')}
                    onClick={() => {
                      onPickBuilding(b.id);
                      setBSel(b.id);
                    }}
                  >
                    <td>
                      <span className="tm-bname">{b.name}</span>
                      {phoneBuildingId === b.id && <Smartphone className="tm-phone-ic" />}
                    </td>
                    <td className="num">{done}/{rooms}</td>
                    <td className="num paid">{fmtFull(collected)}</td>
                    <td className="num due">{remaining > 0 ? fmtFull(remaining) : '—'}</td>
                    <td className="bar">
                      <span className="tm-bar"><i style={{ width: `${pct}%` }} /></span>
                      <span className="tm-pct">{pct}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="tm-cols">
            <div className="tm-sec">
              <div className="tm-sec-head">
                <span className="tm-sec-title">Đã thu · {timeName}</span>
                <span className="tm-sec-sub">{collectedRows.length} phòng · {fmtFull(totalCollected)}</span>
              </div>
              {collectedRows.length === 0 ? (
                <div className="tm-empty">🧾 Chưa thu khoản nào trong phạm vi này.</div>
              ) : (
                <table className="tm-table">
                  <thead>
                    <tr>
                      <th>Phòng</th>
                      {showBuildingCol && <th>Tòa</th>}
                      <th>Trạng thái</th>
                      <th className="num">Đã thu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collectedRows.map((r) => {
                      const full = collectStatus(r) === 'paid';
                      return (
                        <tr key={r.id}>
                          <td><span className="tm-room">{r.room?.name}</span></td>
                          {showBuildingCol && <td className="tm-bcell">{bName(r)}</td>}
                          <td>
                            <span className={'rp-tag ' + (full ? 'full' : 'part')}>
                              {full ? 'Thu đủ' : `Thiếu ${fmtK(remainingOf(r))}`}
                            </span>
                          </td>
                          <td className="num paid">{fmtFull(scopeCollected(r))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="tm-sec">
              <div className="tm-sec-head">
                <span className="tm-sec-title due">Chưa thu</span>
                <span className="tm-sec-sub">{dueRows.length} phòng · {fmtFull(totalRemaining)}</span>
              </div>
              {dueRows.length === 0 ? (
                <div className="tm-empty">🎉 Đã thu xong toàn bộ phạm vi này!</div>
              ) : (
                <div className="tm-due">
                  {dueByBuilding.map(({ b, rows }) => (
                    <div className="tm-due-grp" key={b.id}>
                      <div className="tm-due-gb">{b.name} · {rows.length} phòng</div>
                      <div className="rp-due-chips">
                        {rows.map((r) => (
                          <span className="rp-due-chip" key={r.id}>
                            {r.room?.name} · {fmtK(remainingOf(r))}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ManagePanel;
