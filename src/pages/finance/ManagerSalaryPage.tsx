import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wallet, Eye, Settings } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { supabase } from "@/integrations/supabase/client";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import {
  useManagerSalary, useMyManagerConfig, useStaffDisplayMonth,
  useSaveSalaryAdjustment, useDeleteSalaryAdjustment,
  useLockSalaryMonth, useUnlockSalaryMonth, useSalaryPayout,
} from "@/hooks/useManagerSalary";
import { useBonusRules } from "@/hooks/useSalaryConfig";
import SalaryMonthly, { type SalaryAccount, type SalAdjustPayload } from "@/components/salary/SalaryMonthly";
import SalaryLedger from "@/components/salary/SalaryLedger";
import SalaryConfig from "@/components/salary/SalaryConfig";
import SalarySelf from "@/components/salary/SalarySelf";
import SalarySelfMobile from "@/components/salary/SalarySelfMobile";
import SalaryAdminMobile from "@/components/salary/SalaryAdminMobile";
import { usePhoneViewport } from "@/hooks/use-mobile";
import { usePersistedState } from "@/hooks/usePersistedState";
import "@/components/salary/salary.css";

function currentPeriodMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function shiftMonth(pm: string, delta: number): string {
  const [y, m] = pm.split("-").map((x) => parseInt(x, 10));
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
const today = () => new Date().toISOString().slice(0, 10);

export default function ManagerSalaryPage() {
  const { data: perms } = useMyPermissions();
  const { data: myMgr, isLoading: myLoading } = useMyManagerConfig();
  const phone = usePhoneViewport();

  const canLock = canUse(perms, "salary", "lock");
  const canManageSalary = canUse(perms, "salary", "manage_salary");
  const canPay = canUse(perms, "salary", "distribute");
  const isAdmin = !!(perms as any)?.__superadmin || canLock || canManageSalary || canPay;

  const [periodMonth, setPeriodMonth] = usePersistedState<string>("flt:salary-manager:period", currentPeriodMonth());
  const [tab, setTab] = usePersistedState<"sheet" | "ledger" | "config">("flt:salary-manager:tab", "sheet");
  const [view, setView] = useState<"admin" | "self">("admin");
  const [selfId, setSelfId] = useState<string | null>(null);
  const [ledgerFilter, setLedgerFilter] = useState<{ who?: string } | null>(null);

  // Nhân viên (không phải admin): mặc định hiển thị tháng lùi theo chốt lương +
  // override admin. Admin giữ điều hướng tháng tự do.
  const { data: staffMonth } = useStaffDisplayMonth(myMgr?.staff_id, !isAdmin);
  const effPeriod = !isAdmin && staffMonth ? staffMonth : periodMonth;

  const { data, isLoading, refetch } = useManagerSalary(effPeriod);
  const { data: rulesData } = useBonusRules();
  const requirePhoto = !!rulesData?.rules?.requirePhoto;

  const { data: accounts = [] } = useQuery<SalaryAccount[]>({
    queryKey: ["salary-accounts"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data } = await (supabase.from("accounts" as any).select("id, name") as any)
        .is("deleted_at", null)
        .order("name", { ascending: true });
      return ((data || []) as any[]).map((a) => ({ id: a.id, name: a.name }));
    },
  });

  const saveAdj = useSaveSalaryAdjustment();
  const delAdj = useDeleteSalaryAdjustment();
  const lockM = useLockSalaryMonth();
  const unlockM = useUnlockSalaryMonth();
  const payout = useSalaryPayout();

  const managers = data?.managers || [];
  const period = data?.period || { label: "", year: 0, periodMonth, lockedAt: null };
  const ownerId = data?.ownerId || "";
  const monthLocked = managers.length > 0 && managers.every((m) => m.status === "LOCKED");

  const ledgerAll = useMemo(() => managers.flatMap((m) => m.ledger), [managers]);
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
    saveAdj.mutate({ ownerId, staffId, periodMonth, id: p.id, kind: p.kind, label: p.label, amount: p.amount, note: p.note });
  const onRemoveAdjustment = (id: string) => delAdj.mutate(id);
  // Hoá đơn tiền phòng của quản lý (để trả lương tự gạch nợ / cấn trừ vào lương).
  const rentInvoiceOf = (staffId: string) =>
    managers.find((m) => m.id === staffId)?.roomRentInvoice ?? null;
  const onPayout = (staffId: string, staffName: string, amount: number, accountId: string, voucherDate: string, note: string) =>
    payout.mutate({ ownerId, staffId, staffName, periodMonth, amount, account_id: accountId, voucher_date: voucherDate, note, rentInvoice: rentInvoiceOf(staffId) });
  const onBulkPayout = (rows: { staffId: string; staffName: string; amount: number }[], accountId: string) =>
    rows.forEach((r) => payout.mutate({ ownerId, staffId: r.staffId, staffName: r.staffName, periodMonth, amount: r.amount, account_id: accountId, voucher_date: today(), note: `Lương ${period.label}/${period.year}`, rentInvoice: rentInvoiceOf(r.staffId) }));
  const onLock = () => lockM.mutate({ ownerId, periodMonth, managers });
  const onUnlock = () => unlockM.mutate({ periodMonth, staffIds: managers.map((m) => m.id) });

  // ===== Render =====
  // Không phải admin: hiện self-view nếu là quản lý hưởng lương
  if (!isAdmin) {
    if (myLoading || isLoading) {
      return <MainLayout title="Bảng lương" subtitle="Tài chính → Lương" icon={Wallet}><p className="text-muted-foreground">Đang tải...</p></MainLayout>;
    }
    if (!myMgr || managers.length === 0) {
      return <MainLayout title="Bảng lương" subtitle="Tài chính → Lương" icon={Wallet}>
        <p className="text-muted-foreground">Bạn chưa được cấu hình hưởng lương. Liên hệ quản trị để được thiết lập.</p>
      </MainLayout>;
    }
    const me = managers.find((m) => m.id === myMgr.staff_id) || managers[0];
    // Mobile: shell web-app chiếm trọn màn (không MainLayout) — giống Thu tiền / Home launcher.
    if (phone) return <SalarySelfMobile m={me} period={period} />;
    return (
      <MainLayout title="Lương của tôi" subtitle="Tài chính → Lương" icon={Wallet}>
        <div className="sal-root">
          <SalarySelf m={me} period={period} />
        </div>
      </MainLayout>
    );
  }

  // Admin
  const previewMgr = view === "self" ? managers.find((m) => m.id === selfId) : null;

  // Mobile: shell web-app chiếm trọn màn (không MainLayout) — 4 tab dưới đáy
  // (Lương / Cá nhân / Bảng kê / Cấu hình). Bỏ role switcher + self-preview vì
  // tab "Cá nhân" đã thay thế. Tự xử lý loading/empty trong shell tối (không
  // rơi xuống nhánh desktop sáng) — đổi tháng = spinner gaming tại chỗ.
  if (phone) {
    // Nhãn tháng suy TRỰC TIẾP từ periodMonth (tháng đang yêu cầu), KHÔNG lấy
    // từ data.period — vì khi đổi tháng React Query còn giữ data tháng cũ 1 nhịp
    // → màn loading sẽ hiện sai tháng. periodMonth luôn là nguồn sự thật.
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

  return (
    <MainLayout title="Bảng lương quản lý" subtitle="Tài chính → Lương" icon={Wallet}>
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
          phone ? (
            <SalarySelfMobile m={previewMgr} period={period} onExit={() => setView("admin")} />
          ) : (
            <SalarySelf m={previewMgr} period={period} onOpenLedger={() => { setView("admin"); openLedger({ who: previewMgr.id }); }} />
          )
        ) : (
          <>
            <div className="sal-tabs">
              <button className="sal-tab" data-active={tab === "sheet"} onClick={() => setTab("sheet")}><Wallet size={16} />Bảng lương tháng</button>
              <button className="sal-tab" data-active={tab === "ledger"} onClick={() => setTab("ledger")}><Eye size={16} />Bảng kê công việc<span className="sal-tabcount">{ledgerAll.length}</span></button>
              {canManageSalary && <button className="sal-tab" data-active={tab === "config"} onClick={() => setTab("config")}><Settings size={16} />Cấu hình</button>}
            </div>

            {isLoading ? (
              <div className="sal-card"><div style={{ padding: 40, textAlign: "center", color: "hsl(var(--muted-foreground))" }}>Đang tải bảng lương...</div></div>
            ) : managers.length === 0 ? (
              <div className="sal-card"><div className="sal-empty">
                <span className="ec"><Wallet size={28} /></span>
                <h3>Chưa có quản lý hưởng lương</h3>
                <p>Vào tab Cấu hình để thêm quản lý vào diện hưởng lương, đặt lương cứng và tiền phòng.</p>
              </div></div>
            ) : tab === "sheet" ? (
              <SalaryMonthly
                managers={managers} period={period} locked={monthLocked} accounts={accounts}
                canLock={canLock} canPay={canPay}
                onSaveAdjustment={onSaveAdjustment} onRemoveAdjustment={onRemoveAdjustment}
                onPayout={onPayout} onBulkPayout={onBulkPayout}
                onLock={onLock} onUnlock={onUnlock} onOpenLedger={openLedger}
                onPrevMonth={() => setPeriodMonth((p) => shiftMonth(p, -1))}
                onNextMonth={() => setPeriodMonth((p) => shiftMonth(p, 1))}
                onRecompute={() => refetch()}
              />
            ) : tab === "ledger" ? (
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
                />
              </>
            ) : (
              <SalaryConfig />
            )}
          </>
        )}
      </div>
    </MainLayout>
  );
}
