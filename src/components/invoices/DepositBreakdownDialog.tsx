import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useDepositBreakdown, type DepositBreakdownRow } from '@/hooks/useStatBreakdowns';
import { DEPOSIT_SHORTFALL_THRESHOLD } from '@/hooks/useDepositDashboard';
import type { InvoiceStatisticsFilters } from '@/hooks/useInvoices';
import { PiggyBank, Check, AlertTriangle, Clock } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters?: InvoiceStatisticsFilters;
}

const fmtVND = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n || 0);

const fmtDay = (iso?: string | null) => {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : '—';
};

interface RoomGroup {
  roomKey: string;
  roomName: string;
  receipts: DepositBreakdownRow[];
  receivedInPeriod: number;
  contract: DepositBreakdownRow | null; // hàng có contract để lấy yêu cầu cọc
}
interface BuildingGroup {
  bKey: string;
  buildingName: string;
  rooms: RoomGroup[];
  total: number;
}

/** Trạng thái đủ/thiếu cọc của 1 phòng (theo HĐ đang gắn). */
function depositStatus(c: DepositBreakdownRow | null) {
  if (!c || c.contract_id == null || c.total_deposit == null) {
    return { kind: 'reservation' as const };
  }
  const total = c.total_deposit ?? 0;
  const paid = c.deposit_paid ?? 0;
  const remaining = c.deposit_remaining != null ? c.deposit_remaining : total - paid;
  const enough = remaining < DEPOSIT_SHORTFALL_THRESHOLD;
  const firstInvoice = c.deposit_debt_mode === 'FIRST_INVOICE';
  return { kind: enough ? ('full' as const) : ('short' as const), total, paid, remaining, firstInvoice };
}

const DepositBreakdownDialog = ({ open, onOpenChange, filters }: Props) => {
  const { data: rows = [], isLoading } = useDepositBreakdown(filters, open);

  const buildings = useMemo<BuildingGroup[]>(() => {
    const byB = new Map<string, { buildingName: string; rooms: Map<string, RoomGroup>; total: number }>();
    for (const r of rows) {
      const bKey = r.building_id ?? r.building_name ?? '—';
      const b = byB.get(bKey) ?? { buildingName: r.building_name ?? '—', rooms: new Map(), total: 0 };
      const rKey = r.room_id ?? r.room_name ?? '—';
      const room =
        b.rooms.get(rKey) ??
        { roomKey: rKey, roomName: r.room_name ?? '—', receipts: [], receivedInPeriod: 0, contract: null };
      room.receipts.push(r);
      room.receivedInPeriod += r.amount;
      if (!room.contract && r.contract_id) room.contract = r;
      b.rooms.set(rKey, room);
      b.total += r.amount;
      byB.set(bKey, b);
    }
    return [...byB.entries()]
      .map(([bKey, b]) => ({
        bKey,
        buildingName: b.buildingName,
        total: b.total,
        rooms: [...b.rooms.values()].sort((x, y) => x.roomName.localeCompare(y.roomName, 'vi')),
      }))
      .sort((x, y) => x.buildingName.localeCompare(y.buildingName, 'vi'));
  }, [rows]);

  const grand = useMemo(() => rows.reduce((s, r) => s + r.amount, 0), [rows]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PiggyBank className="h-5 w-5 text-zinc-500" />
            Cọc đã thu trong kỳ
          </DialogTitle>
          <DialogDescription>
            Các khoản cọc nhận trong kỳ theo toà → phòng. Mỗi phòng ghi rõ trạng thái đã đủ cọc phải đóng hay còn thiếu.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Không có khoản cọc nào nhận trong phạm vi này.
          </p>
        ) : (
          <div className="space-y-4">
            {buildings.map((b) => (
              <div key={b.bKey} className="rounded-lg border overflow-hidden">
                <div className="flex items-center justify-between bg-zinc-50 px-3 py-2">
                  <span className="font-semibold text-sm text-zinc-800">{b.buildingName}</span>
                  <span className="text-xs text-muted-foreground">
                    Nhận trong kỳ:{' '}
                    <span className="font-bold tabular-nums text-zinc-900">{fmtVND(b.total)}</span>
                  </span>
                </div>
                <div className="divide-y">
                  {b.rooms.map((room) => {
                    const st = depositStatus(room.contract);
                    return (
                      <div key={room.roomKey} className="px-3 py-2">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">Phòng {room.roomName}</span>
                            {room.contract?.contract_number && (
                              <span className="text-[11px] text-muted-foreground">
                                {room.contract.contract_number}
                              </span>
                            )}
                          </div>
                          {st.kind === 'full' && (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                              <Check className="h-3 w-3" /> Đã đủ cọc
                            </span>
                          )}
                          {st.kind === 'short' && (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                              <AlertTriangle className="h-3 w-3" />
                              {st.firstInvoice ? 'Trừ vào HĐ đầu' : 'Còn thiếu'} {fmtVND(st.remaining)}
                            </span>
                          )}
                          {st.kind === 'reservation' && (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 bg-sky-50 border border-sky-200 rounded-full px-2 py-0.5">
                              <Clock className="h-3 w-3" /> Cọc giữ chỗ (chưa gắn HĐ)
                            </span>
                          )}
                        </div>

                        {st.kind !== 'reservation' && (
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            Cọc phải đóng: <span className="font-medium text-zinc-700">{fmtVND(st.total)}</span>
                            {' · '}Đã đóng: <span className="font-medium text-zinc-700">{fmtVND(st.paid)}</span>
                          </div>
                        )}

                        <ul className="mt-1.5 space-y-1">
                          {room.receipts.map((rc) => (
                            <li
                              key={rc.voucher_id}
                              className="flex items-center justify-between gap-2 text-xs bg-zinc-50/60 rounded px-2 py-1"
                            >
                              <span className="flex items-center gap-2 min-w-0">
                                <span className="text-muted-foreground shrink-0">{fmtDay(rc.voucher_date)}</span>
                                <span className="shrink-0">{rc.code ?? ''}</span>
                                {rc.account_name && (
                                  <span className="text-muted-foreground shrink-0">· {rc.account_name}</span>
                                )}
                                {rc.notes && <span className="truncate text-muted-foreground">— {rc.notes}</span>}
                              </span>
                              <span className="font-semibold tabular-nums shrink-0">{fmtVND(rc.amount)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-2.5 text-white">
              <span className="text-sm font-medium">Tổng cọc nhận trong kỳ</span>
              <span className="text-lg font-bold tabular-nums">{fmtVND(grand)}</span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default DepositBreakdownDialog;
