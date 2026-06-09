import { useMemo, useState, useEffect } from 'react';
import { X } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  open: boolean;
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

export function CollectionReport({ open, onClose, buildings, defaultBuildingId, billingMonth }: Props) {
  const [bSel, setBSel] = useState(defaultBuildingId);
  const [tSel, setTSel] = useState<TimeSel>('all');
  const [day, setDay] = useState(todayISO());

  useEffect(() => {
    if (open) setBSel(defaultBuildingId);
  }, [open, defaultBuildingId]);

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

  if (!open) return null;

  const timeName =
    tSel === 'all'
      ? `Cả kỳ ${fmtBillingMonth(billingMonth)}`
      : tSel === 'today'
        ? 'Hôm nay'
        : `Ngày ${day.split('-').reverse().slice(0, 2).join('/')}`;

  // Nhóm danh sách đã thu theo toà (khi "Tất cả tòa").
  const dueByBuilding = buildings
    .map((b) => ({ b, rows: dueRows.filter((r) => bName(r) === b.name) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <div>
          <div className="text-lg font-bold text-zinc-900">Báo cáo thu tiền</div>
          <div className="text-xs text-zinc-500">
            {showAll ? 'Tất cả tòa' : buildings.find((b) => b.id === bSel)?.name} · {timeName}
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 px-4 py-3">
        <Select value={bSel} onValueChange={setBSel}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tất cả tòa</SelectItem>
            {buildings.map((b) => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={tSel} onValueChange={(v) => setTSel(v as TimeSel)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Cả kỳ {fmtBillingMonth(billingMonth)}</SelectItem>
            <SelectItem value="today">Hôm nay</SelectItem>
            <SelectItem value="date">Chọn ngày…</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {tSel === 'date' && (
        <div className="px-4 pb-2">
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
          />
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-8">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-600">Tổng đã thu</span>
            <span className="font-mono text-xl font-bold tabular-nums text-emerald-700">
              {fmtFull(totalCollected)}
            </span>
          </div>
          <div className="text-xs text-zinc-500">
            {collectedRows.length} phòng đã thu
            {totalRemaining > 0 ? ` · còn phải thu ${fmtFull(totalRemaining)}` : ''}
          </div>
        </div>

        {collectedRows.length === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-500">
            🧾 Chưa thu khoản nào trong phạm vi này.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-zinc-200">
            {collectedRows.map((r, i) => {
              const full = collectStatus(r) === 'paid';
              const newGroup = showAll && (i === 0 || bName(collectedRows[i - 1]) !== bName(r));
              const groupRows = collectedRows.filter((x) => bName(x) === bName(r));
              const groupSum = groupRows.reduce((s, x) => s + scopeCollected(x), 0);
              return (
                <div key={r.id}>
                  {newGroup && (
                    <div className="flex items-center justify-between bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-600">
                      <span>{bName(r)}</span>
                      <span>{groupRows.length} phòng · {fmtFull(groupSum)}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between border-t border-zinc-100 px-3 py-2 text-sm first:border-t-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium">{r.room?.name}</span>
                      <span
                        className={
                          full
                            ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-700'
                            : 'rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700'
                        }
                      >
                        {full ? 'Thu đủ' : `Thiếu ${fmtK(remainingOf(r))}`}
                      </span>
                    </div>
                    <span className="font-mono tabular-nums text-zinc-800">{fmtFull(scopeCollected(r))}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {dueRows.length > 0 && (
          <div className="rounded-xl border border-red-100 bg-red-50/50 p-3">
            <div className="mb-2 text-sm font-semibold text-red-700">
              Chưa thu · {dueRows.length} phòng · {fmtFull(totalRemaining)}
            </div>
            {showAll ? (
              <div className="space-y-2">
                {dueByBuilding.map(({ b, rows }) => (
                  <div key={b.id}>
                    <div className="text-xs font-medium text-zinc-500">{b.name} · {rows.length} phòng</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {rows.map((r) => (
                        <span key={r.id} className="rounded-full border border-red-200 bg-white px-2 py-0.5 text-xs">
                          {r.room?.name} · {fmtK(remainingOf(r))}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {dueRows.map((r) => (
                  <span key={r.id} className="rounded-full border border-red-200 bg-white px-2 py-0.5 text-xs">
                    {r.room?.name} · {fmtK(remainingOf(r))}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default CollectionReport;
