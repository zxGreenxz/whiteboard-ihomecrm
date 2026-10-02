import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { FinancialWorkflowError, workflowErrorMessage } from "@/lib/financialWorkflow";
import { createdVoucherFeedback } from "@/lib/voucherFeedback";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { LoadingState, SkeletonBar } from "@/components/loading/LoadingState";
import { todayISO } from "@/lib/collect";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Wallet, Eye, Settings, CalendarCheck, LayoutDashboard, HandCoins, Lock, Unlock, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { supabase } from "@/integrations/supabase/client";
import { useSalaryV5Config } from "@/hooks/useSalaryV5Config";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import {
  useManagerSalary, useMyManagerConfig, useStaffDisplayMonth,
  useSaveSalaryAdjustment, useDeleteSalaryAdjustment,
  useLockSalaryMonth, useUnlockSalaryMonth, useSalaryPayout, useToggleJobExcluded,
} from "@/hooks/useManagerSalary";
import { useBonusRules } from "@/hooks/useSalaryConfig";
import { usePendingLeaveRequests } from "@/hooks/useMyDay";
import { AdjustDialog, BulkPayoutDialog, LockDialog, type SalaryAccount, type SalAdjustPayload } from "@/components/salary/SalaryMonthly";
import SalaryFundOverview, { type FundPeriod } from "@/components/salary/SalaryFundOverview";
import SalaryIncomePay from "@/components/salary/SalaryIncomePay";
import SalaryFundModal from "@/components/salary/SalaryFundModal";
import { useSalaryFeeFund, useSalaryPendingPayouts } from "@/hooks/useSalaryFund";
import { useSalaryCanEditAmounts } from "@/hooks/useSalaryExtras";
import { useAssignCommissionManager } from "@/hooks/useCommissionManager";
import SalaryAmountEditDialog, { type EditableLine } from "@/components/salary/SalaryAmountEditDialog";
import type { SalAdjustment, SalManager } from "@/lib/managerSalary";
import SalaryLedger from "@/components/salary/SalaryLedger";
import SalaryConfig from "@/components/salary/SalaryConfig";
import SalaryLeaveRequests from "@/components/salary/SalaryLeaveRequests";
import SalarySelf from "@/components/salary/SalarySelf";
import SalarySelfMobile from "@/components/salary/SalarySelfMobile";
import SalaryAdminMobile from "@/components/salary/SalaryAdminMobile";
import { usePhoneViewport } from "@/hooks/use-mobile";
import { usePersistedState } from "@/hooks/usePersistedState";
import "@/components/salary/salary.css";
import { currentPeriodMonth, shiftPeriodMonth as shiftMonth } from "@/lib/salaryPeriod";
import { resolveSalaryEngine, isUnqualifiedContractRow } from "@/lib/managerSalary";

// Ngày chi theo GIỜ LOCAL — toISOString() là UTC, chi lương lúc 00:00-07:00 VN
// sẽ rơi vào THÁNG TRƯỚC (audit 2026-07-20). Dùng helper canonical ở lib/collect.
const today = todayISO;

// Màn chờ / rỗng MOBILE (shell tối khớp SalaryAdminMobile/SalarySelfMobile).
// Dùng trong lúc chưa biết quyền để KHÔNG nháy khung MainLayout desktop.
function MobileSalaryShell({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] overflow-hidden flex justify-center"
      style={{ background: "radial-gradient(80% 50% at 50% 0%, #241a44 0%, transparent 55%), #0d0a1a" }}>
      <div className="relative w-full max-w-[440px] flex flex-col items-center justify-center px-8 text-center"
        style={{ height: "100dvh", background: "radial-gradient(80% 30% at 50% 0%, #241a44 0%, transparent 55%), #17132A", paddingTop: "env(safe-area-inset-top)" }}>
        {children}
      </div>
    </div>
  );
}
// Chờ: khối xám (tông tối của shell) thay vòng xoay + chữ — chủ chốt 02/10/2026.
const SAL_SK = "rgba(255,255,255,.08)";
function MobileSalaryBoot() {
  return (
    <MobileSalaryShell>
      <div role="status" className="w-full">
        <span className="sr-only">Đang tải bảng lương…</span>
        <div className="ld-appear flex w-full flex-col gap-3" aria-hidden="true">
          <SkeletonBar className="h-5 rounded-lg" style={{ width: "40%", background: SAL_SK }} />
          <SkeletonBar className="h-28 rounded-2xl" style={{ width: "100%", background: SAL_SK }} />
          <SkeletonBar className="h-16 rounded-2xl" style={{ width: "100%", background: SAL_SK }} />
          <SkeletonBar className="h-16 rounded-2xl" style={{ width: "100%", background: SAL_SK }} />
        </div>
      </div>
    </MobileSalaryShell>
  );
}
function MobileSalaryEmpty() {
  return (
    <MobileSalaryShell>
      <div className="w-16 h-16 rounded-2xl grid place-items-center mb-4"
        style={{ background: "rgba(167,139,250,.16)", color: "#C4B5FD" }}>
        <Wallet size={28} />
      </div>
      <div className="text-[16px] font-extrabold" style={{ color: "#EDEAF7" }}>Chưa được cấu hình hưởng lương</div>
      <div className="mt-1.5 text-[13px]" style={{ color: "#9A8FC4" }}>Liên hệ quản trị để được thiết lập.</div>
      <Link to="/" className="mt-6 px-5 py-2.5 rounded-xl text-[14px] font-bold no-underline"
        style={{ background: "#FFD23F", color: "#17132A" }}>Về trang chủ</Link>
    </MobileSalaryShell>
  );
}

export default function ManagerSalaryPage() {
  const permissionQuery = useMyPermissions();
  const { data: perms, isLoading: permsLoading } = permissionQuery;
  const managerConfigQuery = useMyManagerConfig();
  const { data: myMgr, isLoading: myLoading } = managerConfigQuery;
  const phone = usePhoneViewport();

  const canLock = canUse(perms, "salary", "lock");
  const canManageSalary = canUse(perms, "salary", "manage_salary");
  const canPay = canUse(perms, "salary", "distribute");
  const isAdmin = !!(perms as any)?.__superadmin || canLock || canManageSalary || canPay;

  const [periodMonth, setPeriodMonth] = usePersistedState<string>("flt:salary-manager:period", currentPeriodMonth());
  const [rawTab, setTab] = usePersistedState<"overview" | "people" | "ledger" | "leave" | "config" | "sheet">("flt:salary-manager:tab", "overview");
  // "sheet" = tab Bảng lương tháng cũ, nay là Tổng quan kỳ.
  const tab = rawTab === "sheet" ? "overview" : rawTab;
  const [person, setPerson] = useState<string | null>(null);
  const [fundModal, setFundModal] = useState<"funding" | "rules" | null>(null);
  const [adjDialog, setAdjDialog] = useState<{ m: SalManager; edit?: SalAdjustment | null } | null>(null);
  const [amountEdit, setAmountEdit] = useState<{ m: SalManager; line: EditableLine } | null>(null);
  const [showLock, setShowLock] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [view, setView] = useState<"admin" | "self">("admin");
  const [selfId, setSelfId] = useState<string | null>(null);
  const [ledgerFilter, setLedgerFilter] = useState<{ who?: string } | null>(null);

  // Nhân viên (không phải admin): mặc định hiển thị tháng lùi theo chốt lương +
  // override admin. Admin giữ điều hướng tháng tự do.
  const displayMonthQuery = useStaffDisplayMonth(myMgr?.staff_id, !isAdmin);
  const {data:staffMonth} = displayMonthQuery;
  // Nhân viên vẫn được LÙI về tháng cũ; trần (không vượt quá) = staffMonth.
  const [selfOverride, setSelfOverride] = useState<string | null>(null);
  const selfCeiling = staffMonth || currentPeriodMonth();
  const selfPeriod = selfOverride || staffMonth || periodMonth;
  const effPeriod = isAdmin ? periodMonth : selfPeriod;

  // Chế độ lương đang áp dụng (cũ/v5) — công tắc ở /reports/coverage tab Cài đặt v5.
  // Chỉ ĐỔI SỐ LIỆU (base=chuyên cần, thưởng=chuỗi, ngày công=ticked) cho tháng CHƯA chốt;
  // giao diện + tháng đã chốt giữ nguyên.
  const engineQuery = useSalaryV5Config();
  const { data: v5cfg } = engineQuery;
  // v5 chỉ áp từ system_v5.effective_from trở đi — tháng trước đó rơi về legacy.
  const salaryEngine = resolveSalaryEngine(v5cfg, effPeriod);

  const salaryQuery = useManagerSalary(effPeriod, salaryEngine);
  const { data, isLoading, refetch } = salaryQuery;

  // Báo cáo cơ cấu quỹ so 3 tháng (chỉ admin desktop). Mỗi kỳ tự chọn engine riêng.
  const prev1 = shiftMonth(periodMonth, -1), prev2 = shiftMonth(periodMonth, -2);
  const wantFund = isAdmin && !phone;
  const prev1Query = useManagerSalary(wantFund ? prev1 : "", resolveSalaryEngine(v5cfg, prev1));
  const prev2Query = useManagerSalary(wantFund ? prev2 : "", resolveSalaryEngine(v5cfg, prev2));
  const {data:dPrev1,isLoading:lPrev1} = prev1Query;
  const {data:dPrev2,isLoading:lPrev2} = prev2Query;
  const fee0 = useSalaryFeeFund(periodMonth, wantFund);
  const fee1 = useSalaryFeeFund(prev1, wantFund);
  const fee2 = useSalaryFeeFund(prev2, wantFund);
  const rulesQuery = useBonusRules();
  const { data: rulesData } = rulesQuery;
  const requirePhoto = !!rulesData?.rules?.requirePhoto;

  const accountsQuery = useQuery<SalaryAccount[]>({
    queryKey: ["salary-accounts"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await (supabase.from("accounts" as any).select("id, name") as any)
        .is("deleted_at", null)
        .order("name", { ascending: true });
      if (error) throw error;
      return ((data || []) as any[]).map((a) => ({ id: a.id, name: a.name }));
    },
  });

  const accounts = accountsQuery.data ?? [];
  const { data: pendingLeaves = [] } = usePendingLeaveRequests(isAdmin);

  const saveAdj = useSaveSalaryAdjustment();
  const delAdj = useDeleteSalaryAdjustment();
  const lockM = useLockSalaryMonth();
  const unlockM = useUnlockSalaryMonth();
  const payout = useSalaryPayout({silent: true});
  const toggleExcluded = useToggleJobExcluded();
  const assignCommission = useAssignCommissionManager();
  const onToggleExclude = (jobId: string, next: boolean) =>
    toggleExcluded.mutate({ jobId, excluded: next });

  const managers = data?.managers || [];
  // Super admin / chủ công ty của tổ chức đang xem mới sửa được số tiền & khoản định kỳ
  // (server quyết; nút chỉ là lối vào — RPC tự chặn lần nữa).
  const salaryOrgId = managers.find((m) => m.organizationId)?.organizationId ?? null;
  const { data: canEditAmounts = false } = useSalaryCanEditAmounts(isAdmin && !phone ? salaryOrgId : null);
  // Chủ công ty cấp thêm của kỳ = các dòng định kỳ loại Lương QL bổ sung đang phát sinh.
  const ownerOf = (ms: SalManager[] | undefined) =>
    (ms || []).reduce((s, m) => s + m.adjustments.filter((a) => a.recurring?.category === "SUPPLEMENTARY").reduce((x, a) => x + a.amount, 0), 0);
  const pendingPayoutQuery = useSalaryPendingPayouts(periodMonth, isAdmin ? managers.map((m) => m.id) : []);
  const pendingPayouts = pendingPayoutQuery.data ?? [];
  const period = data?.period || { label: "", year: 0, periodMonth, lockedAt: null };
  const ownerId = data?.ownerId || "";
  const monthLocked = managers.length > 0 && managers.every((m) => m.status === "LOCKED");

  // Ẩn việc ký HĐ làm trong giờ ngay từ nguồn → badge trên tab khớp số dòng thật.
  const ledgerAll = useMemo(
    () => managers.flatMap((m) => m.ledger).filter((r) => !isUnqualifiedContractRow(r)),
    [managers],
  );
  const buildingsList = useMemo(() => {
    const s = new Set<string>();
    for (const r of ledgerAll) {
      const b = (r.place || "").split(" · ")[0].trim();
      if (b) s.add(b);
    }
    return [...s].sort();
  }, [ledgerAll]);

  const openLedger = (f?: { who?: string } | null) => { setLedgerFilter(f || null); setTab("ledger"); };

  // ---- callbacks → mutations ----
  const onSaveAdjustment = (staffId: string, p: SalAdjustPayload) =>
    saveAdj.mutateAsync({ ownerId, staffId, periodMonth, id: p.id, kind: p.kind, label: p.label, amount: p.amount, note: p.note });
  const onRemoveAdjustment = (id: string) => delAdj.mutate(id);
  // Hoá đơn tiền phòng của quản lý (để trả lương tự gạch nợ / cấn trừ vào lương).
  const rentInvoiceOf = (staffId: string) =>
    managers.find((m) => m.id === staffId)?.roomRentInvoice ?? null;
  const onPayout = async (staffId: string, staffName: string, amount: number, accountId: string, voucherDate: string, note: string) => {
    const result = await payout.mutateAsync({ ownerId, staffId, staffName, periodMonth, amount, account_id: accountId, voucher_date: voucherDate, note, rentInvoice: rentInvoiceOf(staffId) });
    const feedback = createdVoucherFeedback(result);
    toast[feedback.kind](`${feedback.message} Người nhận: ${staffName}.`);
    return result;
  };
  const onBulkPayout = async (rows: { staffId: string; staffName: string; amount: number }[], accountId: string) => {
    const completed: {id: string; label: string}[] = [];
    const failures: string[] = [];
    let pending = 0;
    let createdCount = 0;
    let uncertain = false;
    for (const row of rows) {
      try {
        const result = await payout.mutateAsync({ownerId, staffId:row.staffId, staffName:row.staffName, periodMonth, amount:row.amount, account_id:accountId, voucher_date:today(), note:`Lương ${period.label}/${period.year}`, rentInvoice:rentInvoiceOf(row.staffId)});
        if (result.approval_status === 'UNAPPROVED') pending++;
        createdCount++;
        completed.push({id:result.id,label:`${row.staffName}: ${createdVoucherFeedback(result).message}`});
      } catch (error) {
        failures.push(`${row.staffName}: ${workflowErrorMessage(error, 'lập phiếu chi lương')}`);
        if (error instanceof FinancialWorkflowError && error.outcome !== 'failure') {
          uncertain = true; completed.push(...error.completed);
          if (error.completed.length) createdCount++;
        }
      }
    }
    if (failures.length) throw new FinancialWorkflowError(`Đã tạo ${createdCount}/${rows.length} phiếu chi lương. ${failures.length} nhân viên chưa hoàn tất các bước. ${failures.join(' ')}`, completed.length ? 'partial' : uncertain ? 'unknown' : 'failure', completed);
    toast.success(`Đã lập ${rows.length}/${rows.length} phiếu chi lương. ${pending} phiếu đang chờ duyệt, chưa chi tiền.`);
  };
  const onLock = () => lockM.mutateAsync({ ownerId, periodMonth, managers });
  const onUnlock = () => unlockM.mutateAsync({ periodMonth, staffIds: managers.map((m) => m.id) });

  // ===== Render =====
  const sources = [...(!isAdmin && myMgr?.staff_id ? [displayMonthQuery] : []), permissionQuery, managerConfigQuery, engineQuery, salaryQuery, rulesQuery, ...(isAdmin ? [accountsQuery, ...(managers.length ? [pendingPayoutQuery] : [])] : [])];
  if (sources.some(query => query.isError || query.isLoading)) return <MainLayout title="Bảng lương"><QueryRegion label="bảng lương và sổ quỹ chi lương" queries={sources} skeleton="table" rows={6}><p>Chưa tải đủ dữ liệu tính lương. Tải lại để tiếp tục.</p></QueryRegion></MainLayout>;
  // PHONE: gộp TOÀN BỘ nhánh mobile — KHÔNG bao giờ dùng MainLayout desktop,
  // kể cả lúc quyền đang tải. Trước đây khi useMyPermissions còn tải, isAdmin
  // tạm = false → admin lẫn nhân viên đều RƠI xuống nhánh desktop MainLayout
  // "Bảng lương / Đang tải…" (nháy giao diện phụ desktop) rồi mới nhảy sang
  // shell mobile khi quyền về. Nay chờ bằng MobileSalaryBoot (shell tối).
  if (phone) {
    if (permsLoading) return <MobileSalaryBoot />; // chưa biết quyền → chờ tối
    if (isAdmin) {
      // Nhãn tháng suy TRỰC TIẾP từ periodMonth (React Query còn giữ data tháng
      // cũ 1 nhịp khi đổi tháng → tránh loading hiện sai tháng). SalaryAdminMobile
      // tự lo loading data trong shell tối (loading={isLoading}).
      const [pyNum, pmNum] = periodMonth.split("-").map((x) => parseInt(x, 10));
      const mobilePeriod = { label: `Tháng ${pmNum}`, year: pyNum };
      return (
        <SalaryAdminMobile
          managers={managers} period={mobilePeriod} loading={isLoading} locked={monthLocked} accounts={accounts}
          canLock={canLock} canPay={canPay} canManageSalary={canManageSalary}
          onSaveAdjustment={onSaveAdjustment} onRemoveAdjustment={onRemoveAdjustment}
          onPayout={onPayout} onBulkPayout={onBulkPayout}
          onLock={onLock} onUnlock={onUnlock}
          onPrevMonth={() => setPeriodMonth((p) => shiftMonth(p, -1))}
          onNextMonth={() => setPeriodMonth((p) => shiftMonth(p, 1))}
          onRecompute={() => refetch()}
        />
      );
    }
    // Nhân viên (self) trên phone
    if (myLoading || isLoading) return <MobileSalaryBoot />;
    if (!myMgr || managers.length === 0) return <MobileSalaryEmpty />;
    const meMobile = managers.find((m) => m.id === myMgr.staff_id) || managers[0];
    const [syNum, smNum] = effPeriod.split("-").map((x) => parseInt(x, 10));
    const selfCanNext = effPeriod < selfCeiling;
    return (
      <SalarySelfMobile
        m={meMobile}
        period={{ label: `Tháng ${smNum}`, year: syNum }}
        canPrev
        canNext={selfCanNext}
        onPrevMonth={() => setSelfOverride(shiftMonth(effPeriod, -1))}
        onNextMonth={() => { if (selfCanNext) setSelfOverride(shiftMonth(effPeriod, 1)); }}
      />
    );
  }

  // ===== DESKTOP =====
  // Không phải admin: hiện self-view nếu là quản lý hưởng lương
  if (!isAdmin) {
    if (myLoading || isLoading) {
      return <MainLayout title="Bảng lương" subtitle="Tài chính → Lương" icon={Wallet}><LoadingState label="bảng lương" variant="cards" rows={3} /></MainLayout>;
    }
    if (!myMgr || managers.length === 0) {
      return <MainLayout title="Bảng lương" subtitle="Tài chính → Lương" icon={Wallet}>
        <p className="text-muted-foreground">Bạn chưa được cấu hình hưởng lương. Liên hệ quản trị để được thiết lập.</p>
      </MainLayout>;
    }
    const me = managers.find((m) => m.id === myMgr.staff_id) || managers[0];
    return (
      <MainLayout title="Lương của tôi" subtitle="Tài chính → Lương" icon={Wallet}>
        <div className="sal-root">
          <SalarySelf m={me} period={period} />
        </div>
      </MainLayout>
    );
  }

  // Admin (desktop) — "Lương & thu nhập" theo bản Claude Design 26/09/2026.
  const previewMgr = view === "self" ? managers.find((m) => m.id === selfId) : null;
  const allLocked = (ms: SalManager[] | undefined) => !!ms && ms.length > 0 && ms.every((m) => m.status === "LOCKED");
  const fundPeriods: FundPeriod[] = [
    { periodMonth: prev2, locked: allLocked(dPrev2?.managers), managers: dPrev2?.managers || [], fee: fee2.total, owner: ownerOf(dPrev2?.managers), loading: lPrev2 || fee2.isLoading },
    { periodMonth: prev1, locked: allLocked(dPrev1?.managers), managers: dPrev1?.managers || [], fee: fee1.total, owner: ownerOf(dPrev1?.managers), loading: lPrev1 || fee1.isLoading },
    { periodMonth, locked: monthLocked, managers, fee: fee0.total, owner: ownerOf(managers), loading: isLoading || fee0.isLoading },
  ];
  const pendingStaff = new Set(pendingPayouts.map((p) => p.staffId));
  const openPerson = (id: string) => { setPerson(id); setTab("people"); };
  const monthShortLabel = `Th${parseInt(periodMonth.slice(5, 7), 10)}`;

  return (
    <MainLayout title="Lương & thu nhập" subtitle="Tài chính → Lương" icon={Wallet}>
      <div className="sal-root">
        {managers.length > 1 && (
          <div className="sal-previewbar">
            <div className="sal-roleswitch">
              <span><Eye size={13} />Xem dưới vai trò</span>
              <button className="sal-rolebtn" data-active={view === "admin"} onClick={() => setView("admin")}>Quản trị viên</button>
              {managers.map((m) => (
                <button key={m.id} className="sal-rolebtn" data-active={view === "self" && selfId === m.id}
                  onClick={() => { setView("self"); setSelfId(m.id); }}>{m.short}{m.alias ? " · " + m.alias : ""}</button>
              ))}
            </div>
          </div>
        )}

        {view === "self" && previewMgr ? (
          <SalarySelf m={previewMgr} period={period} onOpenLedger={() => { setView("admin"); openLedger({ who: previewMgr.id }); }} />
        ) : (
          <>
            <div className="sal-card" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
              <div className="sal-monthnav">
                <button className="sal-monthbtn" aria-label="Tháng trước" onClick={() => setPeriodMonth((p) => shiftMonth(p, -1))}><ChevronLeft size={17} /></button>
                <span className="sal-monthlabel">Tháng {parseInt(periodMonth.slice(5, 7), 10)} · {periodMonth.slice(0, 4)}</span>
                <button className="sal-monthbtn" aria-label="Tháng sau" onClick={() => setPeriodMonth((p) => shiftMonth(p, 1))}><ChevronRight size={17} /></button>
              </div>
              {monthLocked
                ? <span className="sal-status sal-status--locked"><Lock size={14} />Đã chốt</span>
                : <span className="sal-status sal-status--draft"><span className="dot" />Chưa chốt <small>· số tạm tính</small></span>}
              <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
                {!monthLocked && <button className="sal-btn sal-btn--outline" onClick={() => refetch()}><RefreshCw size={15} />Tính lại</button>}
                {canPay && managers.length > 0 && <button className="sal-btn sal-btn--outline" onClick={() => setShowBulk(true)}><HandCoins size={16} />Trả lương hàng loạt</button>}
                {canLock && managers.length > 0 && (monthLocked
                  ? <button className="sal-btn sal-btn--outline" onClick={() => setShowLock(true)}><Unlock size={15} />Mở khoá {monthShortLabel}</button>
                  : <button className="sal-btn sal-btn--primary" onClick={() => setShowLock(true)}><Lock size={15} />Chốt kỳ {monthShortLabel}</button>)}
              </div>
            </div>

            <div className="sal-tabs">
              <button className="sal-tab" data-active={tab === "overview"} onClick={() => setTab("overview")}><LayoutDashboard size={16} />Tổng quan kỳ</button>
              <button className="sal-tab" data-active={tab === "people"} onClick={() => setTab("people")}>
                <Wallet size={16} />Thu nhập &amp; thanh toán
                {pendingPayouts.length > 0 && <span className="sal-tabcount">{pendingPayouts.length}</span>}
              </button>
              <button className="sal-tab" data-active={tab === "ledger"} onClick={() => setTab("ledger")}><Eye size={16} />Bảng kê công việc<span className="sal-tabcount">{ledgerAll.length}</span></button>
              <button className="sal-tab" data-active={tab === "leave"} onClick={() => setTab("leave")}>
                <CalendarCheck size={16} />Đơn xin nghỉ
                {pendingLeaves.length > 0 && <span className="sal-tabcount">{pendingLeaves.length}</span>}
              </button>
              {canManageSalary && <button className="sal-tab" data-active={tab === "config"} onClick={() => setTab("config")}><Settings size={16} />Cấu hình</button>}
            </div>

            {isLoading ? (
              <div className="sal-card"><LoadingState label="bảng lương" variant="table" rows={6} className="p-4" /></div>
            ) : tab === "leave" ? (
              <SalaryLeaveRequests />
            ) : tab === "config" ? (
              <SalaryConfig />
            ) : managers.length === 0 ? (
              <div className="sal-card"><div className="sal-empty">
                <span className="ec"><Wallet size={28} /></span>
                <h3>Chưa có quản lý hưởng lương</h3>
                <p>Vào tab Cấu hình để thêm quản lý vào diện hưởng lương, đặt lương cứng và tiền phòng.</p>
              </div></div>
            ) : tab === "overview" ? (
              <QueryRegion label="cơ cấu quỹ lương" queries={[prev1Query,prev2Query,fee0,fee1,fee2]} skeleton="cards" rows={3}>
              <SalaryFundOverview
                periods={fundPeriods} feeBuildings={fee0.rows.length} feeUnpublished={fee0.unpublished}
                pending={pendingPayouts} onOpenFund={setFundModal} onOpenPerson={openPerson}
              />
              </QueryRegion>
            ) : tab === "people" ? (
              <SalaryIncomePay
                managers={managers} period={period} selectedId={person} onSelect={setPerson}
                pending={pendingPayouts} accounts={accounts} canPay={canPay}
                onPayout={onPayout} payBusy={payout.isPending} onOpenLedger={openLedger}
                onAdjust={(m, edit) => setAdjDialog({ m, edit })} onRemoveAdjustment={onRemoveAdjustment}
                canEditAmounts={canEditAmounts} onEditAmount={(m, line) => setAmountEdit({ m, line })}
                onAssignCommission={isAdmin ? (m, voucherId, expectedVersion) => assignCommission.mutate({ voucherId, managerId: m.id, expectedVersion: expectedVersion ?? null }) : undefined}
                assignBusy={assignCommission.isPending}
              />
            ) : (
              <>
                {ledgerFilter?.who && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13 }}>
                    <span className="sal-chip-soft" style={{ background: "hsl(var(--primary) / .1)", color: "hsl(var(--primary))" }}>
                      <Eye size={13} />Đang lọc: {managers.find((m) => m.id === ledgerFilter.who)?.short}
                      <button onClick={() => setLedgerFilter(null)} style={{ border: "none", background: "none", cursor: "pointer", color: "inherit", display: "inline-flex", marginLeft: 2 }}>✕</button>
                    </span>
                  </div>
                )}
                <SalaryLedger
                  key={ledgerFilter?.who || "all"}
                  ledger={ledgerAll} managers={managers} buildings={buildingsList}
                  period={period} requirePhoto={requirePhoto} initialFilter={ledgerFilter}
                  onToggleExclude={isAdmin && !monthLocked ? onToggleExclude : undefined}
                  busyJobId={toggleExcluded.isPending ? (toggleExcluded.variables as any)?.jobId : null}
                />
              </>
            )}
          </>
        )}

        {fundModal && (<QueryRegion label="nguồn quỹ lương" queries={[fee0]} skeleton="none">
          <SalaryFundModal tab={fundModal} onTab={setFundModal} onClose={() => setFundModal(null)}
            periodMonth={periodMonth} locked={monthLocked} fee={fee0} managers={managers}
            recurring={data?.extras.recurring ?? []} extrasAvailable={data?.extras.available ?? false} canEdit={canEditAmounts} />
        </QueryRegion>)}
        {amountEdit && <SalaryAmountEditDialog m={amountEdit.m} line={amountEdit.line} periodMonth={periodMonth} onClose={() => setAmountEdit(null)} />}
        {adjDialog && <AdjustDialog m={adjDialog.m} edit={adjDialog.edit} onClose={() => setAdjDialog(null)}
          onSave={(p) => onSaveAdjustment(adjDialog.m.id, p)} />}
        {showLock && <LockDialog locked={monthLocked} period={period} onClose={() => setShowLock(false)} onConfirm={() => monthLocked ? onUnlock() : onLock()} />}
        {/* Người đang có phiếu chi chờ duyệt không vào đợt trả hàng loạt — tránh lập trùng. */}
        {showBulk && <BulkPayoutDialog managers={managers.filter((m) => !pendingStaff.has(m.id))} accounts={accounts} period={period}
          onClose={() => setShowBulk(false)} onSave={onBulkPayout} />}
      </div>
    </MainLayout>
  );
}
