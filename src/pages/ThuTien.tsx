import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import './thu-tien.css';
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

const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const ThuTien = () => {
  const navigate = useNavigate();
  const { data: buildings = [] } = useBuildings();
  const { data: perms } = useMyPermissions();
  const canRecordPayment = can(perms, 'invoices', 'record_payment');
  const { collect } = useQuickCollect();

  const [buildingId, setBuildingId] = useState('');
  const [billingMonth, setBillingMonth] = useState(currentMonth());
  const [timeFilter, setTimeFilter] = useState<TimeFilterValue>('all');
  const [dateMode, setDateMode] = useState<'single' | 'range'>('single');
  const [dateRange, setDateRange] = useState<CollectDateRange>({ start: todayISO(), end: todayISO() });
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('unpaid');

  // Sheet/dialog/report: giữ DOM + toggle .show để chạy animation translateY.
  const [drawer, setDrawer] = useState<{ id: string | null; mode: 'view' | 'keypad'; show: boolean }>({
    id: null,
    mode: 'view',
    show: false,
  });
  const [confirm, setConfirm] = useState<{ inv: InvoiceWithRelations | null; show: boolean }>({
    inv: null,
    show: false,
  });
  const [report, setReport] = useState<{ mounted: boolean; show: boolean }>({ mounted: false, show: false });

  useEffect(() => {
    if (!buildingId && buildings.length) setBuildingId(buildings[0].id);
  }, [buildings, buildingId]);

  const { data: invoicesData, isLoading } = useInvoices({
    building_id: buildingId || undefined,
    billing_month: billingMonth,
  });
  const allRooms = useMemo(() => invoicesData?.data ?? [], [invoicesData]);

  const [lo, hi] = useMemo<[string, string]>(() => {
    if (timeFilter === 'today') return [todayISO(), todayISO()];
    if (timeFilter === 'date') {
      const { start, end } = dateRange;
      return start <= end ? [start, end] : [end, start];
    }
    return ['', ''];
  }, [timeFilter, dateRange]);

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
      if (isPaid(inv)) paidRooms += 1;
      else {
        dueRooms += 1;
        remainingSum += Math.max(0, remainingOf(inv));
      }
    }
    return { collectedSum, remainingSum, paidRooms, dueRooms };
  }, [list]);

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

  const openInvoice = drawer.id ? allRooms.find((i) => i.id === drawer.id) ?? null : null;
  const idx = drawer.id ? list.findIndex((i) => i.id === drawer.id) : -1;
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  // ── Open/close helpers (mount → rAF set .show; close → bỏ .show rồi unmount) ──
  const openRoom = (inv: InvoiceWithRelations, mode: 'view' | 'keypad') => {
    setDrawer({ id: inv.id, mode, show: false });
    requestAnimationFrame(() => setDrawer((d) => ({ ...d, show: true })));
  };
  const closeDrawer = () => {
    setDrawer((d) => ({ ...d, show: false }));
    window.setTimeout(() => setDrawer((d) => ({ ...d, id: null })), 320);
  };
  const askConfirm = (inv: InvoiceWithRelations) => {
    setConfirm({ inv, show: false });
    requestAnimationFrame(() => setConfirm((c) => ({ ...c, show: true })));
  };
  const closeConfirm = () => {
    setConfirm((c) => ({ ...c, show: false }));
    window.setTimeout(() => setConfirm({ inv: null, show: false }), 240);
  };
  const confirmFull = async () => {
    if (!confirm.inv) return;
    try {
      await collect({ invoice: confirm.inv, amount: remainingOf(confirm.inv) });
    } catch (e) {
      toast.error((e as Error).message);
    }
    closeConfirm();
  };
  const openReport = () => {
    setReport({ mounted: true, show: false });
    requestAnimationFrame(() => setReport({ mounted: true, show: true }));
  };
  const closeReport = () => {
    setReport((r) => ({ ...r, show: false }));
    window.setTimeout(() => setReport({ mounted: false, show: false }), 320);
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
    <div className="tt-stage">
      <div className="tt-page">
        <div className="hdr">
          <div className="hdr-bar">
            <button type="button" className="tt-back" title="Quay lại" onClick={() => navigate(-1)}>
              <ArrowLeft />
            </button>
            <div className="hdr-period">
              <input
                className="ky-input"
                type="month"
                value={billingMonth}
                onChange={(e) => setBillingMonth(e.target.value || currentMonth())}
              />
            </div>
          </div>
          <BuildingPills buildings={buildingOpts} value={buildingId} onChange={setBuildingId} />
        </div>

        <div className="scroll">
          <div className="scroll-pad">
            <CollectSummaryBar
              collectedSum={summary.collectedSum}
              paidRooms={summary.paidRooms}
              remainingSum={summary.remainingSum}
              dueRooms={summary.dueRooms}
              onOpenReport={openReport}
            />
            <TimeFilter value={timeFilter} counts={timeCounts} onChange={setTimeFilter} />
            {timeFilter === 'date' && (
              <DatePanel
                mode={dateMode}
                onModeChange={setDateMode}
                value={dateRange}
                onChange={setDateRange}
                resultText={
                  <>
                    Thu được <b>{fmtShort(dateRangeSum)}</b> · {timeCounts.date} phòng
                  </>
                }
              />
            )}
            <StatusFilter value={statusFilter} counts={statusCounts} onChange={setStatusFilter} />

            {isLoading ? (
              <div className="c-empty">
                <div className="e-ic">⏳</div>
                <p>Đang tải hoá đơn…</p>
              </div>
            ) : (
              <RoomCellGrid
                list={list}
                canRecordPayment={canRecordPayment}
                emptyIcon={emptyIcon}
                emptyMessage={emptyMessage}
                onOpen={(inv) => openRoom(inv, 'view')}
                onFull={(inv) => askConfirm(inv)}
                onPart={(inv) => openRoom(inv, 'keypad')}
              />
            )}
          </div>
        </div>

        <CollectDrawer
          invoice={openInvoice}
          show={drawer.show}
          mode={drawer.mode}
          canRecordPayment={canRecordPayment}
          prev={prev}
          next={next}
          onClose={closeDrawer}
          onNavigate={(inv) => setDrawer((d) => ({ ...d, id: inv.id, mode: 'view' }))}
        />

        <ConfirmCollectDialog
          invoice={confirm.inv}
          show={confirm.show}
          onConfirm={confirmFull}
          onCancel={closeConfirm}
        />

        {report.mounted && (
          <CollectionReport
            show={report.show}
            onClose={closeReport}
            buildings={buildingOpts}
            defaultBuildingId={buildingId}
            billingMonth={billingMonth}
          />
        )}
      </div>
    </div>
  );
};

export default ThuTien;
