import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { useCollectionReport } from '@/hooks/useCollectionReport';
import {
  collectStatus,
  fmtFull,
  fmtK,
  paymentsInRange,
  remainingOf,
  todayISO,
  fmtBillingMonth,
} from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  show: boolean;
  onClose: () => void;
  buildings: { id: string; name: string }[];
  defaultBuildingId: string;
  billingMonth: string;
}

type TimeSel = 'all' | 'today' | 'date';

const bName = (inv: InvoiceWithRelations) => inv.building?.name ?? '—';
const byBuildingRoom = (a: InvoiceWithRelations, z: InvoiceWithRelations) =>
  bName(a) === bName(z)
    ? (a.room?.name ?? '').localeCompare(z.room?.name ?? '', 'vi', { numeric: true })
    : bName(a).localeCompare(bName(z), 'vi');

export function CollectionReport({ show, onClose, buildings, defaultBuildingId, billingMonth }: Props) {
  const [bSel, setBSel] = useState(defaultBuildingId);
  const [tSel, setTSel] = useState<TimeSel>('all');
  const [day, setDay] = useState(todayISO());

  useEffect(() => {
    if (show) setBSel(defaultBuildingId);
  }, [show, defaultBuildingId]);

  const { invoices } = useCollectionReport({
    building_id: bSel === 'all' ? undefined : bSel,
    billing_month: billingMonth,
  });

  const scopeDay = tSel === 'today' ? todayISO() : day;
  const scopeCollected = (inv: InvoiceWithRelations) =>
    tSel === 'all' ? inv.paid_amount ?? 0 : paymentsInRange(inv, scopeDay, scopeDay).sum;
  const inScope = (inv: InvoiceWithRelations) =>
    tSel === 'all' ? (inv.paid_amount ?? 0) > 0 : paymentsInRange(inv, scopeDay, scopeDay).has;

  const collectedRows = useMemo(
    () => invoices.filter(inScope).slice().sort(byBuildingRoom),
    [invoices, tSel, day],
  );
  const dueRows = useMemo(
    () => invoices.filter((i) => collectStatus(i) !== 'paid').slice().sort(byBuildingRoom),
    [invoices],
  );
  const totalCollected = collectedRows.reduce((s, r) => s + scopeCollected(r), 0);
  const totalRemaining = dueRows.reduce((s, r) => s + remainingOf(r), 0);
  const showAll = bSel === 'all';

  const scopeName = showAll ? 'Tất cả tòa' : buildings.find((b) => b.id === bSel)?.name ?? '';
  const timeName =
    tSel === 'all'
      ? `Cả kỳ ${fmtBillingMonth(billingMonth)}`
      : tSel === 'today'
        ? 'Hôm nay'
        : `Ngày ${day.split('-').reverse().slice(0, 2).join('/')}`;

  const dueByBuilding = buildings
    .map((b) => ({ b, rows: dueRows.filter((r) => bName(r) === b.name) }))
    .filter((g) => g.rows.length > 0);

  return (
    <>
      <div className={'sheet-scrim' + (show ? ' show' : '')} onClick={onClose} />
      <div className={'sheet full' + (show ? ' show' : '')}>
        <div className="rp-topbar">
          <div>
            <div className="rp-title">Báo cáo thu tiền</div>
            <div className="rp-sub">{scopeName} · {timeName}</div>
          </div>
          <button type="button" className="rp-x" onClick={onClose}>
            <X />
          </button>
        </div>

        <div className="rp-filters">
          <label className="rp-dd">
            <span className="rp-dd-l">Tòa nhà</span>
            <div className="rp-dd-sel">
              <select value={bSel} onChange={(e) => setBSel(e.target.value)}>
                <option value="all">Tất cả tòa</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <ChevronRight />
            </div>
          </label>
          <label className="rp-dd">
            <span className="rp-dd-l">Thời gian</span>
            <div className="rp-dd-sel">
              <select value={tSel} onChange={(e) => setTSel(e.target.value as TimeSel)}>
                <option value="all">Cả kỳ {fmtBillingMonth(billingMonth)}</option>
                <option value="today">Hôm nay</option>
                <option value="date">Chọn ngày…</option>
              </select>
              <ChevronRight />
            </div>
          </label>
        </div>
        {tSel === 'date' && (
          <div className="rp-dateline">
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </div>
        )}

        <div className="sheet-scroll rp-body">
          <div className="rp-total">
            <div className="rp-total-main">
              <span className="rp-tl">Tổng đã thu</span>
              <span className="rp-tv">{fmtFull(totalCollected)}</span>
            </div>
            <div className="rp-total-sub">
              {collectedRows.length} phòng đã thu
              {totalRemaining > 0 ? ` · còn phải thu ${fmtFull(totalRemaining)}` : ''}
            </div>
          </div>

          {collectedRows.length === 0 ? (
            <div className="c-empty">
              <div className="e-ic">🧾</div>
              <p>Chưa thu khoản nào trong phạm vi này.</p>
            </div>
          ) : (
            <div className="rp-list">
              <div className="rp-lhead">
                <span>Phòng</span>
                <span>Đã thu</span>
              </div>
              {collectedRows.map((r, i) => {
                const full = collectStatus(r) === 'paid';
                const newGroup = showAll && (i === 0 || bName(collectedRows[i - 1]) !== bName(r));
                const groupRows = collectedRows.filter((x) => bName(x) === bName(r));
                const groupSum = groupRows.reduce((s, x) => s + scopeCollected(x), 0);
                return (
                  <div key={r.id}>
                    {newGroup && (
                      <div className="rp-group">
                        <span className="rp-group-b">{bName(r)}</span>
                        <span className="rp-group-c">{groupRows.length} phòng</span>
                        <span className="rp-group-s">{fmtFull(groupSum)}</span>
                      </div>
                    )}
                    <div className="rp-row">
                      <div className="rp-rl">
                        <span className="rp-code">{r.room?.name}</span>
                        <span className={'rp-tag ' + (full ? 'full' : 'part')}>
                          {full ? 'Thu đủ' : `Thiếu ${fmtK(remainingOf(r))}`}
                        </span>
                      </div>
                      <span className="rp-amt">{fmtFull(scopeCollected(r))}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {dueRows.length > 0 && (
            <div className="rp-due">
              <div className="rp-due-head">
                Chưa thu · {dueRows.length} phòng · {fmtFull(totalRemaining)}
              </div>
              {showAll ? (
                dueByBuilding.map(({ b, rows }) => (
                  <div className="rp-due-grp" key={b.id}>
                    <div className="rp-due-gb">{b.name} · {rows.length} phòng</div>
                    <div className="rp-due-chips">
                      {rows.map((r) => (
                        <span className="rp-due-chip" key={r.id}>
                          {r.room?.name} · {fmtK(remainingOf(r))}
                        </span>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="rp-due-chips">
                  {dueRows.map((r) => (
                    <span className="rp-due-chip" key={r.id}>
                      {r.room?.name} · {fmtK(remainingOf(r))}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

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

export default CollectionReport;
