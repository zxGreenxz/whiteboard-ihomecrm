import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { isCanonicalFallbackSignal } from "@/lib/canonicalFallback";
import { toast } from "sonner";
import {
  type SalManager,
  type SalLedgerRow,
  type SalAdjustment,
  type SalTrendPoint,
  type SalCommissionItem,
  salCalc,
  buildBonusAuto,
  computeStats,
  computeStreak,
  firstName,
  initialsOf,
  shiftYm,
  staffCeilingYm,
} from "@/lib/managerSalary";
// YYYY-MM-01 cho tháng lệch n so với mốc — canonical ở lib/salaryPeriod (10E).
import { shiftPeriodMonth as shiftMonth, vnYmOf } from "@/lib/salaryPeriod";

export interface SalPeriod {
  periodMonth: string; // YYYY-MM-01
  label: string; // "Tháng 6"
  year: number;
  lockedAt: string | null;
}

export interface ManagerSalaryData {
  managers: SalManager[];
  period: SalPeriod;
  ownerId: string;
}

const num = (v: any) => Number(v) || 0;
function monthRange(periodMonth: string) {
  const start = periodMonth;
  const next = shiftMonth(periodMonth, 1);
  const [ny, nm] = next.split("-").map((x) => parseInt(x, 10));
  const end = new Date(Date.UTC(ny, nm - 1, 0)); // ngày cuối tháng hiện tại
  return { start, end: `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}` };
}
function fmtDM(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

export const useManagerSalary = (periodMonth: string, engine: "legacy" | "v5" = "legacy") => {
  return useQuery<ManagerSalaryData>({
    queryKey: ["manager-salary", periodMonth, engine],
    enabled: !!periodMonth,
    queryFn: async () => {
      const { start, end } = monthRange(periodMonth);
      const [yy, mm] = periodMonth.split("-").map((x) => parseInt(x, 10));
      const period: SalPeriod = { periodMonth, label: `Tháng ${mm}`, year: yy, lockedAt: null };

      // 1) Cấu hình quản lý hưởng lương (hiệu lực trong tháng)
      const { data: cfgRaw } = await (supabase
        .from("manager_salary_config")
        .select("*") as any)
        .eq("is_active", true)
        .lte("effective_from", start)
        .order("created_at", { ascending: true });
      const configs = ((cfgRaw || []) as any[]).filter(
        (c) => !c.effective_to || c.effective_to >= start
      );
      if (configs.length === 0) return { managers: [], period, ownerId: "" };

      const staffIds: string[] = configs.map((c) => c.staff_id);
      const ownerId: string = configs[0].user_id;
      // Tiền phòng khấu trừ theo THÁNG T+1: lương tháng T trả vào tháng kế nên
      // trừ tiền phòng của tháng kế (vd lương T5 → tiền phòng hoá đơn T6).
      const rentPeriod = shiftMonth(periodMonth, 1); // 'YYYY-MM-01' tháng kế
      const billingMonth = rentPeriod.slice(0, 7); // 'YYYY-MM' tháng kế
      const rentMm = parseInt(rentPeriod.slice(5, 7), 10); // số tháng cho nhãn

      // Tiền phòng từ hoá đơn phòng nhân viên ở (giá ưu đãi)
      const roomIds: string[] = configs.map((c) => c.room_id).filter(Boolean);
      const roomInvoice = new Map<
        string,
        {
          amount: number;
          label: string;
          invoiceId: string;
          buildingId: string | null;
          contractId: string | null;
          remaining: number;
        }
      >();
      const roomNameById = new Map<string, string>();
      if (roomIds.length) {
        const [rmRes, invRes] = await Promise.all([
          (supabase.from("rooms").select("id, name") as any).in("id", roomIds),
          (supabase
            .from("invoices")
            .select("id, room_id, building_id, contract_id, total_amount, remaining_amount, billing_month, created_at") as any)
            .in("room_id", roomIds)
            .eq("billing_month", billingMonth)
            // Lương tính trên hoá đơn THÁNG — bỏ hoá đơn thanh lý (kind
            // SETTLEMENT có thể chung tháng từ 20260709100000, tạo sau → sẽ
            // chiếm chỗ "mới nhất" và làm sai cơ sở lương nếu không lọc).
            .eq("kind", "MONTHLY")
            .is("deleted_at", null)
            .order("created_at", { ascending: false }),
        ]);
        for (const r of (rmRes.data || []) as any[]) roomNameById.set(r.id, r.name);
        for (const iv of (invRes.data || []) as any[]) {
          if (roomInvoice.has(iv.room_id)) continue; // hoá đơn mới nhất của phòng/tháng
          const total = num(iv.total_amount);
          roomInvoice.set(iv.room_id, {
            amount: total,
            label: `HĐ phòng ${roomNameById.get(iv.room_id) || ""} · T${rentMm}`,
            invoiceId: iv.id,
            buildingId: iv.building_id ?? null,
            contractId: iv.contract_id ?? null,
            remaining: iv.remaining_amount == null ? total : num(iv.remaining_amount),
          });
        }
      }

      // 2..N) các nguồn dữ liệu song song
      const [
        profilesRes,
        ledgerRes,
        monthlyRes,
        shRes,
        pmRes,
        ieRes,
        buildingsRes,
        trendRes,
      ] = await Promise.all([
        (supabase.from("profiles").select("id, full_name") as any).in("id", staffIds),
        (supabase.rpc as any)("salary_work_ledger", { p_period_month: periodMonth, p_staff_id: null }),
        (supabase.from("salary_monthly").select("*") as any).eq("period_month", periodMonth).in("staff_id", staffIds),
        (supabase.from("shareholders").select("id, auth_user_id") as any).in("auth_user_id", staffIds),
        (supabase.from("profit_monthly").select("status, period_month") as any).eq("period_month", periodMonth),
        (supabase
          .from("income_expenses")
          .select("id, salary_staff_id, salary_role, name, total_amount, approval_status, voucher_date") as any)
          .in("salary_staff_id", staffIds)
          .eq("salary_role", "ADVANCE")
          .is("deleted_at", null)
          .gte("voucher_date", start)
          .lte("voucher_date", end),
        (supabase.from("buildings").select("id, name, code") as any),
        (supabase
          .from("salary_monthly")
          .select("staff_id, period_month, gross_total, take_home, status, locked_at") as any)
          .in("staff_id", staffIds)
          .gte("period_month", shiftMonth(periodMonth, -5))
          .lte("period_month", periodMonth),
      ]);

      const nameById = new Map<string, string>(
        ((profilesRes.data || []) as any[]).map((p) => [p.id, p.full_name])
      );
      const shByStaff = new Map<string, string>(
        ((shRes.data || []) as any[]).map((s) => [s.auth_user_id, s.id])
      );
      const shIds = [...shByStaff.values()];
      const anyProfitDraft = ((pmRes.data || []) as any[]).some((r) => r.status === "DRAFT");
      const bldName = new Map<string, string>(
        ((buildingsRes.data || []) as any[]).map((b) => [b.id, b.code || b.name])
      );

      // HH Sale: phiếu chi hoa hồng (loại "Hoa hồng môi giới"/"HHMG"/category HOA HỒNG)
      // có NGƯỜI-NHẬN (payer_name) = tên/biệt danh quản lý, kỳ phân bổ (item.start_date)
      // trong tháng. Tháng nháp: phiếu CHƯA DUYỆT (UNAPPROVED) mới tính (chốt lương sẽ
      // tự duyệt); phiếu ĐÃ DUYỆT → cảnh báo "!" (cần kiểm tra).
      const aliasToStaff = new Map<string, string>();
      for (const c of configs) {
        const al = (c.alias || "").trim().toLowerCase();
        if (al) aliasToStaff.set(al, c.staff_id);
        const fn = firstName(nameById.get(c.staff_id) || "").trim().toLowerCase();
        if (fn) aliasToStaff.set(fn, c.staff_id);
      }
      const commByStaff = new Map<string, { items: SalCommissionItem[]; flagged: SalCommissionItem[] }>();
      {
        const { data: ctRaw } = await (supabase.from("income_expense_types").select("id, name, category") as any);
        const commTypeIds = ((ctRaw || []) as any[])
          .filter((t) => String(t.category || "").toUpperCase() === "HOA HỒNG" || /hoa h[ồô]ng|hhmg/i.test(String(t.name || "")))
          .map((t) => t.id);
        if (commTypeIds.length) {
          // PAGED: cộng hoa hồng qua cả tháng, không chặn per-entity → phân trang kẻo cap 1000.
          const ciRaw = await fetchAllRows<any>(
            (from, to) =>
              (supabase
                .from("income_expense_items")
                .select("id, amount, start_date, income_expenses(id, name, payer_name, approval_status, type, deleted_at)") as any)
                .in("income_expense_type_id", commTypeIds)
                .gte("start_date", start)
                .lte("start_date", end)
                .order("id", { ascending: true })
                .range(from, to),
            { label: "salary.commissionItems" },
          );
          // FAIL-CLOSED: lỗi tải KHÔNG được biến thành hoa hồng 0 (làm lương sai
          // âm thầm). null = query lỗi → dừng cả query để hiện lỗi cho user.
          if (ciRaw === null) {
            throw new Error("Lỗi tải dữ liệu hoa hồng (income_expense_items) — không thể tính lương chính xác.");
          }
          const voucherMap = new Map<string, { name: string; status: string; amount: number; staff: string }>();
          for (const row of ciRaw as any[]) {
            const ie = (row as any).income_expenses;
            if (!ie || ie.type !== "EXPENSE" || ie.deleted_at || ie.approval_status === "CANCELLED") continue;
            const staff = aliasToStaff.get((ie.payer_name || "").trim().toLowerCase());
            if (!staff) continue;
            const ex = voucherMap.get(ie.id);
            if (ex) ex.amount += num(row.amount);
            else voucherMap.set(ie.id, { name: ie.name || "Hoa hồng", status: ie.approval_status, amount: num(row.amount), staff });
          }
          for (const [vid, v] of voucherMap) {
            const entry = commByStaff.get(v.staff) || { items: [] as SalCommissionItem[], flagged: [] as SalCommissionItem[] };
            const item: SalCommissionItem = { label: v.name, amount: v.amount, approved: v.status === "APPROVED", voucherId: vid };
            (v.status === "APPROVED" ? entry.flagged : entry.items).push(item);
            commByStaff.set(v.staff, entry);
          }
        }
      }

      // allocations (đầu tư) cho tháng — chỉ khi có cổ đông
      let allocs: any[] = [];
      if (shIds.length) {
        const { data: aRaw } = await (supabase
          .from("profit_allocations")
          .select("shareholder_id, amount, pm:profit_monthly_id(period_month, building_id, status)") as any)
          .in("shareholder_id", shIds);
        allocs = ((aRaw || []) as any[]).filter(
          (a) => a.pm?.period_month === periodMonth && a.pm?.status === "LOCKED"
        );
      }

      const ledgerAll: SalLedgerRow[] = ((ledgerRes.data || []) as any[]).map((r) => ({
        staff_id: r.staff_id,
        item_type: r.item_type,
        source_id: r.source_id,
        occurred_date: r.occurred_date,
        day_label: r.day_label || "",
        content: r.content || "",
        place: r.place || "",
        job_type_name: r.job_type_name,
        is_repair: !!r.is_repair,
        is_contract: !!r.is_contract,
        base_amount: num(r.base_amount),
        weekend_amount: num(r.weekend_amount),
        after_amount: num(r.after_amount),
        cash_amount: r.cash_amount == null ? null : num(r.cash_amount),
        has_photo: r.has_photo,
        bonus_amount: r.bonus_amount == null ? null : num(r.bonus_amount),
        reason: r.reason || "",
        excluded: !!r.excluded,
      }));

      const monthlyByStaff = new Map<string, any>(
        ((monthlyRes.data || []) as any[]).map((r) => [r.staff_id, r])
      );
      const lockedMonthlyIds = ((monthlyRes.data || []) as any[])
        .filter((r) => r.status === "LOCKED")
        .map((r) => r.id);

      // snapshot cho tháng ĐÃ CHỐT (đóng băng bảng kê)
      let snapByStaff = new Map<string, SalLedgerRow[]>();
      if (lockedMonthlyIds.length) {
        const { data: snapRaw } = await (supabase
          .from("salary_work_ledger_snapshot")
          .select("*") as any)
          .in("salary_monthly_id", lockedMonthlyIds);
        for (const s of (snapRaw || []) as any[]) {
          const arr = snapByStaff.get(s.staff_id) || [];
          arr.push({
            staff_id: s.staff_id, item_type: s.item_type, source_id: s.source_id,
            occurred_date: s.occurred_date, day_label: s.day_label || "", content: s.content || "",
            place: s.place || "", job_type_name: s.job_type_name, is_repair: !!s.is_repair,
            is_contract: !!s.is_contract,
            base_amount: num(s.base_amount), weekend_amount: num(s.weekend_amount),
            after_amount: num(s.after_amount), cash_amount: s.cash_amount == null ? null : num(s.cash_amount),
            has_photo: s.has_photo, bonus_amount: s.bonus_amount == null ? null : num(s.bonus_amount),
            reason: s.reason || "",
          });
          snapByStaff.set(s.staff_id, arr);
        }
      }

      // adjustments cho các salary_monthly hiện có
      const monthlyIds = ((monthlyRes.data || []) as any[]).map((r) => r.id);
      let adjByMonthly = new Map<string, SalAdjustment[]>();
      if (monthlyIds.length) {
        const { data: adjRaw } = await (supabase
          .from("salary_adjustments")
          .select("*") as any)
          .in("salary_monthly_id", monthlyIds);
        for (const a of (adjRaw || []) as any[]) {
          const arr = adjByMonthly.get(a.salary_monthly_id) || [];
          arr.push({
            id: a.id,
            icon: a.kind === "DEDUCTION" ? "Minus" : "Plus",
            label: a.label,
            amount: a.kind === "DEDUCTION" ? -num(a.amount) : num(a.amount),
            note: a.note,
            source: a.source,
          });
          adjByMonthly.set(a.salary_monthly_id, arr);
        }
      }

      // income_expenses → commission / advance theo staff
      const ieByStaff = new Map<string, any[]>();
      for (const ie of (ieRes.data || []) as any[]) {
        const arr = ieByStaff.get(ie.salary_staff_id) || [];
        arr.push(ie);
        ieByStaff.set(ie.salary_staff_id, arr);
      }

      // trend theo staff
      const trendRows = (trendRes.data || []) as any[];
      const trendByStaffMonth = new Map<string, any>();
      for (const r of trendRows) trendByStaffMonth.set(`${r.staff_id}|${r.period_month}`, r);

      // CHẾ ĐỘ v5: số liệu lương tháng CHƯA chốt lấy từ engine v5 (chuyên cần + chuỗi).
      // Gọi v5_month_money(staff, tháng) + current_streak; tháng đã chốt KHÔNG override.
      const v5ByStaff = new Map<string, { attend: number; streak: number; ticked: number; nchuan: number; cur: number }>();
      if (engine === "v5") {
        const [v5Arr, sssRes] = await Promise.all([
          Promise.all(staffIds.map(async (sid) => {
            const { data } = await (supabase.rpc as any)("v5_month_money", { p_user: sid, p_month: periodMonth });
            return { sid, data };
          })),
          (supabase.from("salary_streak_state").select("user_id, current_streak") as any)
            .in("user_id", staffIds).eq("period_month", periodMonth),
        ]);
        const curByStaff = new Map<string, number>(
          ((sssRes.data || []) as any[]).map((r) => [r.user_id, num(r.current_streak)])
        );
        for (const { sid, data: mm } of v5Arr) {
          v5ByStaff.set(sid, {
            attend: num(mm?.attend_amount), streak: num(mm?.streak_amount),
            ticked: num(mm?.ticked_days), nchuan: num(mm?.n_chuan),
            cur: curByStaff.get(sid) || 0,
          });
        }
      }

      let lockedAt: string | null = null;

      const managers: SalManager[] = configs.map((c, idx) => {
        const staff = c.staff_id;
        const full = nameById.get(staff) || c.alias || "Quản lý";
        const short = firstName(full);
        const mRow = monthlyByStaff.get(staff);
        const locked = mRow?.status === "LOCKED";
        if (locked && mRow?.locked_at && !lockedAt) lockedAt = mRow.locked_at;

        // bảng kê: tháng chốt → snapshot; còn lại → live RPC
        const ledger = locked
          ? snapByStaff.get(staff) || []
          : ledgerAll.filter((r) => r.staff_id === staff);

        let bonusAuto = buildBonusAuto(ledger);
        const adjustments = mRow ? adjByMonthly.get(mRow.id) || [] : [];

        // đầu tư
        const myAllocs = allocs.filter((a) => a.shareholder_id === shByStaff.get(staff));
        const investment = myAllocs.reduce((s, a) => s + num(a.amount), 0);
        const investmentBy = myAllocs.map((a) => ({ b: bldName.get(a.pm?.building_id) || "—", amount: num(a.amount) }));
        const hasSh = shByStaff.has(staff);
        const pending = hasSh && investment === 0 && anyProfitDraft;

        // HH Sale: phiếu hoa hồng người-nhận = quản lý (commByStaff). Tháng nháp: chỉ
        // phiếu CHƯA DUYỆT tính (chốt lương → tự duyệt); phiếu ĐÃ duyệt → cảnh báo "!".
        // Tháng ĐÃ CHỐT: dùng số đã đóng băng; hiện đủ phiếu, bỏ cảnh báo.
        const commEntry = commByStaff.get(staff) || { items: [] as SalCommissionItem[], flagged: [] as SalCommissionItem[] };
        const commissionItems = locked ? commEntry.items.concat(commEntry.flagged) : commEntry.items;
        const commissionFlagged = locked ? [] : commEntry.flagged;
        const commission = locked ? num(mRow?.commission_total) : commEntry.items.reduce((s, x) => s + x.amount, 0);

        // ứng lương
        const ieRows = ieByStaff.get(staff) || [];
        const advanceItems = ieRows
          .filter((x) => x.salary_role === "ADVANCE" && x.approval_status === "APPROVED")
          .map((x) => ({ date: fmtDM(x.voucher_date), label: x.name || "Ứng lương", amount: num(x.total_amount) }));
        const advance = advanceItems.reduce((s, x) => s + x.amount, 0);

        let base = num(c.base_salary);
        // Tiền phòng: ưu tiên hoá đơn phòng nhân viên ở; chưa có HĐ → số cố định
        let roomRent: number;
        let roomRentItems: { date: string; label: string; amount: number }[] = [];
        if (locked) {
          roomRent = num(mRow.room_rent);
          if (roomRent > 0) roomRentItems = [{ date: "", label: "Tiền phòng (đã chốt)", amount: roomRent }];
        } else if (c.room_id && roomInvoice.has(c.room_id)) {
          const inv = roomInvoice.get(c.room_id)!;
          roomRent = inv.amount;
          roomRentItems = [{ date: "", label: inv.label, amount: inv.amount }];
        } else {
          roomRent = num(c.default_room_rent);
          if (roomRent > 0) roomRentItems = [{ date: "", label: c.room_id ? "Cố định (tháng chưa có hoá đơn)" : "Cố định (cấu hình)", amount: roomRent }];
        }
        const stats0 = computeStats(ledger);
        const stats = { ...stats0, streak: computeStreak(ledger) };

        let incomeGoal = num(c.income_goal) || base + investment;
        // CHẾ ĐỘ v5 (chỉ tháng CHƯA chốt): lương cứng→chuyên cần, thưởng→chuỗi, ngày công→ticked.
        // Giữ nguyên đầu tư/HH Sale/ứng/tiền phòng + toàn bộ UI. Tháng đã chốt dùng số đã đóng băng.
        if (engine === "v5" && !locked) {
          const v = v5ByStaff.get(staff);
          if (v) {
            base = v.attend;
            bonusAuto = v.streak > 0
              ? [{ icon: "Flame", label: "Thưởng chuỗi (v5)", note: "mốc chuỗi đã đạt", amount: v.streak }]
              : [];
            stats.workdays = v.ticked;
            stats.streak = v.cur;
            incomeGoal = 9_000_000; // trần v5 = 6tr chuyên cần + 3tr chuỗi
          }
        }

        const m: SalManager = {
          id: staff,
          name: full,
          short,
          alias: c.alias || "",
          role: c.role_title || "Quản lý",
          initials: initialsOf(short),
          tone: idx === 0 ? "primary" : "info",
          workdays: stats.workdays,
          base,
          roomRent,
          incomeGoal,
          bonusAuto,
          adjustments,
          investment,
          investmentBy,
          investmentLocked: !pending,
          commission,
          commissionItems,
          commissionFlagged,
          advance,
          advanceItems,
          roomRentItems,
          roomRentInvoice:
            c.room_id && roomInvoice.has(c.room_id)
              ? (() => {
                  const inv = roomInvoice.get(c.room_id)!;
                  return {
                    invoiceId: inv.invoiceId,
                    roomId: c.room_id,
                    buildingId: inv.buildingId,
                    contractId: inv.contractId,
                    amount: inv.amount,
                    remaining: inv.remaining,
                  };
                })()
              : null,
          paid: locked ? num(mRow.paid) : num(mRow?.paid),
          stats,
          trend: [],
          status: locked ? "LOCKED" : "DRAFT",
          salaryMonthlyId: mRow?.id ?? null,
          ledger,
        };

        // calc: chốt → số đã đóng băng; nháp → tính live
        if (locked) {
          m.calc = {
            autoSum: num(mRow.work_bonus),
            adjSum: num(mRow.adjustments_total),
            bonus: num(mRow.work_bonus) + num(mRow.contract_bonus) + num(mRow.adjustments_total),
            gross: num(mRow.gross_total),
            takehome: num(mRow.take_home),
          };
        } else {
          m.calc = salCalc(m);
        }

        // trend 6 tháng
        const points: SalTrendPoint[] = [];
        for (let k = 5; k >= 0; k--) {
          const pm = shiftMonth(periodMonth, -k);
          const mlab = pm.split("-")[1].replace(/^0/, "");
          if (k === 0) {
            points.push({ label: pm.split("-")[1], gross: m.calc!.gross, takehome: m.calc!.takehome, current: true });
          } else {
            const row = trendByStaffMonth.get(`${staff}|${pm}`);
            if (row && row.status === "LOCKED") {
              points.push({ label: pm.split("-")[1], gross: num(row.gross_total), takehome: num(row.take_home), paidOn: row.locked_at ? fmtDM(row.locked_at.slice(0, 10)) : undefined });
            }
          }
          void mlab;
        }
        m.trend = points;
        return m;
      });

      period.lockedAt = lockedAt ? new Date(lockedAt).toLocaleString("vi-VN") : null;
      return { managers, period, ownerId };
    },
  });
};

// Resolve: user hiện tại có phải quản lý hưởng lương? (gate self-view)
export const useMyManagerConfig = () => {
  return useQuery({
    queryKey: ["my-manager-config"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const user = await getSessionUser();
      if (!user) return null;
      const { data } = await (supabase
        .from("manager_salary_config")
        .select("staff_id") as any)
        .eq("staff_id", user.id)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();
      return data ? { staff_id: (data as any).staff_id } : null;
    },
  });
};

// Tháng mà SELF-VIEW của nhân viên hiển thị: lùi tháng theo chốt lương + override
// admin. Override đọc qua RPC SECURITY DEFINER (staff không đọc được salary_bonus_rules);
// trạng thái chốt đọc từ salary_monthly của chính nhân viên (sm_self_select).
// Trả về period_month 'YYYY-MM-01'.
export const useStaffDisplayMonth = (staffId: string | null | undefined, enabled = true) => {
  return useQuery({
    queryKey: ["salary-staff-month", staffId],
    enabled: !!staffId && enabled,
    queryFn: async () => {
      const cur = vnYmOf(); // giờ VN, không phải giờ máy (audit 2026-07-20)
      let overrides: Record<string, boolean> = {};
      try {
        const { data } = await (supabase.rpc as any)("salary_staff_months");
        if (data && typeof data === "object") overrides = data as Record<string, boolean>;
      } catch {
        /* RPC chưa có / lỗi → dùng mặc định lùi-tháng */
      }
      const { data: rows } = await (supabase
        .from("salary_monthly")
        .select("period_month, status") as any)
        .eq("staff_id", staffId)
        .eq("status", "LOCKED");
      const locked = new Set<string>(
        ((rows || []) as any[]).map((r) => String(r.period_month).slice(0, 7)),
      );
      void locked; // giữ query để admin còn thấy trạng thái chốt; ceiling không phụ thuộc nữa
      const ym = staffCeilingYm(cur, overrides);
      return `${ym}-01`;
    },
  });
};

// --- Mutations ---

async function ensureMonthly(ownerId: string, staffId: string, periodMonth: string): Promise<string> {
  const { data: existing } = await (supabase
    .from("salary_monthly")
    .select("id") as any)
    .eq("staff_id", staffId)
    .eq("period_month", periodMonth)
    .limit(1)
    .maybeSingle();
  if (existing?.id) return (existing as any).id;
  const { data: created, error } = await supabase
    .from("salary_monthly")
    .insert({ user_id: ownerId, staff_id: staffId, period_month: periodMonth, status: "DRAFT" })
    .select("id")
    .single();
  if (error) throw error;
  return (created as any).id;
}

export interface SaveAdjustmentInput {
  ownerId: string;
  staffId: string;
  periodMonth: string;
  id?: string; // sửa
  kind: "BONUS" | "DEDUCTION";
  label: string;
  amount: number; // dương
  note?: string | null;
}

export const useSaveSalaryAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveAdjustmentInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Chưa đăng nhập");
      if (input.id) {
        const { error } = await supabase
          .from("salary_adjustments")
          .update({ kind: input.kind, label: input.label, amount: Math.abs(input.amount), note: input.note ?? null })
          .eq("id", input.id);
        if (error) throw error;
        return;
      }
      const monthlyId = await ensureMonthly(input.ownerId, input.staffId, input.periodMonth);
      const { error } = await supabase.from("salary_adjustments").insert({
        user_id: input.ownerId,
        salary_monthly_id: monthlyId,
        kind: input.kind,
        label: input.label,
        amount: Math.abs(input.amount),
        note: input.note ?? null,
        source: "MANUAL",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã lưu khoản thưởng/trừ");
    },
    onError: (e: any) => toast.error(e?.message || "Không thể lưu"),
  });
};

export const useDeleteSalaryAdjustment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("salary_adjustments").delete() as any).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã xoá");
    },
  });
};

// Bật/tắt cờ "không tính thưởng" cho MỘT việc. Dòng vẫn hiện trong bảng kê
// nhưng thưởng về 0đ (và không kích hoạt phụ cấp CN/Lễ nữa) — xem migration
// 20260720140000_jobs_exclude_from_salary.
export const useToggleJobExcluded = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ jobId, excluded }: { jobId: string; excluded: boolean }) => {
      const { error } = await (supabase.from("jobs") as any)
        .update({ exclude_from_salary: excluded })
        .eq("id", jobId);
      if (error) throw error;
      return excluded;
    },
    onSuccess: (excluded) => {
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success(excluded ? "Đã bỏ việc này khỏi thưởng" : "Đã tính thưởng lại cho việc này");
    },
    onError: (e: any) => toast.error(e?.message || "Không thể cập nhật"),
  });
};

// Chốt tháng: upsert salary_monthly LOCKED (đóng băng số) + snapshot bảng kê.
export const useLockSalaryMonth = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ownerId, periodMonth, managers }: { ownerId: string; periodMonth: string; managers: SalManager[] }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Chưa đăng nhập");
      const nowIso = new Date().toISOString();

      // Canonical lock_salary_month_v1: server ATOMIC + 2 guard (D2b) — chặn khi
      // lợi nhuận tháng chưa chốt (phần đầu tư), và liệt kê phiếu HH thiếu sổ quỹ.
      // Duyệt HH qua writer chuẩn (không raw UPDATE). Flag OFF → fallback legacy.
      const canonicalManagers = managers.map((m) => {
        const c = m.calc || salCalc(m);
        const contractBonus = m.bonusAuto.filter((b) => b.icon === "FileClock").reduce((s, b) => s + b.amount, 0);
        return {
          staff_id: m.id,
          base_salary: m.base,
          work_bonus: c.autoSum - contractBonus,
          contract_bonus: contractBonus,
          commission_total: m.commission,
          investment_profit: m.investment,
          adjustments_total: c.adjSum,
          advances_total: m.advance,
          room_rent: m.roomRent,
          gross_total: c.gross,
          take_home: c.takehome,
          paid: m.paid,
          commission_voucher_ids: (m.commissionItems || [])
            .map((x) => x.voucherId).filter(Boolean),
          ledger: m.ledger,
        };
      });
      const canonical = await (supabase.rpc as any)("lock_salary_month_v1", {
        p_period_month: periodMonth,
        p_managers: canonicalManagers,
        p_idempotency_key: `sal-lock-${periodMonth}-${crypto.randomUUID().slice(0, 8)}`,
      });
      if (!canonical.error) return;
      if (!isCanonicalFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể chốt lương");
        throw canonical.error;
      }

      // Chốt lương → DUYỆT (đã thanh toán) luôn các phiếu hoa hồng CHƯA DUYỆT đang
      // tính vào HH Sale (commissionItems mang voucherId của phiếu nháp).
      const commVoucherIds = Array.from(new Set(
        managers.flatMap((m) => (m.commissionItems || []).map((x) => x.voucherId).filter(Boolean) as string[])
      ));
      if (commVoucherIds.length) {
        const { error: cErr } = await (supabase
          .from("income_expenses")
          .update({ approval_status: "APPROVED", approved_at: nowIso, approved_by: user.id }) as any)
          .in("id", commVoucherIds)
          .neq("approval_status", "APPROVED");
        if (cErr) throw cErr;
      }

      for (const m of managers) {
        const c = m.calc || salCalc(m);
        const contractBonus = m.bonusAuto.filter((b) => b.icon === "FileClock").reduce((s, b) => s + b.amount, 0);
        const workBonus = c.autoSum - contractBonus;
        const { data: row, error } = await supabase
          .from("salary_monthly")
          .upsert(
            {
              user_id: ownerId,
              staff_id: m.id,
              period_month: periodMonth,
              status: "LOCKED",
              base_salary: m.base,
              work_bonus: workBonus,
              contract_bonus: contractBonus,
              commission_total: m.commission,
              investment_profit: m.investment,
              adjustments_total: c.adjSum,
              advances_total: m.advance,
              room_rent: m.roomRent,
              gross_total: c.gross,
              take_home: c.takehome,
              paid: m.paid,
              locked_at: nowIso,
              locked_by: user.id,
            },
            { onConflict: "staff_id,period_month" }
          )
          .select("id")
          .single();
        if (error) throw error;
        const monthlyId = (row as any).id;
        await (supabase.from("salary_work_ledger_snapshot").delete() as any).eq("salary_monthly_id", monthlyId);
        if (m.ledger.length) {
          await supabase.from("salary_work_ledger_snapshot").insert(
            m.ledger.map((r) => ({
              user_id: ownerId,
              salary_monthly_id: monthlyId,
              staff_id: m.id,
              item_type: r.item_type,
              source_id: r.source_id,
              occurred_date: r.occurred_date,
              day_label: r.day_label,
              content: r.content,
              place: r.place,
              job_type_name: r.job_type_name,
              is_repair: r.is_repair,
              is_contract: r.is_contract,
              base_amount: r.base_amount,
              weekend_amount: r.weekend_amount,
              after_amount: r.after_amount,
              cash_amount: r.cash_amount,
              has_photo: r.has_photo,
              bonus_amount: r.bonus_amount,
              reason: r.reason,
            }))
          );
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã chốt lương tháng");
    },
    onError: (e: any) => toast.error(e?.message || "Không thể chốt"),
  });
};

export const useUnlockSalaryMonth = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ periodMonth, staffIds }: { periodMonth: string; staffIds: string[] }) => {
      // Canonical unlock (atomic + giữ organization_id); fallback legacy.
      const canonical = await (supabase.rpc as any)("unlock_salary_month_v1", {
        p_period_month: periodMonth,
        p_staff_ids: staffIds,
        p_idempotency_key: `sal-unlock-${periodMonth}-${crypto.randomUUID().slice(0, 8)}`,
      });
      if (!canonical.error) return;
      if (!isCanonicalFallbackSignal(canonical.error)) throw canonical.error;

      const { data: rows } = await (supabase
        .from("salary_monthly")
        .select("id") as any)
        .eq("period_month", periodMonth)
        .in("staff_id", staffIds);
      const ids = ((rows || []) as any[]).map((r) => r.id);
      if (ids.length) {
        await (supabase.from("salary_work_ledger_snapshot").delete() as any).in("salary_monthly_id", ids);
        await (supabase.from("salary_monthly").update({ status: "DRAFT", locked_at: null, locked_by: null }) as any).in("id", ids);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã mở khoá tháng");
    },
  });
};

export interface SalaryPayoutInput {
  ownerId: string;
  staffId: string;
  staffName: string;
  periodMonth: string;
  amount: number;
  account_id: string;
  voucher_date: string;
  note?: string | null;
  // Hoá đơn tiền phòng để gạch nợ (cấn trừ vào lương) khi trả lương. Nếu có &
  // còn nợ: phiếu chi lương TÁCH 2 dòng (thực nhận + tiền phòng) + tự tạo phiếu
  // thu gạch nợ (payment CT) vào CÙNG sổ quỹ → hoá đơn phòng thành ĐÃ THU, và sổ
  // quỹ net = đúng tiền thực nhận (chi gross − thu tiền phòng).
  rentInvoice?: {
    invoiceId: string;
    roomId: string | null;
    buildingId: string | null;
    contractId: string | null;
    amount: number; // tiền phòng khấu trừ (total_amount hoá đơn)
  } | null;
}

export const useSalaryPayout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SalaryPayoutInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Chưa đăng nhập");
      const meta = (user.user_metadata ?? {}) as Record<string, any>;
      const creatorName: string = meta.full_name || meta.name || user.email || "Người dùng";

      // Canonical salary_payout_v1 (t5_12): ATOMIC toàn chuỗi — phiếu chi (tách
      // 2 dòng khi gạch nợ) + payment CT + phiếu thu đối ứng + stamp payout_voucher,
      // đi qua ENGINE DUYỆT (state PENDING_APPROVAL — người duyệt ký mới thành chi
      // thật; trigger a70 tự gạch paid khi duyệt). Server tự clamp tiền phòng theo
      // nợ còn lại. Flag OFF → "chưa bật" → fallback legacy cascade bên dưới.
      const canonical = await (supabase.rpc as any)("salary_payout_v1", {
        p_staff_id: input.staffId,
        p_period_month: input.periodMonth,
        p_take_home: input.amount,
        p_account_id: input.account_id,
        p_voucher_date: input.voucher_date,
        p_note: input.note ?? null,
        p_idempotency_key: `sal-pay-${input.staffId.slice(0, 8)}-${input.periodMonth}-${crypto.randomUUID().slice(0, 8)}`,
        p_rent_invoice_id: input.rentInvoice?.invoiceId ?? null,
        p_rent_amount: input.rentInvoice ? num(input.rentInvoice.amount) : null,
      });
      if (!canonical.error) return canonical.data;
      if (!isCanonicalFallbackSignal(canonical.error)) {
        toast.error(canonical.error.message || "Không thể chi lương");
        throw canonical.error;
      }

      // --- Tiền phòng gạch nợ: đọc lại hoá đơn (remaining tươi) để chốt số thu ---
      let rentCollect = 0;
      let rentInv: any = null;
      if (input.rentInvoice?.invoiceId) {
        const { data: invFresh } = await (supabase
          .from("invoices")
          .select(
            "id, user_id, invoice_number, building_id, room_id, contract_id, total_amount, remaining_amount, room:rooms!invoices_room_id_fkey(name), building:buildings!invoices_building_id_fkey(name)",
          )
          .eq("id", input.rentInvoice.invoiceId)
          .is("deleted_at", null)
          .single() as any);
        if (invFresh) {
          const remaining =
            Number((invFresh as any).remaining_amount ??
              (invFresh as any).total_amount) || 0;
          rentCollect = Math.min(num(input.rentInvoice.amount), remaining);
          if (rentCollect > 0) rentInv = invFresh;
          else rentCollect = 0;
        }
      }

      // toà chung hệ thống (toà ảo — hiện là "Kho Văn Phòng Chung")
      const { data: chung } = await (supabase
        .from("buildings").select("id") as any)
        .eq("is_virtual", true).is("deleted_at", null)
        .order("created_at", { ascending: true }).limit(1).maybeSingle();

      // hạng mục "Lương quản lý"
      let typeId: string;
      const { data: t } = await (supabase
        .from("income_expense_types").select("id") as any)
        .eq("user_id", input.ownerId).eq("type", "expense").eq("name", "Lương quản lý").limit(1).maybeSingle();
      if (t?.id) typeId = (t as any).id;
      else {
        const { data: created, error } = await supabase
          .from("income_expense_types")
          .insert({ user_id: input.ownerId, name: "Lương quản lý", type: "expense", category: "Lương", is_default: false, is_deposit: false })
          .select("id").single();
        if (error) throw error;
        typeId = (created as any).id;
      }

      const name = input.note?.trim() || `Lương: ${input.staffName}`;
      const { data: voucher, error: vErr } = await supabase
        .from("income_expenses")
        .insert({
          user_id: user.id,
          creator_name: creatorName,
          type: "EXPENSE",
          name,
          building_id: chung ? (chung as any).id : null,
          account_id: input.account_id,
          salary_staff_id: input.staffId,
          business_result_accounting: false,
          attachments: [],
          repeat_cycle: "NONE",
          repeat_infinity: false,
          repeat_count: 0,
          repeat_remaining: 0,
          voucher_date: input.voucher_date,
        })
        .select("id").single();
      if (vErr) throw vErr;

      // Phiếu chi lương: nếu gạch nợ tiền phòng → TÁCH 2 dòng (thực nhận + tiền
      // phòng) ⇒ tổng phiếu chi = gross (thực nhận + tiền phòng). Ngược lại 1 dòng.
      const salItems: any[] = [
        {
          income_expense_id: (voucher as any).id,
          income_expense_type_id: typeId,
          description: rentCollect > 0 ? `Tiền thực nhận — ${name}` : (input.note ?? null),
          quantity: 1,
          unit_price: input.amount,
          start_date: input.voucher_date,
          end_date: input.voucher_date,
        },
      ];
      if (rentCollect > 0) {
        salItems.push({
          income_expense_id: (voucher as any).id,
          income_expense_type_id: typeId,
          description: `Tiền phòng (khấu trừ) · HĐ ${rentInv.invoice_number ?? ""}`.trim(),
          quantity: 1,
          unit_price: rentCollect,
          start_date: input.voucher_date,
          end_date: input.voucher_date,
        });
      }
      const { error: itErr } = await supabase.from("income_expense_items").insert(salItems);
      if (itErr) throw itErr;

      // --- Phiếu THU gạch nợ tiền phòng (cấn trừ vào lương) vào CÙNG sổ quỹ ---
      // Mirror useBulkRecordPayment: 1 payment (method CT) đánh dấu hoá đơn ĐÃ THU
      // (trigger recompute) + 1 phiếu thu INCOME vào sổ quỹ. user_id = chủ hoá đơn
      // để khớp RLS (giống thu tiền thường).
      if (rentCollect > 0 && rentInv) {
        const invOwner = (rentInv as any).user_id as string;

        // loại thu doanh thu (không phải cọc)
        const { data: incTypes } = await (supabase
          .from("income_expense_types")
          .select("id, is_default, name, is_deposit") as any)
          .eq("type", "income").limit(100);
        const revenueTypes = ((incTypes || []) as any[]).filter((x) => !x.is_deposit);
        const normT = (s?: string) => (s ?? "").trim().toLowerCase();
        const incomeTypeId =
          revenueTypes.find((x) => x.is_default)?.id ||
          revenueTypes.find((x) => normT(x.name) === "thu tiền hoá đơn" || normT(x.name) === "thu tiền hóa đơn")?.id ||
          [...revenueTypes].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))[0]?.id;
        if (!incomeTypeId) throw new Error('Chưa có loại thu (không phải cọc) trong "Loại thu/chi".');

        const roomNm = (rentInv as any).room?.name ?? "";
        const bldNm = (rentInv as any).building?.name ?? "";

        const { data: payRow, error: payErr } = await supabase
          .from("payments")
          .insert({
            user_id: invOwner,
            invoice_id: (rentInv as any).id,
            amount: rentCollect,
            payment_method: "CT",
            payment_date: input.voucher_date,
            notes: `Khấu trừ vào lương ${input.staffName}`,
          } as any)
          .select("id").single();
        if (payErr) throw payErr;

        const { data: rentVoucher, error: rvErr } = await supabase
          .from("income_expenses")
          .insert({
            user_id: invOwner,
            type: "INCOME",
            name: `Thu tiền phòng HĐ ${roomNm}${bldNm ? "/" + bldNm : ""} (khấu trừ lương ${input.staffName})`,
            building_id: (rentInv as any).building_id,
            room_id: (rentInv as any).room_id,
            contract_id: (rentInv as any).contract_id,
            account_id: input.account_id,
            invoice_id: (rentInv as any).id,
            payment_id: (payRow as any).id,
            voucher_date: input.voucher_date,
            payer_name: `${input.staffName} (khấu trừ lương)`,
            notes: `Cấn trừ tiền phòng vào lương ${input.staffName}`,
            approval_status: "APPROVED",
            creator_name: creatorName,
          } as any)
          .select("id").single();
        if (rvErr) throw rvErr;

        const { error: rItErr } = await supabase.from("income_expense_items").insert({
          income_expense_id: (rentVoucher as any).id,
          income_expense_type_id: incomeTypeId,
          description: `Thu tiền phòng HĐ ${roomNm}`.trim(),
          quantity: 1,
          unit_price: rentCollect,
          start_date: input.voucher_date,
          end_date: input.voucher_date,
        });
        if (rItErr) throw rItErr;
      }

      // ghi nhận đã trả vào salary_monthly (paid = tiền thực nhận, KHÔNG gồm tiền phòng)
      const monthlyId = await ensureMonthly(input.ownerId, input.staffId, input.periodMonth);
      const { data: cur } = await (supabase.from("salary_monthly").select("paid").eq("id", monthlyId) as any).single();
      const newPaid = (Number((cur as any)?.paid) || 0) + input.amount;
      await (supabase.from("salary_monthly").update({ paid: newPaid, payout_voucher_id: (voucher as any).id }) as any).eq("id", monthlyId);
      return voucher;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      qc.invalidateQueries({ queryKey: ["income-expenses"] });
      qc.invalidateQueries({ queryKey: ["accounts-with-balance"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoice-statistics"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      toast.success("Đã ghi phiếu chi lương");
    },
    onError: (e: any) => toast.error(e?.message || "Không thể ghi phiếu"),
  });
};
