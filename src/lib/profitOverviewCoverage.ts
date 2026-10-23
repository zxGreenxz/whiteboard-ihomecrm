// =============================================================================
// profitOverviewCoverage.ts — phần ĐỐI CHIẾU của tab Tổng quan (Báo cáo Lợi Nhuận),
// đợt rà 21/10 (F18/F20/F21). Hàm thuần: trang truyền dữ liệu đã tải, nhận về số.
//
// 1. PHỦ CHỐT Tháng × Toà (F20): mỗi ô là ĐÃ CHỐT / CHỐT NHƯNG NGUỒN ĐÃ ĐỔI /
//    CHƯA CHỐT / KHÔNG PHÁT SINH, cộng "LN chưa chốt (ước tính, trước chia)".
// 2. BĂNG ĐỐI CHIẾU (F18): "Đã chốt N toà·tháng: LN chốt X · LN hiện tại Y · lệch Z"
//    và dòng "Chi phí chung ở toà ảo — không vào chia LN".
// 3. PHÂN RÃ LN ĐÃ CHỐT (F21): lương điều hành · phần cổ đông · giữ lại công ty theo
//    cách xử lý (disposition) · chuyển kỳ sau · chưa chọn.
// 4. PHẦN CỦA QUẢN LÝ ĐÃ XOÁ (F21): allocation còn mà quản lý đã xoá — CHỈ HIỆN,
//    không quyết đã trả hay huỷ (việc của chủ).
//
// CƠ SỞ của mọi số "hiện tại" = fa_monthly_pnl_accrual — cũng là nguồn mà
// profit_close_preview_v2 dùng để tính computed_profit lúc chốt: DỒN TÍCH theo kỳ
// phân bổ, CHỈ phiếu ĐÃ DUYỆT, CHỈ KQKD, TRƯỚC lương điều hành và trước chia cổ đông,
// toà vận hành cho chủ nhà tính CẢ toà (chưa trừ phần chủ nhà). "LN chốt" đem so là
// computed_profit (LN nguồn lúc chốt, CHƯA gồm điều chỉnh tay) để hai vế cùng cơ sở;
// điều chỉnh tay báo riêng. Toà ảo không vào ô nào — chỉ vào dòng chi phí chung.
//
// File không chứa số liệu thật nào.
// =============================================================================

/** Chênh từ 1 đồng trở lên mới coi là "nguồn đã đổi" (số numeric có phần lẻ khi phân bổ). */
export const COVERAGE_TOLERANCE = 1;

/** Một dòng profit_monthly (useProfitMonthly) — chỉ các trường bộ đối chiếu đọc. */
export interface CoverageSnapshotRow {
  building_id: string;
  /** 'YYYY-MM-01' */
  period_month: string;
  status: 'DRAFT' | 'LOCKED';
  computed_profit: number;
  adjusted_profit: number;
  /** Cột profit_monthly.is_stale — reader trải nguyên dòng nên có lúc chạy dù kiểu không khai. */
  is_stale?: unknown;
}

/** Một dòng fa_monthly_pnl_accrual (useFaMonthlyPnl(..., accrual = true)). */
export interface CoverageAccrualRow {
  /** 'YYYY-MM-DD' — ngày đầu tháng. */
  month: string;
  building_id: string;
  building_name: string;
  is_virtual: boolean;
  revenue?: number;
  expense?: number;
  net: number;
}

export interface CoverageBuilding {
  id: string;
  name: string;
}

export type CoverageStatus = 'LOCKED' | 'LOCKED_CHANGED' | 'OPEN' | 'EMPTY';

export interface CoverageCell {
  month: number;
  buildingId: string;
  status: CoverageStatus;
  /** LN nguồn lúc chốt (computed_profit) — chỉ ô đã chốt. */
  lockedSource: number | null;
  /** LN chốt gồm điều chỉnh tay (adjusted_profit) — chỉ ô đã chốt. */
  lockedAdjusted: number | null;
  /** LN hiện tại cùng cơ sở; 0 khi toà không phát sinh trong tháng. */
  currentNet: number;
  /** currentNet − lockedSource — chỉ ô đã chốt. */
  delta: number | null;
  /** Ô đã chốt mà cột is_stale đang bật (máy chủ đánh dấu). */
  staleFlag: boolean;
}

export interface CoverageMonthSummary {
  month: number;
  /** Toà·tháng đã chốt, GỒM cả ô nguồn đã đổi. */
  locked: number;
  changed: number;
  open: number;
  empty: number;
  /** Σ LN hiện tại của ô chưa chốt. */
  openNet: number;
  /** Σ LN hiện tại của toà ảo trong tháng (chi phí chung). */
  virtualNet: number;
  /** Tháng có dòng toà ảo trả về. */
  hasVirtual: boolean;
}

export interface ProfitCoverage {
  months: number[];
  buildings: CoverageBuilding[];
  /** Khoá coverageCellKey(month, buildingId). */
  cells: Record<string, CoverageCell>;
  byMonth: CoverageMonthSummary[];
  /** Toà·tháng đã chốt (gồm nguồn đã đổi). */
  lockedCount: number;
  changedCount: number;
  openCount: number;
  /** Số toà khác nhau có ≥1 tháng đã chốt trong phạm vi. */
  lockedBuildingCount: number;
  /** Σ computed_profit của ô đã chốt. */
  lockedSource: number;
  /** Σ adjusted_profit của ô đã chốt. */
  lockedAdjusted: number;
  /** Σ LN hiện tại của ô đã chốt. */
  lockedCurrent: number;
  /** lockedCurrent − lockedSource. */
  lockedDelta: number;
  /** lockedAdjusted − lockedSource (điều chỉnh tay lúc chốt). */
  adjustmentTotal: number;
  /** Σ LN hiện tại của ô chưa chốt. */
  openNet: number;
  /** Σ LN hiện tại của toà ảo (chi phí chung, không vào chia LN). */
  virtualNet: number;
  hasVirtual: boolean;
}

export const coverageCellKey = (month: number, buildingId: string): string => `${month}|${buildingId}`;

/** Tên cột cho toà có dòng chốt nhưng không còn trong danh sách toà (đã xoá). */
export const DELETED_BUILDING_NAME = 'Toà đã xoá';

const ISO_YM = /^(\d{4})-(\d{2})/;

/** 'YYYY-MM-..' → { year, month } (null nếu sai dạng). */
export const yearMonthOf = (iso: string | null | undefined): { year: number; month: number } | null => {
  const m = ISO_YM.exec(iso ?? '');
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), month };
};

/**
 * Các tháng được xét của năm `year`: năm hiện tại chỉ tới tháng hiện tại (tháng tương lai
 * chưa có gì để chốt), năm sau hiện tại ⇒ rỗng. Lọc một tháng ngoài khoảng đó ⇒ rỗng.
 */
export const coverageMonths = (
  year: number,
  monthFilter: number | null,
  today: { year: number; month: number },
): number[] => {
  if (year > today.year) return [];
  const last = year === today.year ? today.month : 12;
  if (monthFilter != null) return monthFilter >= 1 && monthFilter <= last ? [monthFilter] : [];
  return Array.from({ length: last }, (_, i) => i + 1);
};

const compareVi = (a: string, b: string): number => a.localeCompare(b, 'vi', { sensitivity: 'base' });

export const buildProfitCoverage = (input: {
  year: number;
  months: readonly number[];
  /** Toà THẬT của công ty đang xem (không gồm toà ảo). */
  buildings: readonly CoverageBuilding[];
  /** profit_monthly đã lọc theo công ty. */
  snapshots: readonly CoverageSnapshotRow[];
  accrual: readonly CoverageAccrualRow[];
  tolerance?: number;
}): ProfitCoverage => {
  const tol = input.tolerance ?? COVERAGE_TOLERANCE;
  const months = [...new Set(input.months)].filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
  const monthSet = new Set(months);
  const inScope = (iso: string): number | null => {
    const ym = yearMonthOf(iso);
    return ym && ym.year === input.year && monthSet.has(ym.month) ? ym.month : null;
  };

  const names = new Map<string, string>();
  for (const b of input.buildings) names.set(b.id, b.name);

  // LN hiện tại theo ô (toà thật) + chi phí chung toà ảo theo tháng.
  const net = new Map<string, { net: number; active: boolean }>();
  const virtualByMonth = new Map<number, number>();
  for (const r of input.accrual) {
    const m = inScope(r.month);
    if (m == null) continue;
    if (r.is_virtual) {
      virtualByMonth.set(m, (virtualByMonth.get(m) ?? 0) + r.net);
      continue;
    }
    if (!names.has(r.building_id)) names.set(r.building_id, r.building_name || DELETED_BUILDING_NAME);
    const key = coverageCellKey(m, r.building_id);
    const cur = net.get(key) ?? { net: 0, active: false };
    cur.net += r.net;
    cur.active = cur.active || r.net !== 0 || (r.revenue ?? 0) !== 0 || (r.expense ?? 0) !== 0;
    net.set(key, cur);
  }

  // Dòng chốt theo ô; trùng (không nên có — UNIQUE building × kỳ) thì ưu tiên LOCKED.
  const snaps = new Map<string, CoverageSnapshotRow>();
  for (const s of input.snapshots) {
    const m = inScope(s.period_month);
    if (m == null) continue;
    const key = coverageCellKey(m, s.building_id);
    const prev = snaps.get(key);
    if (!prev || (prev.status !== 'LOCKED' && s.status === 'LOCKED')) snaps.set(key, s);
    if (s.status === 'LOCKED' && !names.has(s.building_id)) names.set(s.building_id, DELETED_BUILDING_NAME);
  }

  const buildings = [...names.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => compareVi(a.name, b.name) || compareVi(a.id, b.id));

  const cells: Record<string, CoverageCell> = {};
  const byMonth: CoverageMonthSummary[] = [];
  const lockedBuildings = new Set<string>();
  let lockedSource = 0;
  let lockedAdjusted = 0;
  let lockedCurrent = 0;
  let openNet = 0;
  let lockedCount = 0;
  let changedCount = 0;
  let openCount = 0;

  for (const m of months) {
    const sum: CoverageMonthSummary = {
      month: m,
      locked: 0,
      changed: 0,
      open: 0,
      empty: 0,
      openNet: 0,
      virtualNet: virtualByMonth.get(m) ?? 0,
      hasVirtual: virtualByMonth.has(m),
    };
    for (const b of buildings) {
      const key = coverageCellKey(m, b.id);
      const cur = net.get(key);
      const currentNet = cur?.net ?? 0;
      const snap = snaps.get(key);
      let cell: CoverageCell;
      if (snap?.status === 'LOCKED') {
        const delta = currentNet - snap.computed_profit;
        const staleFlag = snap.is_stale === true;
        const changed = staleFlag || Math.abs(delta) >= tol;
        cell = {
          month: m,
          buildingId: b.id,
          status: changed ? 'LOCKED_CHANGED' : 'LOCKED',
          lockedSource: snap.computed_profit,
          lockedAdjusted: snap.adjusted_profit,
          currentNet,
          delta,
          staleFlag,
        };
        sum.locked++;
        lockedCount++;
        if (changed) {
          sum.changed++;
          changedCount++;
        }
        lockedBuildings.add(b.id);
        lockedSource += snap.computed_profit;
        lockedAdjusted += snap.adjusted_profit;
        lockedCurrent += currentNet;
      } else {
        const open = !!cur?.active || !!snap;
        cell = {
          month: m,
          buildingId: b.id,
          status: open ? 'OPEN' : 'EMPTY',
          lockedSource: null,
          lockedAdjusted: null,
          currentNet,
          delta: null,
          staleFlag: false,
        };
        if (open) {
          sum.open++;
          sum.openNet += currentNet;
          openCount++;
          openNet += currentNet;
        } else sum.empty++;
      }
      cells[key] = cell;
    }
    byMonth.push(sum);
  }

  const virtualNet = byMonth.reduce((s, x) => s + x.virtualNet, 0);
  return {
    months,
    buildings,
    cells,
    byMonth,
    lockedCount,
    changedCount,
    openCount,
    lockedBuildingCount: lockedBuildings.size,
    lockedSource,
    lockedAdjusted,
    lockedCurrent,
    lockedDelta: lockedCurrent - lockedSource,
    adjustmentTotal: lockedAdjusted - lockedSource,
    openNet,
    virtualNet,
    hasVirtual: byMonth.some((x) => x.hasVirtual),
  };
};

/**
 * Tách LN chưa chốt thành phần của các THÁNG ĐÃ HẾT và phần của tháng đang chạy (chưa hết
 * tháng, số còn thiếu ngày) — tiêu đề chỉ nên cộng tháng đã hết.
 */
export const splitOpenNetByMonthEnd = (
  coverage: Pick<ProfitCoverage, 'byMonth'>,
  year: number,
  today: { year: number; month: number },
): { ended: number; endedOpen: number; running: number; runningMonth: number | null } => {
  let ended = 0;
  let endedOpen = 0;
  let running = 0;
  let runningMonth: number | null = null;
  for (const m of coverage.byMonth) {
    if (year === today.year && m.month === today.month) {
      running += m.openNet;
      runningMonth = m.month;
    } else {
      ended += m.openNet;
      endedOpen += m.open;
    }
  }
  return { ended, endedOpen, running, runningMonth };
};

// ───────────────────────────── chữ hiển thị (desktop + mobile) ─────────────────────────────

export const COVERAGE_BASIS_NOTE =
  'Cơ sở: dồn tích theo kỳ phân bổ · chỉ phiếu đã duyệt · chỉ KQKD · trước lương điều hành và trước chia · bỏ toà ảo · công ty đang chọn. Cùng nguồn với màn Chốt LN.';

export const COVERAGE_OPEN_NOTE =
  'Ước tính trước chia: chưa trừ lương điều hành, chưa trừ phần chủ nhà của toà vận hành, chưa gồm phiếu chờ duyệt, chưa dò thiếu chi cố định.';

/** Số có dấu: +1.000 / −1.000 / 0 (dấu trừ thật, không gạch nối). */
export const signedAmount = (n: number, fmt: (v: number) => string): string =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;

export const coverageCellTitle = (cell: CoverageCell, buildingName: string, fmt: (v: number) => string): string => {
  const head = `${buildingName} · T${cell.month}`;
  if (cell.status === 'LOCKED') return `${head}: đã chốt · LN chốt ${fmt(cell.lockedSource ?? 0)}`;
  if (cell.status === 'LOCKED_CHANGED') {
    return (
      `${head}: đã chốt nhưng nguồn đã đổi · LN chốt ${fmt(cell.lockedSource ?? 0)} → hiện tại ` +
      `${fmt(cell.currentNet)} (lệch ${signedAmount(cell.delta ?? 0, fmt)})` +
      (cell.staleFlag ? ' · máy chủ đánh dấu cũ' : '')
    );
  }
  if (cell.status === 'OPEN') return `${head}: chưa chốt · LN hiện tại ≈ ${fmt(cell.currentNet)}`;
  return `${head}: không phát sinh`;
};

/** Các dòng đối chiếu (F18 băng LN chốt ↔ hiện tại, F20 LN chưa chốt, F18 toà ảo). */
export const coverageSummaryLines = (
  c: ProfitCoverage,
  ctx: { year: number; today: { year: number; month: number }; singleMonth: boolean },
  fmt: (v: number) => string,
): { reconcile: string; reconcileSub: string; open: string; virtual: string | null } => {
  const reconcile =
    c.lockedCount > 0
      ? `Đã chốt ${
          ctx.singleMonth ? `${c.lockedCount}/${c.buildings.length} toà` : `${c.lockedCount} toà·tháng (${c.lockedBuildingCount} toà)`
        }: LN chốt ${fmt(c.lockedSource)} · LN hiện tại ${fmt(c.lockedCurrent)} · lệch ${signedAmount(c.lockedDelta, fmt)}`
      : 'Chưa có toà nào đã chốt trong phạm vi đang xem.';
  const subParts: string[] = [];
  if (c.lockedCount > 0) subParts.push('LN chốt = LN nguồn lúc chốt, chưa gồm điều chỉnh tay');
  if (c.adjustmentTotal !== 0) subParts.push(`điều chỉnh tay khi chốt ${signedAmount(c.adjustmentTotal, fmt)}`);
  if (c.changedCount > 0) subParts.push(`${c.changedCount} toà·tháng nguồn đã đổi sau khi chốt`);
  const split = splitOpenNetByMonthEnd(c, ctx.year, ctx.today);
  const open =
    `LN chưa chốt (ước tính, trước chia): ${fmt(split.ended)} · ${split.endedOpen} toà·tháng` +
    (split.runningMonth != null && split.running !== 0
      ? ` · T${split.runningMonth} đang chạy ≈ ${fmt(split.running)} (chưa hết tháng, không cộng)`
      : '');
  const virtual = c.hasVirtual
    ? `Chi phí chung ở toà ảo — không vào chia LN: ${signedAmount(c.virtualNet, fmt)} (LN ròng toà ảo, cùng cơ sở)`
    : null;
  return { reconcile, reconcileSub: subParts.join(' · '), open, virtual };
};

// ───────────────────────────── phân rã LN đã chốt (F21) ─────────────────────────────

/** Một dòng profit_monthly — các trường phân rã đọc. */
export interface LockedSplitRow {
  status: 'DRAFT' | 'LOCKED';
  adjusted_profit: number;
  management_salary: number;
  shareholder_allocated_amount?: number;
  unallocated_profit?: number;
  unallocated_disposition?: string | null;
}

export interface LockedProfitSplit {
  lockedCount: number;
  /** Σ adjusted_profit (LN đã chốt, gồm điều chỉnh tay). */
  adjusted: number;
  managementSalary: number;
  /** Phần cổ đông theo snapshot lúc chốt (gồm cả cổ đông đã xoá sau đó). */
  shareholderAllocated: number;
  /** unallocated, disposition RETAINED_EARNINGS. */
  retained: number;
  /** unallocated, disposition LEGACY_RETAINED_UNALLOCATED (chốt trước V3). */
  legacyRetained: number;
  /** unallocated, disposition CARRY_FORWARD. */
  carryForward: number;
  /** unallocated chưa có disposition hợp lệ. */
  undecided: number;
  /** adjusted − (lương + cổ đông + mọi phần chưa phân bổ): phải ≈ 0; khác 0 ⇒ snapshot lệch. */
  unexplained: number;
}

export const splitLockedProfit = (rows: readonly LockedSplitRow[]): LockedProfitSplit => {
  const out: LockedProfitSplit = {
    lockedCount: 0,
    adjusted: 0,
    managementSalary: 0,
    shareholderAllocated: 0,
    retained: 0,
    legacyRetained: 0,
    carryForward: 0,
    undecided: 0,
    unexplained: 0,
  };
  for (const r of rows) {
    if (r.status !== 'LOCKED') continue;
    out.lockedCount++;
    out.adjusted += r.adjusted_profit;
    out.managementSalary += r.management_salary;
    out.shareholderAllocated += r.shareholder_allocated_amount ?? 0;
    const u = r.unallocated_profit ?? 0;
    if (u === 0) continue;
    if (r.unallocated_disposition === 'RETAINED_EARNINGS') out.retained += u;
    else if (r.unallocated_disposition === 'LEGACY_RETAINED_UNALLOCATED') out.legacyRetained += u;
    else if (r.unallocated_disposition === 'CARRY_FORWARD') out.carryForward += u;
    else out.undecided += u;
  }
  out.unexplained =
    out.adjusted -
    (out.managementSalary + out.shareholderAllocated + out.retained + out.legacyRetained + out.carryForward + out.undecided);
  return out;
};

/** Diễn giải LN đã chốt thành các phần (tooltip KPI). Cơ sở: snapshot profit_monthly LOCKED, luỹ kế. */
export const lockedSplitTitle = (s: LockedProfitSplit, fmt: (v: number) => string): string =>
  `LN đã chốt ${fmt(s.adjusted)} = lương điều hành ${fmt(s.managementSalary)}` +
  ` + phần cổ đông lúc chốt ${fmt(s.shareholderAllocated)}` +
  ` + giữ lại công ty ${fmt(s.retained + s.legacyRetained)}` +
  ` + chuyển kỳ sau ${fmt(s.carryForward)}` +
  (s.undecided !== 0 ? ` + chưa chọn cách xử lý ${fmt(s.undecided)}` : '') +
  (Math.abs(s.unexplained) >= COVERAGE_TOLERANCE ? ` · còn lệch ${signedAmount(s.unexplained, fmt)} chưa giải thích` : '');

/** Dòng phụ của KPI "Giữ lại công ty". */
export const retainedKpiSub = (s: LockedProfitSplit, fmt: (v: number) => string): string => {
  const parts: string[] = [];
  if (s.legacyRetained !== 0) parts.push(`gồm ${fmt(s.legacyRetained)} chốt kiểu cũ`);
  if (s.carryForward !== 0) parts.push(`chuyển kỳ sau ${fmt(s.carryForward)}`);
  if (s.undecided !== 0) parts.push(`chưa chọn ${fmt(s.undecided)}`);
  return parts.length > 0 ? parts.join(' · ') : 'phần LN đã chốt không chia cổ đông';
};

/** F21: chia LN qua app đang tắt (route distribute SHADOW) — chỉ ghi chú, KHÔNG đổi cờ. */
export const PROFIT_PAYOUT_OFF_NOTE = 'Chi LN qua app đang tắt — chi ngoài app thì ghi phiếu như hiện nay';

export const RETIRED_MANAGER_NOTE =
  'Quản lý đã xoá — app không chi được phần này. Đã trả ngoài app hay huỷ là việc chủ quyết; màn chỉ hiện số.';

// ───────────────────────────── quản lý đã xoá (F21) ─────────────────────────────

export interface RetiredManagerBalance {
  managerId: string;
  /** Σ lương điều hành đã phân bổ lúc chốt. */
  accrued: number;
  /** Σ phiếu chi lương điều hành đã duyệt. */
  paid: number;
  remaining: number;
}

/**
 * Quản lý KHÔNG còn trong danh sách đang hoạt động mà vẫn có phân bổ/phiếu chi lương điều hành.
 * Chỉ để HIỆN (nhãn "đã nghỉ") — app không chi được cho quản lý đã xoá; đã trả ngoài app hay
 * huỷ là việc chủ quyết.
 */
export const retiredManagerBalances = (
  activeManagerIds: ReadonlySet<string>,
  allocations: readonly { manager_id: string; amount: number }[],
  payouts: readonly { manager_id: string; total_amount: number }[],
): RetiredManagerBalance[] => {
  const by = new Map<string, RetiredManagerBalance>();
  const get = (id: string): RetiredManagerBalance => {
    const cur = by.get(id) ?? { managerId: id, accrued: 0, paid: 0, remaining: 0 };
    by.set(id, cur);
    return cur;
  };
  for (const a of allocations) if (!activeManagerIds.has(a.manager_id)) get(a.manager_id).accrued += a.amount;
  for (const p of payouts) if (!activeManagerIds.has(p.manager_id)) get(p.manager_id).paid += p.total_amount;
  return [...by.values()]
    .map((r) => ({ ...r, remaining: r.accrued - r.paid }))
    .filter((r) => r.accrued !== 0 || r.paid !== 0)
    .sort((a, b) => b.remaining - a.remaining || a.managerId.localeCompare(b.managerId));
};
