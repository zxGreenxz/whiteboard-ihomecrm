import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCollectionReport } from '@/hooks/useCollectionReport';
import {
  collectStatus,
  fmtFull,
  fmtK,
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
type MethodSel = 'all' | 'TM' | 'TT' | 'TK';

// Giờ:phút theo múi giờ VN (created_at là timestamp UTC) — robust kể cả máy
// đặt sai TZ. Trả '' nếu không có/không parse được.
const clockFmt = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Ho_Chi_Minh',
});
const fmtClock = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : clockFmt.format(d);
};

const bName = (inv: InvoiceWithRelations) => inv.building?.name ?? '—';
const byBuildingRoom = (a: InvoiceWithRelations, z: InvoiceWithRelations) =>
  bName(a) === bName(z)
    ? (a.room?.name ?? '').localeCompare(z.room?.name ?? '', 'vi', { numeric: true })
    : bName(a).localeCompare(bName(z), 'vi');

export function CollectionReport({ show, onClose, buildings, defaultBuildingId, billingMonth }: Props) {
  const [bSel, setBSel] = useState(defaultBuildingId);
  const [mSel, setMSel] = useState<MethodSel>('all');
  const [tSel, setTSel] = useState<TimeSel>('all');
  const [day, setDay] = useState(todayISO());
  const [timeOpen, setTimeOpen] = useState(false);
  const timeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (show) {
      setBSel(defaultBuildingId);
      setMSel('all');
    }
  }, [show, defaultBuildingId]);

  // Đóng popover Thời gian khi chạm ra ngoài
  useEffect(() => {
    if (!timeOpen) return;
    const onDown = (e: PointerEvent) => {
      if (timeRef.current && !timeRef.current.contains(e.target as Node)) setTimeOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [timeOpen]);

  const { invoices } = useCollectionReport({
    building_id: bSel === 'all' ? undefined : bSel,
    billing_month: billingMonth,
  });

  const scopeDay = tSel === 'today' ? todayISO() : day;
  // Đã thu trong phạm vi (thời gian + phương thức). Cả kỳ + mọi phương thức
  // dùng paid_amount (khớp hành vi cũ); còn lại cộng theo phiếu thu vì
  // paid_amount không tách được theo TM/TT/TK.
  const collectedOf = (inv: InvoiceWithRelations): { sum: number; has: boolean } => {
    if (tSel === 'all' && mSel === 'all') {
      const paid = inv.paid_amount ?? 0;
      return { sum: paid, has: paid > 0 };
    }
    let sum = 0;
    let has = false;
    for (const p of inv.payments ?? []) {
      const inWindow = tSel === 'all' || (p.payment_date >= scopeDay && p.payment_date <= scopeDay);
      if (inWindow && (mSel === 'all' || p.payment_method === mSel)) {
        sum += Number(p.amount) || 0;
        has = true;
      }
    }
    return { sum, has };
  };
  const scopeCollected = (inv: InvoiceWithRelations) => collectedOf(inv).sum;
  const inScope = (inv: InvoiceWithRelations) => collectedOf(inv).has;
  // Thời điểm thu của phiếu thu MỚI NHẤT khớp phạm vi (thời gian + phương thức):
  //  - Lọc kỳ  → "dd/mm HH:MM" (ngày/tháng payment_date + giờ created_at)
  //  - Lọc ngày/hôm nay → "HH:MM" (ngày đã ở tiêu đề)
  const scopeStampLabel = (inv: InvoiceWithRelations): string => {
    let best: { payment_date: string; created_at?: string } | null = null;
    for (const p of inv.payments ?? []) {
      const inWindow = tSel === 'all' || (p.payment_date >= scopeDay && p.payment_date <= scopeDay);
      if (inWindow && (mSel === 'all' || p.payment_method === mSel)) {
        if (!best || (p.created_at ?? '') > (best.created_at ?? '')) best = p;
      }
    }
    if (!best) return '';
    const clock = fmtClock(best.created_at);
    if (tSel !== 'all') return clock;
    const dm = best.payment_date.split('-').reverse().slice(0, 2).join('/');
    return clock ? `${dm} ${clock}` : dm;
  };
  // Lọc theo phương thức = xem tiền đã thu theo TM/TT/TK → phần "Chưa thu"
  // (không phụ thuộc phương thức) ẩn đi cho khỏi gây nhiễu.
  const showDue = mSel === 'all';

  const collectedRows = useMemo(
    () => invoices.filter(inScope).slice().sort(byBuildingRoom),
    [invoices, tSel, day, mSel],
  );
  const dueRows = useMemo(
    () =>
      showDue
        ? invoices.filter((i) => collectStatus(i) !== 'paid').slice().sort(byBuildingRoom)
        : [],
    [invoices, showDue],
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
  // Nhãn thời gian rút gọn cho ô lọc hẹp (bối cảnh đầy đủ vẫn ở dòng phụ):
  //  "Cả kỳ Th7/2026" → "7/2026" · "Ngày 05/07" → "05/07" · "Hôm nay" giữ nguyên.
  const timeNameShort =
    tSel === 'all'
      ? billingMonth.split('-').reverse().map(Number).join('/')
      : tSel === 'date'
        ? day.split('-').reverse().slice(0, 2).join('/')
        : timeName;

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
            <div className="rp-sub">
              {scopeName} · {timeName}
              {mSel !== 'all' ? ` · ${mSel}` : ''}
            </div>
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
            <span className="rp-dd-l">Phương thức</span>
            <div className="rp-dd-sel">
              <select value={mSel} onChange={(e) => setMSel(e.target.value as MethodSel)}>
                <option value="all">Tất cả</option>
                <option value="TM">TM</option>
                <option value="TT">TT</option>
                <option value="TK">TK</option>
              </select>
              <ChevronRight />
            </div>
          </label>
          <div className="rp-dd rp-dd-time" ref={timeRef}>
            <span className="rp-dd-l">Thời gian</span>
            <div className="rp-dd-sel">
              <button
                type="button"
                className={'rp-dd-trigger' + (timeOpen ? ' open' : '')}
                onClick={() => setTimeOpen((o) => !o)}
              >
                {timeNameShort}
              </button>
              <ChevronRight />
            </div>
            {timeOpen && (
              <div className="rp-tpop">
                <div className="rp-tpop-quick">
                  <button
                    type="button"
                    className={'rp-tq' + (tSel === 'all' ? ' on' : '')}
                    onClick={() => {
                      setTSel('all');
                      setTimeOpen(false);
                    }}
                  >
                    Cả kỳ {fmtBillingMonth(billingMonth)}
                  </button>
                  <button
                    type="button"
                    className={'rp-tq' + (tSel === 'today' ? ' on' : '')}
                    onClick={() => {
                      setTSel('today');
                      setTimeOpen(false);
                    }}
                  >
                    Hôm nay
                  </button>
                </div>
                <MiniCalendar
                  selected={tSel === 'date' ? day : null}
                  onPick={(iso) => {
                    setDay(iso);
                    setTSel('date');
                    setTimeOpen(false);
                  }}
                />
              </div>
            )}
          </div>
        </div>

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
                      {(() => {
                        const when = scopeStampLabel(r);
                        return when ? <span className="rp-when">{when}</span> : null;
                      })()}
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

// Lịch tháng thu gọn — chọn 1 ngày cụ thể ngay trong popover Thời gian.
const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const pad2 = (n: number) => String(n).padStart(2, '0');

function MiniCalendar({
  selected,
  onPick,
}: {
  selected: string | null;
  onPick: (iso: string) => void;
}) {
  const today = todayISO();
  const [view, setView] = useState(() => {
    const [y, m] = (selected ?? today).split('-').map(Number);
    return { y, m: m - 1 };
  });

  const firstDow = (new Date(view.y, view.m, 1).getDay() + 6) % 7; // Thứ 2 = 0
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const shift = (delta: number) =>
    setView((v) => {
      const m = v.m + delta;
      return { y: v.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
    });

  return (
    <div className="rp-cal">
      <div className="rp-cal-head">
        <button type="button" className="rp-cal-nav" onClick={() => shift(-1)} aria-label="Tháng trước">
          <ChevronLeft />
        </button>
        <span className="rp-cal-mo">Tháng {view.m + 1}/{view.y}</span>
        <button type="button" className="rp-cal-nav" onClick={() => shift(1)} aria-label="Tháng sau">
          <ChevronRight />
        </button>
      </div>
      <div className="rp-cal-wd">
        {WEEKDAYS.map((w) => (
          <span key={w} className={w === 'CN' ? 'sun' : undefined}>{w}</span>
        ))}
      </div>
      <div className="rp-cal-grid">
        {cells.map((d, i) =>
          d === null ? (
            <span key={i} className="rp-cd empty" />
          ) : (
            <button
              key={i}
              type="button"
              className={
                'rp-cd' +
                (`${view.y}-${pad2(view.m + 1)}-${pad2(d)}` === selected ? ' sel' : '') +
                (`${view.y}-${pad2(view.m + 1)}-${pad2(d)}` === today ? ' today' : '') +
                (i % 7 === 6 ? ' sun' : '')
              }
              onClick={() => onPick(`${view.y}-${pad2(view.m + 1)}-${pad2(d)}`)}
            >
              {d}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

export default CollectionReport;
