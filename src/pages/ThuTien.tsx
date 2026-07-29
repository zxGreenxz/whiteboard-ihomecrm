import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, HandCoins, Plug, Repeat } from 'lucide-react';
import './thu-tien.css';
import { useBuildings } from '@/hooks/useBuildings';
import { useThuTienInvoices } from '@/hooks/useCollectionReport';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import {
  collectStatus,
  paidAsOf,
  paymentsInRange,
  remainingAsOf,
  remainingOf,
  fmtShort,
  todayISO,
} from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

import { BuildingPills } from '@/components/thu-tien/BuildingPills';
import { CollectSummaryBar } from '@/components/thu-tien/CollectSummaryBar';
import { TimeFilter, type TimeFilterValue } from '@/components/thu-tien/TimeFilter';
import { DatePanel, type CollectDateRange } from '@/components/thu-tien/DatePanel';
import { StatusFilter, type StatusFilterValue } from '@/components/thu-tien/StatusFilter';
import { RoomCellGrid } from '@/components/thu-tien/RoomCellGrid';
import { CollectDrawer } from '@/components/thu-tien/CollectDrawer';
import { CollectionReport } from '@/components/thu-tien/CollectionReport';
import { HandoverSheet } from '@/components/thu-tien/HandoverSheet';
import { ManagePanel } from '@/components/thu-tien/ManagePanel';
import { useCashHandoverList } from '@/hooks/useCashHandovers';
import { useInvoiceCollectors } from '@/hooks/useInvoiceCollectors';
import { usePersistedState } from '@/hooks/usePersistedState';

const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const ThuTien = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: buildings = [] } = useBuildings();
  const { data: perms } = useMyPermissions();
  // Quyền chi tiết trang Thu tiền (fallback legacy: invoices.record_payment)
  const canRecordPayment = canUse(perms, 'thu_tien', 'collect');
  const canViewReport = canUse(perms, 'thu_tien', 'report');
  // Báo cáo Chu kỳ Thu → Bàn giao (self-view; quản lý xem của mình).
  const canCycleReport = canUse(perms, 'reports_finance', 'collection_cycle');

  // Bộ lọc giữ qua F5 trong cùng tab (sessionStorage); effect auto-chọn toà đầu
  // tiên bên dưới chỉ chạy khi buildingId rỗng nên không đè giá trị khôi phục.
  const [buildingId, setBuildingId] = usePersistedState('flt:thu-tien:buildingId', '');
  const [billingMonth, setBillingMonth] = usePersistedState('flt:thu-tien:month', currentMonth);
  const [timeFilter, setTimeFilter] = usePersistedState<TimeFilterValue>('flt:thu-tien:time', 'today');
  const [dateMode, setDateMode] = usePersistedState<'single' | 'range'>('flt:thu-tien:dateMode', 'single');
  const [dateRange, setDateRange] = usePersistedState<CollectDateRange>('flt:thu-tien:dateRange', () => ({ start: todayISO(), end: todayISO() }));
  const [statusFilter, setStatusFilter] = usePersistedState<StatusFilterValue>('flt:thu-tien:status', 'all');

  // Sheet/dialog/report: giữ DOM + toggle .show để chạy animation translateY.
  const [drawer, setDrawer] = useState<{ id: string | null; mode: 'view' | 'keypad'; show: boolean }>({
    id: null,
    mode: 'view',
    show: false,
  });
  const [report, setReport] = useState<{ mounted: boolean; show: boolean }>({ mounted: false, show: false });
  const [handover, setHandover] = useState<{ mounted: boolean; show: boolean }>({ mounted: false, show: false });
  const { actionCount: handoverActionCount } = useCashHandoverList();

  useEffect(() => {
    if (!buildingId && buildings.length) setBuildingId(buildings[0].id);
  }, [buildings, buildingId]);

  // 1 query cả kỳ (mọi toà) dùng chung với ManagePanel/CollectionReport;
  // slice theo toà đang chọn ở client → đổi tab toà không refetch.
  const { data: monthInvoices, isLoading } = useThuTienInvoices(billingMonth);
  const allRooms = useMemo(
    () => (monthInvoices ?? []).filter((i) => !buildingId || i.building_id === buildingId),
    [monthInvoices, buildingId],
  );

  // Ai thu bao nhiêu (creator_name phiếu thu theo payment) cho ô phòng + drawer.
  // Truyền CẢ THÁNG (không lọc toà) — map tra theo id nên thừa entry vô hại,
  // đổi lại đổi tab toà = 0 refetch (trước đây key theo ids-đã-lọc-toà nên
  // mỗi lần đổi tab là 1 request mới).
  const invoiceIds = useMemo(
    () => (monthInvoices ?? []).map((i) => i.id),
    [monthInvoices],
  );
  const { data: collectorsMap = {} } = useInvoiceCollectors(invoiceIds);
  const collectorNames = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [id, entries] of Object.entries(collectorsMap)) {
      out[id] = entries.map((e) => e.creator_name ?? '');
    }
    return out;
  }, [collectorsMap]);

  const [lo, hi] = useMemo<[string, string]>(() => {
    if (timeFilter === 'today') return [todayISO(), todayISO()];
    if (timeFilter === 'date') {
      const { start, end } = dateRange;
      return start <= end ? [start, end] : [end, start];
    }
    return ['', ''];
  }, [timeFilter, dateRange]);

  const isPaid = (inv: InvoiceWithRelations) => collectStatus(inv) === 'paid';
  // "Đã thu" của ngày/khoảng đang xem: có phiếu thu trong phạm vi (đủ hoặc 1 phần).
  const collectedInScope = (inv: InvoiceWithRelations) => paymentsInRange(inv, lo, hi).has;
  // "Chưa thu" (backlog) của ngày đang xem: hôm nay = còn nợ hiện tại (dồn mọi ngày);
  // ngày quá khứ = còn nợ tính đến hết ngày đó (snapshot từ lịch sử phiếu thu).
  const owesInScope = (inv: InvoiceWithRelations) =>
    timeFilter === 'today' ? !isPaid(inv) : !paidAsOf(inv, hi);
  // Danh sách của 1 ngày = phòng có thu trong ngày ∪ phòng còn phải thu của ngày đó.
  const timeMatch = (inv: InvoiceWithRelations) =>
    timeFilter === 'all' ? true : collectedInScope(inv) || owesInScope(inv);
  const statusMatch = (inv: InvoiceWithRelations) => {
    if (statusFilter === 'all') return true;
    if (timeFilter === 'all') return statusFilter === 'paid' ? isPaid(inv) : !isPaid(inv);
    // Theo ngày: thu 1 phần trong ngày vẫn xếp về "Đã thu" của ngày đó (ô vàng Thu thêm).
    return statusFilter === 'paid'
      ? collectedInScope(inv)
      : owesInScope(inv) && !collectedInScope(inv);
  };

  // Sort theo tên phòng (numeric: 205 < 209 < 302…) — query trả theo ngày
  // tạo hoá đơn nên không sort thì lưới ô phòng lộn xộn.
  const list = useMemo(
    () =>
      allRooms
        .filter((i) => timeMatch(i) && statusMatch(i))
        .sort((a, b) =>
          (a.room?.name ?? '').localeCompare(b.room?.name ?? '', 'vi', { numeric: true }),
        ),
    [allRooms, timeFilter, lo, hi, statusFilter],
  );

  // Thanh tổng theo phạm vi thời gian (không phụ thuộc tab Đã thu/Chưa thu):
  // cả kỳ = lũy kế paid_amount; theo ngày = tiền thu TRONG ngày + backlog của ngày đó.
  const summary = useMemo(() => {
    let collectedSum = 0, remainingSum = 0, paidRooms = 0, dueRooms = 0;
    for (const inv of allRooms) {
      if (timeFilter === 'all') {
        collectedSum += inv.paid_amount ?? 0;
        if (isPaid(inv)) paidRooms += 1;
        else {
          dueRooms += 1;
          remainingSum += Math.max(0, remainingOf(inv));
        }
      } else {
        const { sum, has } = paymentsInRange(inv, lo, hi);
        collectedSum += sum;
        if (has) paidRooms += 1;
        else if (owesInScope(inv)) {
          dueRooms += 1;
          remainingSum +=
            timeFilter === 'today' ? Math.max(0, remainingOf(inv)) : remainingAsOf(inv, hi);
        }
      }
    }
    return { collectedSum, remainingSum, paidRooms, dueRooms };
  }, [allRooms, timeFilter, lo, hi]);

  const timeCounts = useMemo(() => {
    const today = todayISO();
    return {
      all: allRooms.length,
      // Việc của hôm nay = đã thu hôm nay ∪ còn phải thu.
      today: allRooms.filter((i) => paymentsInRange(i, today, today).has || !isPaid(i)).length,
      // Hiện trong DatePanel: "Thu được … · n phòng" → số phòng CÓ thu trong khoảng.
      date: allRooms.filter((i) => paymentsInRange(i, lo || today, hi || today).has).length,
    };
  }, [allRooms, lo, hi]);
  const statusCounts = useMemo(() => {
    const base = allRooms.filter(timeMatch);
    if (timeFilter === 'all') {
      return {
        all: base.length,
        paid: base.filter(isPaid).length,
        unpaid: base.filter((i) => !isPaid(i)).length,
      };
    }
    const paid = base.filter(collectedInScope).length;
    return { all: base.length, paid, unpaid: base.length - paid };
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
  // Handler ô phòng bọc useCallback: RoomCell đã memo — arrow mới mỗi render sẽ
  // vô hiệu memo, mở/đóng drawer lại re-render cả lưới 50–300 ô.
  const openRoom = useCallback((inv: InvoiceWithRelations, mode: 'view' | 'keypad') => {
    setDrawer({ id: inv.id, mode, show: false });
    requestAnimationFrame(() => setDrawer((d) => ({ ...d, show: true })));
  }, []);
  const openCellView = useCallback((inv: InvoiceWithRelations) => openRoom(inv, 'view'), [openRoom]);
  const openCellKeypad = useCallback((inv: InvoiceWithRelations) => openRoom(inv, 'keypad'), [openRoom]);
  const closeDrawer = () => {
    setDrawer((d) => ({ ...d, show: false }));
    window.setTimeout(() => setDrawer((d) => ({ ...d, id: null })), 320);
  };
  const openReport = () => {
    if (!canViewReport) return;
    setReport({ mounted: true, show: false });
    requestAnimationFrame(() => setReport({ mounted: true, show: true }));
  };
  const closeReport = () => {
    setReport((r) => ({ ...r, show: false }));
    window.setTimeout(() => setReport({ mounted: false, show: false }), 320);
  };
  // useCallback: được dùng làm dep của effect deep-link bên dưới — arrow mới mỗi
  // render sẽ bắt effect chạy lại liên tục.
  const openHandover = useCallback(() => {
    setHandover({ mounted: true, show: false });
    requestAnimationFrame(() => setHandover({ mounted: true, show: true }));
  }, []);
  const closeHandover = () => {
    setHandover((h) => ({ ...h, show: false }));
    window.setTimeout(() => setHandover({ mounted: false, show: false }), 320);
  };

  // ── Deep-link `/thu-tien?handover=<uuid>` ────────────────────────────────
  // Thông báo "Bàn giao tiền mặt chờ bạn xác nhận" (E5). HandoverSheet chỉ nhận
  // {show, onClose} — không có prop id — nên deep-link mở đúng bảng bàn giao,
  // phiếu cần xác nhận nằm ngay trong danh sách chờ của bảng đó.
  // BẮT BUỘC gọi openHandover(): sheet chạy animation 2 pha (mount → rAF bật
  // .show); setHandover({mounted:true,show:true}) thẳng là mất hiệu ứng trượt.
  const handledHandoverRef = useRef<string | null>(null);
  useEffect(() => {
    const handoverId = searchParams.get('handover');
    if (!handoverId) {
      handledHandoverRef.current = null;
      return;
    }
    // Chưa biết quyền (perms đang tải) thì CHƯA kết luận — giữ param, effect
    // chạy lại khi có dữ liệu, tránh báo "không có quyền" oan.
    if (!perms) return;
    if (handledHandoverRef.current === handoverId) return;
    handledHandoverRef.current = handoverId;

    // Cùng cổng quyền với nút mở bảng bàn giao trên thanh tiêu đề.
    if (canRecordPayment) openHandover();
    else toast.info('Bạn không có quyền mở bảng bàn giao tiền mặt.');

    const next = new URLSearchParams(searchParams);
    next.delete('handover');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, perms, canRecordPayment, openHandover]);
  // "Đóng tiền" giờ là page riêng /thanh-toan (không còn overlay tại chỗ).
  const openUtility = () => navigate('/thanh-toan');

  const emptyIcon = statusFilter === 'paid' || allRooms.length === 0 ? '🔍' : '🎉';
  const emptyMessage =
    allRooms.length === 0
      ? 'Không có hoá đơn nào trong kỳ này.'
      : statusFilter === 'paid'
        ? timeFilter === 'today'
          ? 'Chưa thu phòng nào hôm nay.'
          : timeFilter === 'date'
            ? 'Không có khoản thu nào trong ngày đã chọn.'
            : 'Chưa thu phòng nào trong kỳ này.'
        : timeFilter === 'date'
          ? 'Đến hết ngày này đã thu xong toàn bộ.'
          : 'Đã thu xong toàn bộ tòa này!';

  const buildingOpts = buildings.map((b: any) => ({ id: b.id, name: b.name }));

  return (
    <div className="tt-stage">
      {/* Desktop ≥1024px: cột trái 75% là panel quản lý/báo cáo; CSS ẩn trên mobile.
          Nút "Điện nước" điều hướng sang page /thanh-toan. Dùng chung billingMonth
          qua sessionStorage nên đi qua lại giữ nguyên kỳ đang xem. */}
      <ManagePanel
        buildings={buildingOpts}
        billingMonth={billingMonth}
        onBillingMonthChange={setBillingMonth}
        phoneBuildingId={buildingId}
        onPickBuilding={setBuildingId}
        onBack={() => navigate(-1)}
        onOpenUtility={openUtility}
        canRecordPayment={canRecordPayment}
      />
      <div className="tt-phone-col">
        <div className="tt-page">
        <div className="hdr">
          <div className="hdr-bar">
            <button type="button" className="tt-back" title="Quay lại" onClick={() => navigate(-1)}>
              <ArrowLeft />
            </button>
            {canRecordPayment && (
              <button type="button" className="tt-handover" title="Bàn giao tiền mặt" onClick={openHandover}>
                <HandCoins />
                {handoverActionCount > 0 && <span className="ho-badge">{handoverActionCount}</span>}
              </button>
            )}
            {canRecordPayment && (
              <button type="button" className="tt-utility" title="Đóng tiền điện nước" onClick={openUtility}>
                <Plug />
              </button>
            )}
            {canCycleReport && (
              <button
                type="button"
                className="tt-utility"
                title="Chu kỳ Thu → Bàn giao (công nợ tòa của tôi)"
                onClick={() => navigate('/reports/finance/thu-ban-giao')}
              >
                <Repeat />
              </button>
            )}
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
                collectorsByInvoice={collectorNames}
                canRecordPayment={canRecordPayment}
                emptyIcon={emptyIcon}
                emptyMessage={emptyMessage}
                onOpen={openCellView}
                onPart={openCellKeypad}
              />
            )}
          </div>
        </div>

        <CollectDrawer
          invoice={openInvoice}
          show={drawer.show}
          mode={drawer.mode}
          collectors={openInvoice ? collectorsMap[openInvoice.id] ?? [] : []}
          canRecordPayment={canRecordPayment}
          canUndo={canUse(perms, 'thu_tien', 'undo')}
          prev={prev}
          next={next}
          onClose={closeDrawer}
          onNavigate={(inv) => setDrawer((d) => ({ ...d, id: inv.id, mode: 'view' }))}
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

        {handover.mounted && <HandoverSheet show={handover.show} onClose={closeHandover} />}
        </div>
      </div>
    </div>
  );
};

export default ThuTien;
