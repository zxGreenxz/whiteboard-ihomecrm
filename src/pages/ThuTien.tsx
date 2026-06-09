import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import MainLayout from '@/components/layout/MainLayout';
import { Skeleton } from '@/components/ui/skeleton';
import { useBuildings } from '@/hooks/useBuildings';
import { useInvoices } from '@/hooks/useInvoices';
import { useMyPermissions, can } from '@/hooks/useMyPermissions';
import { useQuickCollect } from '@/hooks/useQuickCollect';
import { collectStatus, paymentsInRange, remainingOf, fmtShort, todayISO } from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

import { BuildingPills } from '@/components/thu-tien/BuildingPills';
import { CollectSummaryBar } from '@/components/thu-tien/CollectSummaryBar';
import { TimeFilter, type TimeFilterValue } from '@/components/thu-tien/TimeFilter';
import { DatePanel, type CollectDateRange } from '@/components/thu-tien/DatePanel';
import { StatusFilter, type StatusFilterValue } from '@/components/thu-tien/StatusFilter';
import { RoomCellGrid } from '@/components/thu-tien/RoomCellGrid';
import { CollectDrawer } from '@/components/thu-tien/CollectDrawer';
import { ConfirmCollectDialog } from '@/components/thu-tien/ConfirmCollectDialog';
import { CollectionReport } from '@/components/thu-tien/CollectionReport';

const ThuTien = () => {
  const { data: buildings = [] } = useBuildings();
  const { data: perms } = useMyPermissions();
  const canRecordPayment = can(perms, 'invoices', 'record_payment');
  const { collect } = useQuickCollect();

  const [buildingId, setBuildingId] = useState('');
  const [billingMonth, setBillingMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [timeFilter, setTimeFilter] = useState<TimeFilterValue>('all');
  const [dateMode, setDateMode] = useState<'single' | 'range'>('single');
  const [dateRange, setDateRange] = useState<CollectDateRange>({ start: todayISO(), end: todayISO() });
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('unpaid');

  const [drawer, setDrawer] = useState<{ id: string | null; mode: 'view' | 'keypad' }>({ id: null, mode: 'view' });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmInv, setConfirmInv] = useState<InvoiceWithRelations | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  // Mặc định chọn toà đầu tiên khi danh sách toà tải xong.
  useEffect(() => {
    if (!buildingId && buildings.length) setBuildingId(buildings[0].id);
  }, [buildings, buildingId]);

  const { data: invoicesData, isLoading } = useInvoices({
    building_id: buildingId || undefined,
    billing_month: billingMonth,
  });
  const allRooms = useMemo(() => invoicesData?.data ?? [], [invoicesData]);

  // Khoảng ngày hiệu lực cho bộ lọc thời gian (lọc theo payment_date).
  const [lo, hi] = useMemo<[string, string]>(() => {
    if (timeFilter === 'today') return [todayISO(), todayISO()];
    if (timeFilter === 'date') {
      const { start, end } = dateRange;
      return start <= end ? [start, end] : [end, start];
    }
    return ['', ''];
  }, [timeFilter, dateRange]);

  // "Đã thu" theo collectStatus (đồng nhất với ô phòng): HĐ PAID có dư làm
  // tròn (remaining 500đ) vẫn coi là đã thu đủ, KHÔNG nhồi vào "Chưa thu".
  const isPaid = (inv: InvoiceWithRelations) => collectStatus(inv) === 'paid';
  const timeMatch = (inv: InvoiceWithRelations) =>
    timeFilter === 'all' ? true : paymentsInRange(inv, lo, hi).has;
  const statusMatch = (inv: InvoiceWithRelations) => {
    if (statusFilter === 'all') return true;
    return statusFilter === 'paid' ? isPaid(inv) : !isPaid(inv);
  };

  const list = useMemo(
    () => allRooms.filter((i) => timeMatch(i) && statusMatch(i)),
    [allRooms, timeFilter, lo, hi, statusFilter],
  );

  const summary = useMemo(() => {
    let collectedSum = 0, remainingSum = 0, paidRooms = 0, dueRooms = 0;
    for (const inv of list) {
      collectedSum += inv.paid_amount ?? 0;
      if (isPaid(inv)) {
        paidRooms += 1;
      } else {
        dueRooms += 1;
        remainingSum += Math.max(0, remainingOf(inv));
      }
    }
    return { collectedSum, remainingSum, paidRooms, dueRooms };
  }, [list]);

  // Đếm chip — mỗi chiều đếm dưới bộ lọc còn lại đang bật.
  const timeCounts = useMemo(() => {
    const base = allRooms.filter(statusMatch);
    return {
      all: base.length,
      today: base.filter((i) => paymentsInRange(i, todayISO(), todayISO()).has).length,
      date: base.filter((i) => paymentsInRange(i, lo || todayISO(), hi || todayISO()).has).length,
    };
  }, [allRooms, statusFilter, lo, hi]);
  const statusCounts = useMemo(() => {
    const base = allRooms.filter(timeMatch);
    return {
      all: base.length,
      paid: base.filter(isPaid).length,
      unpaid: base.filter((i) => !isPaid(i)).length,
    };
  }, [allRooms, timeFilter, lo, hi]);

  const dateRangeSum = useMemo(
    () => allRooms.reduce((s, i) => s + paymentsInRange(i, lo || todayISO(), hi || todayISO()).sum, 0),
    [allRooms, lo, hi],
  );

  // Drawer: HĐ đang mở + prev/next trong list đã lọc.
  const openInvoice = drawer.id ? allRooms.find((i) => i.id === drawer.id) ?? null : null;
  const idx = drawer.id ? list.findIndex((i) => i.id === drawer.id) : -1;
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  const openRoom = (inv: InvoiceWithRelations, mode: 'view' | 'keypad') => {
    // Bỏ focus khỏi nút vừa bấm: vaul set aria-hidden lên nền khi mở drawer,
    // nếu nút còn focus dưới nền sẽ cảnh báo a11y "aria-hidden retained focus".
    (document.activeElement as HTMLElement | null)?.blur();
    setDrawer({ id: inv.id, mode });
    setDrawerOpen(true);
  };

  const confirmFull = async () => {
    if (!confirmInv) return;
    setConfirming(true);
    try {
      await collect({ invoice: confirmInv, amount: remainingOf(confirmInv) });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConfirming(false);
      setConfirmInv(null);
    }
  };

  const emptyIcon = statusFilter === 'unpaid' && timeFilter === 'all' ? '🎉' : '🔍';
  const emptyMessage =
    statusFilter === 'unpaid' && timeFilter === 'all'
      ? 'Đã thu xong toàn bộ tòa này!'
      : timeFilter === 'today'
        ? 'Chưa thu phòng nào hôm nay.'
        : timeFilter === 'date'
          ? 'Không có khoản thu nào trong ngày đã chọn.'
          : 'Không có phòng nào khớp bộ lọc.';

  const buildingOpts = buildings.map((b: any) => ({ id: b.id, name: b.name }));

  return (
    <MainLayout>
      <div className="-mx-4 -my-4 min-h-[calc(100vh-120px)] bg-zinc-50 sm:-mx-6 sm:-my-6">
        <div className="mx-auto max-w-2xl">
          <BuildingPills buildings={buildingOpts} value={buildingId} onChange={setBuildingId} />

          <div className="space-y-3 px-4 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-500">Kỳ thu tiền</span>
              <input
                type="month"
                value={billingMonth}
                onChange={(e) => setBillingMonth(e.target.value)}
                className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-sm tabular-nums"
              />
            </div>

            <CollectSummaryBar
              collectedSum={summary.collectedSum}
              paidRooms={summary.paidRooms}
              remainingSum={summary.remainingSum}
              dueRooms={summary.dueRooms}
              onOpenReport={() => setReportOpen(true)}
            />

            <TimeFilter value={timeFilter} counts={timeCounts} onChange={setTimeFilter} />
            {timeFilter === 'date' && (
              <DatePanel
                mode={dateMode}
                onModeChange={setDateMode}
                value={dateRange}
                onChange={setDateRange}
                resultText={`Thu được ${fmtShort(dateRangeSum)} · ${timeCounts.date} phòng`}
              />
            )}
            <StatusFilter value={statusFilter} counts={statusCounts} onChange={setStatusFilter} />
          </div>

          {isLoading ? (
            <div className="grid grid-cols-2 gap-2.5 px-4 pb-28 pt-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))}
            </div>
          ) : (
            <RoomCellGrid
              list={list}
              canRecordPayment={canRecordPayment}
              emptyIcon={emptyIcon}
              emptyMessage={emptyMessage}
              onOpen={(inv) => openRoom(inv, 'view')}
              onFull={(inv) => setConfirmInv(inv)}
              onPart={(inv) => openRoom(inv, 'keypad')}
            />
          )}
        </div>
      </div>

      <CollectDrawer
        invoice={openInvoice}
        open={drawerOpen}
        mode={drawer.mode}
        canRecordPayment={canRecordPayment}
        prev={prev}
        next={next}
        onOpenChange={setDrawerOpen}
        onNavigate={(inv) => setDrawer({ id: inv.id, mode: 'view' })}
      />

      <ConfirmCollectDialog
        invoice={confirmInv}
        confirming={confirming}
        onConfirm={confirmFull}
        onCancel={() => setConfirmInv(null)}
      />

      <CollectionReport
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        buildings={buildingOpts}
        defaultBuildingId={buildingId}
        billingMonth={billingMonth}
      />
    </MainLayout>
  );
};

export default ThuTien;
