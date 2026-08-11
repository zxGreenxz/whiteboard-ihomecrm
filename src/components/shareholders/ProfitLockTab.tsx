import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  CalendarClock,
  Lock,
  LockOpen,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProfitHubSlot } from "@/pages/reports/finance/ProfitHubShell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  useCloseProfitPeriod,
  useProfitClosePreview,
  useProfitCloseState,
  useResetProfitPeriod,
  useUnlockProfitMonth,
  type ProfitCloseOrganizationScope,
  type ProfitClosePreviewRow,
} from "@/hooks/useShareholderProfit";
import {
  buildProfitCloseAdjustments,
  hasUnallocatedProfitResidual,
  mergeProfitCloseDrafts,
  normalizeUnallocatedDisposition,
  resolveProfitCloseOrganizationId,
  validateProfitCloseDrafts,
  type ProfitCloseDraftMap,
  type ProfitUnallocatedDisposition,
} from "@/lib/profitClose";
import { useCashbookMonthlyClosingStatus } from "@/hooks/useCashbookClosing";
import { formatCurrency } from "@/lib/utils";
import { currentYear, periodOf, periodToLabel } from "./shareholderUtils";

interface ProfitLockTabProps {
  organizations: ProfitCloseOrganizationScope[];
}

interface FormState {
  scopeKey: string;
  drafts: ProfitCloseDraftMap;
  dirty: Record<string, true>;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function SignedAdjustmentInput({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(String(value));
  }, [focused, value]);

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.target.value;
        if (!/^-?\d*(?:[.,]\d{0,2})?$/.test(next)) return;
        setText(next);
        if (next === "" || next === "-") return;
        const parsed = Number(next.replace(",", "."));
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      onBlur={() => {
        setFocused(false);
        const parsed = Number(text.replace(",", "."));
        const normalized = Number.isFinite(parsed) ? parsed : 0;
        setText(String(normalized));
        onChange(normalized);
      }}
      className="text-right font-mono"
      aria-label={label}
    />
  );
}

function shortHash(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : "—";
}

function dispositionLabel(
  disposition: ProfitUnallocatedDisposition | null | undefined,
): string {
  if (disposition === "RETAINED_EARNINGS") return "Giữ lại lợi nhuận";
  if (disposition === "CARRY_FORWARD") return "Chuyển kỳ sau";
  return "Chưa chọn";
}

export default function ProfitLockTab({ organizations }: ProfitLockTabProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const period = periodOf(year, month);
  const [organizationId, setOrganizationId] = useState("");
  const scopeKey = `${organizationId}:${period}`;
  const [form, setForm] = useState<FormState>({ scopeKey: "", drafts: {}, dirty: {} });
  const [recloseMode, setRecloseMode] = useState(false);
  const [overallReason, setOverallReason] = useState("");
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [overallReasonError, setOverallReasonError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetGuard, setResetGuard] = useState<{
    organizationId: string;
    period: string;
    stateHash: string;
    snapshotIds: string[];
  } | null>(null);
  const [resetReason, setResetReason] = useState("");
  const resetReasonLength = resetReason.trim().length;
  const resetReasonValid = resetReasonLength >= 8 && resetReasonLength <= 1000;
  const selectedOrganization = organizations.find(
    (organization) => organization.organization_id === organizationId,
  );
  const canLock = selectedOrganization?.can_lock ?? false;
  const canUnlock = selectedOrganization?.can_unlock ?? false;

  // ── PA4: hai lưới an toàn trước khi chốt lợi nhuận ──────────────────
  //
  // (1) Sổ quỹ chưa chốt. Chốt LN mà sổ quỹ chưa ai đếm thì con số lợi nhuận
  //     chưa có ai đứng ra bảo đảm — và sau khi chia cho cổ đông thì phiếu của
  //     tháng đó bị TRIGGER khoá, muốn sửa phải mở khoá (xoá phân bổ, chốt lại).
  //     CẢNH BÁO MỀM theo quyết định của chủ: không bao giờ chặn tay chủ.
  const closingStatusQuery = useCashbookMonthlyClosingStatus(organizationId, period);
  //     Bốn nhóm, cố ý tách theo VIỆC CỦA AI. Đo trên trình duyệt: chủ mở hộp
  //     thoại chốt "Hiệp Thu" thì ăn blocker NO_CONFIRMER — sổ đó chốt được
  //     nhưng phải NATHAN đề nghị, chủ chỉ ký. Bày một nút "Chốt sổ" cho chủ ở
  //     đây là dẫn người ta vào cửa đóng.
  const cashbookGaps = useMemo(() => {
    const rows = closingStatusQuery.data ?? [];
    const open = rows.filter((r) => !r.covered && r.needs_closing);
    const waiting = open.filter((r) => r.has_pending_request);
    const rest = open.filter((r) => !r.has_pending_request);
    return {
      // đề nghị chờ ký — tách riêng phần chờ CHÍNH TÔI ký
      waiting,
      waitingMine: waiting.filter((r) => r.i_can_confirm),
      // tôi giữ sổ + tôi đề nghị được + có người khác ký được
      mine: rest.filter((r) => r.i_can_propose),
      // hệ đủ hai bên nhưng người phải bấm là NGƯỜI KHÁC
      others: rest.filter((r) => !r.i_can_propose && r.can_be_closed),
      // không chốt được vì chỉ MỘT người dính líu tới sổ — nhắc là vô nghĩa,
      // phải gán ai đó vào vai trò "Kế toán" trước
      noSigner: rest.filter((r) => !r.can_be_closed),
      total: open.length,
    };
  }, [closingStatusQuery.data]);

  // (2) Tháng chưa kết thúc. Thói quen hiện tại là chốt từ giữa tháng (07/2026
  //     chốt đủ 17/17 nhà từ 20/07) — kéo theo tháng bị khoá khi còn đang ghi
  //     phiếu, rồi phải bấm "Mở khoá tháng" liên tục.
  const monthNotEnded = useMemo(
    () => period >= periodOf(now.getFullYear(), now.getMonth() + 1),
    // `now` tạo mới mỗi lần render nhưng chỉ dùng để lấy tháng hiện tại.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [period],
  );

  useEffect(() => {
    setOrganizationId((current) =>
      resolveProfitCloseOrganizationId(organizations, current),
    );
  }, [organizations]);

  const activeDrafts = useMemo(
    () => (form.scopeKey === scopeKey ? form.drafts : {}),
    [form.drafts, form.scopeKey, scopeKey],
  );
  const draftBuildingIds = useMemo(
    () => Object.keys(activeDrafts).sort(),
    [activeDrafts],
  );
  const draftAdjustments = useMemo(
    () => buildProfitCloseAdjustments(draftBuildingIds, activeDrafts),
    [draftBuildingIds, activeDrafts],
  );
  const debouncedAdjustments = useDebouncedValue(draftAdjustments, 300);
  const previewInputPending = useMemo(
    () => JSON.stringify(draftAdjustments) !== JSON.stringify(debouncedAdjustments),
    [draftAdjustments, debouncedAdjustments],
  );
  const previewQuery = useProfitClosePreview(
    organizationId,
    period,
    debouncedAdjustments,
    null,
    canLock,
  );
  const stateQuery = useProfitCloseState(organizationId, period);
  const state = stateQuery.data;
  const preview = previewQuery.data;
  const previewRows = useMemo(() => preview?.rows ?? [], [preview]);
  const stateRows = useMemo<ProfitClosePreviewRow[]>(
    () => (state?.rows ?? []).map((row): ProfitClosePreviewRow => ({
      building_id: row.building_id,
      building_name: row.building_name,
      revenue: row.source_revenue,
      expense: row.source_expense,
      computed_profit: row.computed_profit,
      adjustment_amount: row.adjustment_amount,
      management_salary: row.management_salary,
      distributable_profit: row.distributable_profit,
      shareholder_percent_total: row.shareholder_percent_total,
      shareholder_allocated_amount: row.shareholder_allocated_amount,
      unallocated_profit: row.unallocated_profit,
      unallocated_disposition: row.unallocated_disposition,
      unallocated_disposition_reason: row.unallocated_disposition_reason,
      source_hash: row.source_hash,
      is_stale: row.is_stale,
      stale_reason: row.stale_reason,
      delta_profit: 0,
      shareholder_allocations: [],
      manager_allocations: [],
      current_snapshot: {
        id: row.id,
        status: row.status,
        computed_profit: row.computed_profit,
        adjustment_amount: row.adjustment_amount,
        adjustment_reason: row.adjustment_reason,
        adjusted_profit: row.adjusted_profit,
        management_salary: row.management_salary,
        distributable_profit: row.distributable_profit,
        shareholder_percent_total: row.shareholder_percent_total,
        shareholder_allocated_amount: row.shareholder_allocated_amount,
        unallocated_profit: row.unallocated_profit,
        unallocated_disposition: row.unallocated_disposition,
        unallocated_disposition_reason: row.unallocated_disposition_reason,
        source_hash: row.source_hash,
        locked_at: row.locked_at,
      },
    })),
    [state],
  );
  const lockedBuildingIds = useMemo(
    () => previewRows
      .filter((row) => row.current_snapshot?.status === "LOCKED")
      .map((row) => row.building_id),
    [previewRows],
  );
  const initialCloseBuildingIds = useMemo(
    () => previewRows
      .filter((row) => row.current_snapshot?.status !== "LOCKED")
      .map((row) => row.building_id),
    [previewRows],
  );
  const hasLocked = lockedBuildingIds.length > 0;
  const hasUnlocked = initialCloseBuildingIds.length > 0;
  const hasAnyLockedSnapshot = (state?.locked_count ?? 0) > 0;
  const hasSnapshots = (state?.snapshot_count ?? 0) > 0;
  const mixedState = Boolean(state?.has_out_of_scope_snapshots) || (hasLocked && hasUnlocked);
  const canInitialClose =
    !stateQuery.isLoading && hasUnlocked && !hasLocked && !mixedState;
  const canReclose =
    !stateQuery.isLoading && hasLocked && !hasUnlocked && !mixedState;
  const targetBuildingIds = useMemo(
    () => previewRows.map((row) => row.building_id),
    [previewRows],
  );
  const unallocatedProfitByBuilding = useMemo(
    () =>
      Object.fromEntries(
        previewRows.map((row) => [row.building_id, row.unallocated_profit]),
      ),
    [previewRows],
  );
  const invalidResidualRows = useMemo(
    () =>
      previewRows.filter((row) => {
        if (!hasUnallocatedProfitResidual(row.unallocated_profit)) return false;
        const draft = activeDrafts[row.building_id];
        const disposition = normalizeUnallocatedDisposition(
          draft?.unallocatedDisposition ?? row.unallocated_disposition,
        );
        const reason = (
          draft?.unallocatedDispositionReason ??
          row.unallocated_disposition_reason ??
          ""
        ).trim();
        return !disposition || reason.length < 8 || reason.length > 500;
      }),
    [activeDrafts, previewRows],
  );
  const hasInvalidResidualDisposition = invalidResidualRows.length > 0;
  const isEditing = canLock && (recloseMode ? canReclose : canInitialClose);
  const rows = canLock ? previewRows : stateRows;
  const dataLoading = stateQuery.isLoading || (canLock && previewQuery.isLoading);
  const displayedHash = canLock ? preview?.source_hash : state?.state_hash;
  const closeMutation = useCloseProfitPeriod();
  const resetMutation = useResetProfitPeriod();
  const unlockMutation = useUnlockProfitMonth();

  useEffect(() => {
    if (!preview) return;
    setForm((previous) => {
      const sameScope = previous.scopeKey === scopeKey;
      const dirty = sameScope ? previous.dirty : {};
      const drafts = mergeProfitCloseDrafts(
        preview.rows.map((row) => ({
          buildingId: row.building_id,
          locked: row.current_snapshot?.status === "LOCKED",
          snapshotAdjustmentAmount: row.current_snapshot?.adjustment_amount,
          snapshotAdjustmentReason: row.current_snapshot?.adjustment_reason,
          unallocatedDisposition:
            row.unallocated_disposition ??
            row.current_snapshot?.unallocated_disposition,
          unallocatedDispositionReason:
            row.unallocated_disposition_reason ??
            row.current_snapshot?.unallocated_disposition_reason,
        })),
        sameScope ? previous.drafts : {},
        new Set(Object.keys(dirty)),
      );
      return { scopeKey, drafts, dirty };
    });
  }, [preview, scopeKey]);

  useEffect(() => {
    setRecloseMode(false);
    setOverallReason("");
    setRowErrors({});
    setOverallReasonError(null);
    setConfirmOpen(false);
    setResetOpen(false);
    setResetGuard(null);
    setResetReason("");
  }, [scopeKey]);

  const updateDraft = (
    buildingId: string,
    patch: Partial<ProfitCloseDraftMap[string]>,
  ) => {
    setForm((previous) => {
      const drafts = previous.scopeKey === scopeKey ? previous.drafts : {};
      const current = drafts[buildingId] ?? {
        adjustmentAmount: 0,
        adjustmentReason: "",
        unallocatedDisposition: null,
        unallocatedDispositionReason: "",
      };
      return {
        scopeKey,
        drafts: {
          ...drafts,
          [buildingId]: { ...current, ...patch },
        },
        dirty: {
          ...(previous.scopeKey === scopeKey ? previous.dirty : {}),
          [buildingId]: true,
        },
      };
    });
    setRowErrors((previous) => {
      if (!previous[buildingId]) return previous;
      const next = { ...previous };
      delete next[buildingId];
      return next;
    });
  };

  const resetDraftsFromPreview = () => {
    if (!preview) return;
    setForm({
      scopeKey,
      drafts: mergeProfitCloseDrafts(
        preview.rows.map((row) => ({
          buildingId: row.building_id,
          locked: row.current_snapshot?.status === "LOCKED",
          snapshotAdjustmentAmount: row.current_snapshot?.adjustment_amount,
          snapshotAdjustmentReason: row.current_snapshot?.adjustment_reason,
          unallocatedDisposition:
            row.unallocated_disposition ??
            row.current_snapshot?.unallocated_disposition,
          unallocatedDispositionReason:
            row.unallocated_disposition_reason ??
            row.current_snapshot?.unallocated_disposition_reason,
        })),
        {},
        new Set(),
      ),
      dirty: {},
    });
    setRowErrors({});
    setOverallReasonError(null);
  };

  const openCloseConfirmation = () => {
    const validation = validateProfitCloseDrafts(targetBuildingIds, activeDrafts, {
      reclose: recloseMode,
      overallReason,
      unallocatedProfitByBuilding,
    });
    setRowErrors(validation.rowErrors);
    setOverallReasonError(validation.overallReasonError);
    if (!validation.valid) {
      toast.error("Kiểm tra lại lý do điều chỉnh trước khi chốt");
      return;
    }
    if (hasInvalidResidualDisposition) {
      toast.error("Mọi phần lợi nhuận chưa phân bổ phải có cách xử lý và lý do");
      return;
    }
    if (previewInputPending || previewQuery.isFetching) {
      toast.info("Đang cập nhật preview theo điều chỉnh mới nhất");
      return;
    }
    if (!preview?.source_hash) {
      toast.error("Preview chưa có mã nguồn dữ liệu; hãy tải lại trước khi chốt");
      return;
    }
    setConfirmOpen(true);
  };

  const confirmClose = async () => {
    if (!preview) return;
    if (hasInvalidResidualDisposition) {
      toast.error("Preview còn phần chưa phân bổ chưa có cách xử lý hợp lệ");
      return;
    }
    try {
      await closeMutation.mutateAsync({
        organizationId,
        periodMonth: period,
        buildingIds: targetBuildingIds,
        adjustments: buildProfitCloseAdjustments(
          targetBuildingIds,
          activeDrafts,
          unallocatedProfitByBuilding,
        ),
        expectedSourceHash: preview.source_hash,
        reason: overallReason,
        reclose: recloseMode,
      });
      setConfirmOpen(false);
      setRecloseMode(false);
      setOverallReason("");
      setForm((previous) => ({ ...previous, dirty: {} }));
    } catch {
      // Mutation hook surfaces the canonical server error.
    }
  };

  const confirmReset = async () => {
    if (!resetGuard || !resetReasonValid) return;
    try {
      await resetMutation.mutateAsync({
        organizationId: resetGuard.organizationId,
        periodMonth: resetGuard.period,
        expectedStateHash: resetGuard.stateHash,
        expectedSnapshotIds: resetGuard.snapshotIds,
        reason: resetReason,
      });
      setResetOpen(false);
      setResetGuard(null);
      setResetReason("");
      setRecloseMode(false);
      setOverallReason("");
      setForm((previous) => ({ ...previous, dirty: {} }));
    } catch {
      // Mutation hook surfaces the canonical server error.
    }
  };

  const staleCount = rows.filter(
    (row) => row.current_snapshot?.status === "LOCKED" && row.is_stale,
  ).length;
  const totalDistributable = rows.reduce(
    (sum, row) => sum + row.distributable_profit,
    0,
  );
  const totalShareholderAllocated = rows.reduce(
    (sum, row) => sum + row.shareholder_allocated_amount,
    0,
  );
  const totalUnallocated = rows.reduce(
    (sum, row) => sum + row.unallocated_profit,
    0,
  );
  const hasAnyResidual = rows.some((row) =>
    hasUnallocatedProfitResidual(row.unallocated_profit),
  );
  const shareholderTotals = useMemo(() => {
    const totals = new Map<string, { name: string; amount: number }>();
    for (const row of rows) {
      for (const allocation of row.shareholder_allocations) {
        const current = totals.get(allocation.shareholder_id);
        totals.set(allocation.shareholder_id, {
          name: allocation.shareholder_name,
          amount: (current?.amount ?? 0) + allocation.amount,
        });
      }
    }
    return [...totals.entries()]
      .map(([id, value]) => ({ id, ...value }))
      .filter((row) => row.amount !== 0)
      .sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [rows]);
  const managerTotals = useMemo(() => {
    const totals = new Map<string, { name: string; amount: number }>();
    for (const row of rows) {
      for (const allocation of row.manager_allocations) {
        const current = totals.get(allocation.manager_id);
        totals.set(allocation.manager_id, {
          name: allocation.manager_name,
          amount: (current?.amount ?? 0) + allocation.amount,
        });
      }
    }
    return [...totals.entries()]
      .map(([id, value]) => ({ id, ...value }))
      .filter((row) => row.amount !== 0)
      .sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [rows]);
  const years = [currentYear() + 1, currentYear(), currentYear() - 1, currentYear() - 2];

  // ---- Dải KPI trên hero (thiết kế Claude Design tab "Chốt LN tháng") ----
  const lockedRowCount = rows.filter((row) => row.current_snapshot?.status === "LOCKED").length;
  const organizationName =
    organizations.find((o) => o.organization_id === organizationId)?.organization_name ?? "—";
  const residualNote = rows
    .filter((row) => hasUnallocatedProfitResidual(row.unallocated_profit))
    .map(
      (row) =>
        `${dispositionLabel(
          row.unallocated_disposition ?? row.current_snapshot?.unallocated_disposition ?? null,
        )} · ${row.building_name}`,
    );

  return (
    <>
      <ProfitHubSlot name="kpis">
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Kỳ chốt</div>
          <div className="ph-kpi__row" style={{ marginTop: 3 }}>
            <div className="ph-kpi__value" style={{ marginTop: 0 }}>{periodToLabel(period)}</div>
            {hasAnyLockedSnapshot && !hasUnlocked ? (
              <div className="ph-pill-mint">✓ Đã chốt toàn bộ</div>
            ) : hasAnyLockedSnapshot ? (
              <div className="ph-state ph-state--lg ph-state--warn">Chốt một phần</div>
            ) : (
              <div className="ph-state ph-state--lg ph-state--muted">Chưa chốt</div>
            )}
            {preview?.is_stale && <div className="ph-state ph-state--lg ph-state--danger">Đã lệch nguồn</div>}
          </div>
          <div className="ph-kpi__sub">
            {lockedRowCount}/{rows.length} nhà · {organizationName}
          </div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Tổng quỹ sau lương</div>
          <div className="ph-kpi__value ph-kpi__value--mint">{formatCurrency(totalDistributable)}</div>
          <div className="ph-kpi__sub">LN tự tính + điều chỉnh − lương ĐH</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Đã phân bổ cổ đông</div>
          <div className="ph-kpi__value">{formatCurrency(totalShareholderAllocated)}</div>
          <div className="ph-kpi__sub">theo tỷ lệ từng nhà</div>
        </div>
        <div className="ph-kpi__div" />
        <div className="ph-kpi ph-kpi--flex">
          <div className="ph-kpi__label">Chưa phân bổ</div>
          <div className={`ph-kpi__value${hasAnyResidual ? " ph-kpi__value--gold" : " ph-kpi__value--mint"}`}>
            {formatCurrency(totalUnallocated)}
          </div>
          <div className="ph-kpi__sub" title={residualNote.join(" · ")}>
            {residualNote.length > 0 ? residualNote[0] : "Đã phân bổ hết"}
            {residualNote.length > 1 ? ` (+${residualNote.length - 1})` : ""}
          </div>
        </div>
        <div className="ph-kpi" style={{ marginLeft: "auto", textAlign: "right" }}>
          <div className="ph-kpi__label">{canLock ? "Source hash" : "Snapshot state hash"}</div>
          <div className="ph-hash" title={displayedHash}>{shortHash(displayedHash)}</div>
        </div>
      </ProfitHubSlot>

      <div className="ph-stack">
      <div className="ph-toolbar">
        <Select value={organizationId} onValueChange={setOrganizationId}>
          <SelectTrigger className="ph-control" aria-label="Chọn tổ chức">
            <SelectValue placeholder="Chọn tổ chức" />
          </SelectTrigger>
          <SelectContent>
            {organizations.map((organization) => (
              <SelectItem
                key={organization.organization_id}
                value={organization.organization_id}
              >
                {organization.organization_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(month)} onValueChange={(value) => setMonth(Number(value))}>
          <SelectTrigger className="ph-control" aria-label="Chọn tháng"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Array.from({ length: 12 }, (_, index) => index + 1).map((value) => (
              <SelectItem key={value} value={String(value)}>Tháng {value}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(year)} onValueChange={(value) => setYear(Number(value))}>
          <SelectTrigger className="ph-control" aria-label="Chọn năm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {years.map((value) => (
              <SelectItem key={value} value={String(value)}>{value}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ph-toolbar__push" style={{ gap: 8 }}>
          <Button
            className="ph-control ph-control--strong"
            onClick={() => {
              void stateQuery.refetch();
              if (canLock) void previewQuery.refetch();
            }}
            disabled={
              !organizationId ||
              previewQuery.isFetching ||
              stateQuery.isFetching ||
              closeMutation.isPending ||
              resetMutation.isPending
            }
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${previewQuery.isFetching || stateQuery.isFetching ? "animate-spin" : ""}`} />
            Tải lại số nguồn
          </Button>

          {canReclose && canLock && !recloseMode && (
            <Button
              className="ph-btn-primary"
              onClick={() => setRecloseMode(true)}
              disabled={rows.length === 0}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Chốt lại tháng {periodToLabel(period)}
            </Button>
          )}

          {recloseMode && (
            <Button
              className="ph-control ph-control--strong"
              onClick={() => {
                setRecloseMode(false);
                setOverallReason("");
                resetDraftsFromPreview();
              }}
              disabled={closeMutation.isPending}
            >
              Huỷ chỉnh sửa
            </Button>
          )}

          {isEditing && (
            <Button
              className="ph-btn-primary"
              onClick={openCloseConfirmation}
              disabled={
                rows.length === 0 ||
                dataLoading ||
                previewQuery.isFetching ||
                stateQuery.isFetching ||
                previewInputPending ||
                hasInvalidResidualDisposition ||
                closeMutation.isPending
              }
            >
              <Lock className="mr-1.5 h-3.5 w-3.5" />
              {recloseMode
                ? "Xác nhận chốt lại"
                : `Chốt tháng ${periodToLabel(period)}`}
            </Button>
          )}

          {/* MỞ KHOÁ — nhẹ hơn "Đặt lại tháng" ở chỗ KHÔNG cần lý do + CAS
              hash, nhưng KHÔNG hề nhẹ về hậu quả: thân `unlock_profit_month_v1`
              đang chạy trên prod XOÁ `profit_allocations` +
              `profit_manager_allocations`, đặt `management_salary = 0` rồi lật
              snapshot về DRAFT. (Comment cũ ở đây ghi "snapshot giữ nguyên" —
              SAI, đã đối chiếu thân hàm thật.) Từ 30/07/2026 phiếu của tháng đã
              chốt bị TRIGGER chặn, nên không có nút này thì chủ phải nhờ kỹ
              thuật chạy SQL mỗi lần cần sửa một phiếu. */}
          {hasSnapshots && canUnlock && (
            <Button
              className="ph-control"
              onClick={() => {
                const locked = (state?.rows ?? [])
                  .filter((r) => r.locked_at)
                  .map((r) => r.building_id);
                if (locked.length === 0) return;
                unlockMutation.mutate({ periodMonth: period, buildingIds: locked });
              }}
              disabled={
                unlockMutation.isPending ||
                resetMutation.isPending ||
                closeMutation.isPending ||
                (state?.rows ?? []).every((r) => !r.locked_at)
              }
              title="Gỡ khoá để sửa phiếu của tháng này. LƯU Ý: phần đã phân bổ cho cổ đông và quản lý sẽ bị XOÁ, snapshot về Nháp — phải chốt lại sau khi sửa xong."
            >
              <LockOpen className="mr-1.5 h-3.5 w-3.5" />
              Mở khoá tháng
            </Button>
          )}

          {hasSnapshots && canUnlock && (
            <Button
              className="ph-control ph-control--danger"
              onClick={() => {
                if (!state?.state_hash || state.snapshot_ids.length === 0) return;
                setResetGuard({
                  organizationId,
                  period,
                  stateHash: state.state_hash,
                  snapshotIds: [...state.snapshot_ids],
                });
                setResetOpen(true);
              }}
              disabled={
                !state?.state_hash ||
                state.snapshot_ids.length === 0 ||
                resetMutation.isPending ||
                closeMutation.isPending
              }
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Đặt lại tháng
            </Button>
          )}
        </div>
      </div>

      {!organizationId && organizations.length > 1 && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Chọn tổ chức cần thao tác</AlertTitle>
          <AlertDescription>
            Tài khoản có quyền ở nhiều tổ chức. Preview, snapshot, chốt và đặt lại
            chỉ tải sau khi chọn rõ một tổ chức.
          </AlertDescription>
        </Alert>
      )}

      {stateQuery.isError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Không tải được trạng thái snapshot</AlertTitle>
          <AlertDescription>
            {stateQuery.error instanceof Error
              ? stateQuery.error.message
              : "RPC trạng thái snapshot chưa sẵn sàng."}
          </AlertDescription>
        </Alert>
      )}

      {canLock && previewQuery.isError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Không tải được preview chốt lợi nhuận</AlertTitle>
          <AlertDescription>
            {previewQuery.error instanceof Error
              ? previewQuery.error.message
              : "RPC canonical chưa sẵn sàng."}
          </AlertDescription>
        </Alert>
      )}

      {mixedState && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Trạng thái chốt tháng không đồng nhất</AlertTitle>
          <AlertDescription>
            Tháng này có nhà đã chốt xen nhà chưa chốt hoặc còn snapshot legacy ngoài preview.
            Không thể chốt một phần vì lương điều hành TOTAL_GROUP phụ thuộc toàn bộ nhóm nhà.
            Hãy dùng “Đặt lại tháng” rồi chốt lại toàn bộ.
          </AlertDescription>
        </Alert>
      )}

      {hasLocked && staleCount > 0 && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Số đã chốt không còn khớp nguồn hiện tại</AlertTitle>
          <AlertDescription>
            {staleCount} nhà đã thay đổi dữ liệu hoặc cấu hình sau lần chốt gần nhất.
            {mixedState
              ? " Cần đặt lại toàn tháng trước khi chốt mới."
              : " Chọn “Chốt lại” để xem điều chỉnh theo số mới; hệ thống sẽ kiểm tra source hash lần nữa khi ghi."}
          </AlertDescription>
        </Alert>
      )}

      {/* PA4 lưới 1 — sổ quỹ chưa chốt. Mềm: liệt kê + dẫn đường, không chặn. */}
      {cashbookGaps.total > 0 && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-900 [&>svg]:text-amber-600">
          <Wallet className="h-4 w-4" />
          <AlertTitle>
            Còn {cashbookGaps.total} sổ quỹ chưa chốt hết {periodToLabel(period)}
          </AlertTitle>
          <AlertDescription>
            <div className="space-y-2">
              <p>
                Chốt lợi nhuận trước khi đếm quỹ nghĩa là con số đem chia chưa có ai
                ký nhận. Chốt từng sổ trước rồi hãy chốt tháng.
              </p>
              {cashbookGaps.mine.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">Bạn chốt được ngay:</span>
                  {cashbookGaps.mine.map((r) => (
                    <Link
                      key={r.cashbook_id}
                      to={`/finance/cashbooks?close=${r.cashbook_id}`}
                      className="rounded border border-amber-400 bg-white/70 px-1.5 py-0.5 text-xs font-medium underline-offset-2 hover:underline"
                      title={
                        r.closed_through
                          ? `Đã chốt tới ${r.closed_through}`
                          : "Chưa chốt lần nào"
                      }
                    >
                      {r.cashbook_name}
                    </Link>
                  ))}
                </div>
              )}
              {cashbookGaps.waitingMine.length > 0 && (
                <p>
                  <span className="font-medium">Chờ BẠN ký:</span>{" "}
                  {cashbookGaps.waitingMine.map((r) => r.cashbook_name).join(" · ")} —
                  mở <Link to="/finance/cashbooks" className="underline">Sổ quỹ</Link> để
                  đếm lại và ký nhận.
                </p>
              )}
              {cashbookGaps.waiting.length > cashbookGaps.waitingMine.length && (
                <p>
                  <span className="font-medium">Chờ người khác ký:</span>{" "}
                  {cashbookGaps.waiting
                    .filter((r) => !r.i_can_confirm)
                    .map((r) => r.cashbook_name)
                    .join(" · ")}{" "}
                  — đã có đề nghị, nhắc người nhận vào ký.
                </p>
              )}
              {cashbookGaps.others.length > 0 && (
                <p>
                  <span className="font-medium">Chờ người giữ sổ đề nghị:</span>{" "}
                  {cashbookGaps.others.map((r) => r.cashbook_name).join(" · ")} — nghi
                  thức đòi người ký <em>khác</em> người đề nghị, nên bạn không tự chốt
                  các sổ này; người đang giữ sổ phải đề nghị rồi bạn ký.
                </p>
              )}
              {cashbookGaps.noSigner.length > 0 && (
                <p>
                  <span className="font-medium">Chưa có người ký:</span>{" "}
                  {cashbookGaps.noSigner.map((r) => r.cashbook_name).join(" · ")} — các
                  sổ này chỉ một người dính tới nên không ai ký nhận được. Gán một người
                  vào vai trò <strong>Kế toán</strong> (Cài đặt → Thành viên, phạm vi{" "}
                  <em>toàn tổ chức</em>) là chốt được ngay.
                </p>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* PA4 lưới 2 — đừng chốt tháng còn đang chạy. */}
      {monthNotEnded && (canInitialClose || canReclose) && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-900 [&>svg]:text-amber-600">
          <CalendarClock className="h-4 w-4" />
          <AlertTitle>{periodToLabel(period)} chưa kết thúc</AlertTitle>
          <AlertDescription>
            Chốt bây giờ là chốt trên số liệu còn thiếu những ngày chưa tới, và mọi
            phiếu ghi sau đó sẽ bị khoá — muốn ghi tiếp phải “Mở khoá tháng”, mà mở
            khoá thì <strong>xoá phần đã phân bổ</strong> và phải chốt lại. Nên đợi qua
            ngày cuối tháng rồi chốt một lần.
          </AlertDescription>
        </Alert>
      )}

      {hasInvalidResidualDisposition && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Chưa có cách xử lý phần lợi nhuận còn dư</AlertTitle>
          <AlertDescription>
            {invalidResidualRows.length} nhà còn phần chưa phân bổ từ 0,01đ trở lên.
            Chọn “Giữ lại lợi nhuận” hoặc “Chuyển kỳ sau” và nhập lý do 8–500 ký tự
            cho từng nhà trước khi chốt{hasLocked && !recloseMode ? " lại" : ""}.
          </AlertDescription>
        </Alert>
      )}

      <div className="ph-card">
        <div className="ph-card__head" style={{ alignItems: "flex-start" }}>
          <div>
            <div className="ph-card__title">Lợi nhuận theo nhà — {periodToLabel(period)}</div>
            <div className="ph-card__note">
              Công thức: <b>LN tự tính + Điều chỉnh − Lương điều hành = Quỹ sau lương</b> → tách phần
              đã phân bổ cổ đông và phần chưa phân bổ.
            </div>
          </div>
          <div className="ph-card__push">
            {hasAnyLockedSnapshot && !hasUnlocked ? (
              <span className="ph-state ph-state--lg">Đã chốt toàn bộ</span>
            ) : hasAnyLockedSnapshot ? (
              <span className="ph-state ph-state--lg ph-state--warn">Chốt một phần</span>
            ) : (
              <span className="ph-state ph-state--lg ph-state--muted">Chưa chốt</span>
            )}
            {preview?.is_stale && <span className="ph-state ph-state--lg ph-state--danger">Đã lệch nguồn</span>}
            <span style={{ fontFamily: "var(--ph-mono)", fontSize: 10.5, color: "var(--ph-ink-4)" }}>
              hash {shortHash(displayedHash)}
            </span>
          </div>
        </div>
        <div>
          <div className="ph-tblwrap">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[150px]">Nhà</TableHead>
                  <TableHead className="text-right">Doanh thu</TableHead>
                  <TableHead className="text-right">Chi phí</TableHead>
                  <TableHead className="text-right">LN tự tính</TableHead>
                  <TableHead className="min-w-[220px]">Điều chỉnh có dấu</TableHead>
                  <TableHead className="text-right">Lương điều hành</TableHead>
                  <TableHead className="text-right">Quỹ sau lương</TableHead>
                  <TableHead className="text-right">Tỷ lệ CĐ</TableHead>
                  <TableHead className="text-right">Đã phân bổ</TableHead>
                  <TableHead className="min-w-[260px]">Phần chưa phân bổ</TableHead>
                  <TableHead className="min-w-[180px]">Snapshot hiện tại</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dataLoading && (
                  <TableRow>
                    <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                      Đang tải preview canonical…
                    </TableCell>
                  </TableRow>
                )}
                {!dataLoading && rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                      Không có nhà trong phạm vi được phép của tháng này
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((row) => {
                  const rowLocked = row.current_snapshot?.status === "LOCKED";
                  const rowEditable = isEditing;
                  const draft = activeDrafts[row.building_id] ?? {
                    adjustmentAmount: row.current_snapshot?.adjustment_amount ?? 0,
                    adjustmentReason: row.current_snapshot?.adjustment_reason ?? "",
                    unallocatedDisposition:
                      row.unallocated_disposition ??
                      row.current_snapshot?.unallocated_disposition ??
                      null,
                    unallocatedDispositionReason:
                      row.unallocated_disposition_reason ??
                      row.current_snapshot?.unallocated_disposition_reason ??
                      "",
                  };
                  const rowError = rowErrors[row.building_id];
                  const dispositionError = rowError?.includes("chưa phân bổ");
                  const hasResidual = hasUnallocatedProfitResidual(
                    row.unallocated_profit,
                  );
                  const normalizedDraftDisposition =
                    normalizeUnallocatedDisposition(
                      draft.unallocatedDisposition,
                    );
                  const dispositionReasonLength =
                    draft.unallocatedDispositionReason.trim().length;
                  const dispositionInvalid =
                    hasResidual &&
                    (!normalizedDraftDisposition ||
                      dispositionReasonLength < 8 ||
                      dispositionReasonLength > 500);
                  const displayedDistributable =
                    row.computed_profit + draft.adjustmentAmount - row.management_salary;
                  return (
                    <TableRow key={row.building_id} className={row.is_stale ? "bg-red-50/40" : undefined}>
                      <TableCell className="align-top font-medium">
                        <div>{row.building_name}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {row.is_stale && <Badge variant="destructive">Cũ</Badge>}
                          {row.is_stale && (
                            <Badge
                              variant="outline"
                              title={row.stale_reason ?? "Snapshot không còn khớp nguồn hiện tại"}
                            >
                              Δ {row.delta_profit > 0 ? "+" : ""}{formatCurrency(row.delta_profit)}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Hash <span className="font-mono" title={row.source_hash}>{shortHash(row.source_hash)}</span>
                        </p>
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums text-emerald-600">
                        {formatCurrency(row.revenue)}
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums text-red-600">
                        {formatCurrency(row.expense)}
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums">
                        {formatCurrency(row.computed_profit)}
                      </TableCell>
                      <TableCell className="align-top">
                        {rowEditable ? (
                          <div className="space-y-2">
                            <SignedAdjustmentInput
                              value={draft.adjustmentAmount}
                              onChange={(value) =>
                                updateDraft(row.building_id, {
                                  adjustmentAmount: value,
                                })
                              }
                              label={`Điều chỉnh lợi nhuận ${row.building_name}`}
                            />
                            <Input
                              value={draft.adjustmentReason}
                              onChange={(event) =>
                                updateDraft(row.building_id, {
                                  adjustmentReason: event.target.value,
                                })
                              }
                              placeholder={draft.adjustmentAmount === 0 ? "Không bắt buộc" : "Lý do (ít nhất 8 ký tự)"}
                              maxLength={500}
                              aria-invalid={!!rowError && !dispositionError}
                              aria-label={`Lý do điều chỉnh ${row.building_name}`}
                            />
                            {rowError && !dispositionError && (
                              <p className="text-xs text-destructive">{rowError}</p>
                            )}
                          </div>
                        ) : (
                          <div className="text-right">
                            <p className={`font-medium tabular-nums ${draft.adjustmentAmount < 0 ? "text-red-600" : draft.adjustmentAmount > 0 ? "text-emerald-600" : ""}`}>
                              {draft.adjustmentAmount > 0 ? "+" : ""}{formatCurrency(draft.adjustmentAmount)}
                            </p>
                            {draft.adjustmentReason && (
                              <p className="mt-1 text-xs text-muted-foreground">{draft.adjustmentReason}</p>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums text-orange-600">
                        {formatCurrency(row.management_salary)}
                      </TableCell>
                      <TableCell className={`align-top text-right font-semibold tabular-nums ${displayedDistributable < 0 ? "text-red-600" : ""}`}>
                        {formatCurrency(displayedDistributable)}
                        {(previewInputPending || previewQuery.isFetching) && (
                          <p className="mt-1 text-[11px] font-normal text-muted-foreground">Đang kiểm tra lại…</p>
                        )}
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums">
                        <span
                          className={
                            row.shareholder_percent_total > 100.0001
                              ? "text-red-600"
                              : row.shareholder_percent_total < 99.9999
                                ? "text-amber-700"
                                : "text-emerald-700"
                          }
                        >
                          {row.shareholder_percent_total.toLocaleString("vi-VN", { maximumFractionDigits: 4 })}%
                        </span>
                      </TableCell>
                      <TableCell className="align-top text-right font-medium tabular-nums">
                        {formatCurrency(row.shareholder_allocated_amount)}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="space-y-2">
                          <p className={`font-semibold tabular-nums ${hasResidual ? "text-amber-700" : "text-emerald-700"}`}>
                            {formatCurrency(row.unallocated_profit)}
                          </p>
                          {hasResidual ? rowEditable ? (
                            <>
                              <Select
                                value={draft.unallocatedDisposition ?? ""}
                                onValueChange={(value) =>
                                  updateDraft(row.building_id, {
                                    unallocatedDisposition:
                                      value as ProfitUnallocatedDisposition,
                                  })
                                }
                              >
                                <SelectTrigger aria-label={`Cách xử lý phần chưa phân bổ ${row.building_name}`}>
                                  <SelectValue placeholder="Chọn cách xử lý" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="RETAINED_EARNINGS">Giữ lại lợi nhuận</SelectItem>
                                  <SelectItem value="CARRY_FORWARD">Chuyển kỳ sau</SelectItem>
                                </SelectContent>
                              </Select>
                              <Input
                                value={draft.unallocatedDispositionReason}
                                onChange={(event) =>
                                  updateDraft(row.building_id, {
                                    unallocatedDispositionReason: event.target.value,
                                  })
                                }
                                placeholder="Lý do xử lý (ít nhất 8 ký tự)"
                                maxLength={500}
                                aria-invalid={dispositionInvalid}
                                aria-label={`Lý do xử lý phần chưa phân bổ ${row.building_name}`}
                              />
                              {dispositionInvalid && (
                                <p className="text-xs text-destructive">
                                  {dispositionError
                                    ? rowError
                                    : !normalizedDraftDisposition
                                      ? "Chọn cách xử lý phần chưa phân bổ"
                                      : "Lý do xử lý phải có 8–500 ký tự"}
                                </p>
                              )}
                            </>
                          ) : (
                            <div className="space-y-1 text-xs">
                              <Badge variant={draft.unallocatedDisposition ? "secondary" : "destructive"}>
                                {dispositionLabel(draft.unallocatedDisposition)}
                              </Badge>
                              {draft.unallocatedDispositionReason && (
                                <p className="text-muted-foreground">{draft.unallocatedDispositionReason}</p>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-emerald-700">Đã phân bổ hết</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        {row.current_snapshot ? (
                          <div className="space-y-1 text-sm">
                            <div className="flex items-center justify-between gap-2">
                              {rowLocked ? (
                                <Badge className="bg-emerald-600">Đã chốt</Badge>
                              ) : (
                                <Badge variant="outline">Chưa chốt</Badge>
                              )}
                              <span className="font-medium tabular-nums">
                                {formatCurrency(row.current_snapshot.distributable_profit)}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Đã phân bổ: {formatCurrency(row.current_snapshot.shareholder_allocated_amount)}
                            </p>
                            {hasUnallocatedProfitResidual(row.current_snapshot.unallocated_profit) && (
                              <p className="text-xs text-amber-700">
                                Còn {formatCurrency(row.current_snapshot.unallocated_profit)} · {dispositionLabel(row.current_snapshot.unallocated_disposition)}
                              </p>
                            )}
                            <p className="text-[11px] text-muted-foreground">
                              Hash <span className="font-mono" title={row.current_snapshot.source_hash ?? undefined}>{shortHash(row.current_snapshot.source_hash)}</span>
                            </p>
                          </div>
                        ) : (
                          <Badge variant="outline">Chưa có</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {rows.length > 0 && (
            <div className="ph-grid-3" style={{ borderTop: "1px solid var(--ph-line)", background: "#FAFBFA", padding: "12px 18px" }}>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--ph-ink-4)", fontWeight: 600 }}>Tổng quỹ sau lương</div>
                <div className={`ph-lock-total${totalDistributable < 0 ? " bad" : ""}`}>
                  {formatCurrency(totalDistributable)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--ph-ink-4)", fontWeight: 600 }}>Đã phân bổ cho cổ đông</div>
                <div className="ph-lock-total">{formatCurrency(totalShareholderAllocated)}</div>
              </div>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--ph-ink-4)", fontWeight: 600 }}>Chưa phân bổ</div>
                <div className={`ph-lock-total${hasAnyResidual ? " warn" : " ok"}`}>
                  {formatCurrency(totalUnallocated)}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="ph-grid-2-lock">
        {managerTotals.length > 0 && (
          <div className="ph-card ph-card__pad">
            <div className="ph-card__title">Lương điều hành theo preview</div>
            <div className="ph-grid-2" style={{ marginTop: 12, gap: 10 }}>
              {managerTotals.map((manager) => (
                <div key={manager.id} className="ph-tile">
                  <div className="ph-tile__label">{manager.name}</div>
                  <div className="ph-tile__value ph-tile__value--expense">
                    {formatCurrency(manager.amount)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {shareholderTotals.length > 0 && (
          <div className="ph-card ph-card__pad">
            <div className="ph-card__title">Xem trước chia cho cổ đông — {periodToLabel(period)}</div>
            <div className="ph-grid-4" style={{ marginTop: 12 }}>
              {shareholderTotals.map((shareholder) => (
                <div key={shareholder.id} className="ph-tile">
                  <div className="ph-tile__label">{shareholder.name}</div>
                  <div className="ph-tile__value">{formatCurrency(shareholder.amount)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {isEditing && rows.length > 0 && (
        <div className="ph-card ph-card__pad">
          <div className="ph-card__title">
            {recloseMode ? "Lý do chốt lại" : "Ghi chú lần chốt"}
          </div>
          <div>
            <Textarea
              className="ph-note-box"
              value={overallReason}
              onChange={(event) => {
                setOverallReason(event.target.value);
                setOverallReasonError(null);
              }}
              rows={3}
              maxLength={1000}
              placeholder={
                recloseMode
                  ? "Bắt buộc: mô tả vì sao cần thay snapshot đã chốt"
                  : "Không bắt buộc cho lần chốt đầu"
              }
              aria-invalid={!!overallReasonError}
            />
            {overallReasonError && (
              <p className="mt-1 text-xs text-destructive">{overallReasonError}</p>
            )}
          </div>
        </div>
      )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {recloseMode
                ? `Chốt lại tháng ${periodToLabel(period)}?`
                : `Chốt tháng ${periodToLabel(period)}?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Server sẽ tự tính lại doanh thu, chi phí, lương điều hành và phân bổ cổ đông cho {targetBuildingIds.length} nhà.
                  Client chỉ gửi khoản điều chỉnh có dấu, disposition phần chưa phân bổ và lý do tương ứng.
                </p>
                {recloseMode && (
                  <p>
                    Thao tác này tạo revision mới và thay snapshot hiện tại. Lý do: <strong>{overallReason.trim()}</strong>
                  </p>
                )}
                <p>
                  Source hash dự kiến: <span className="font-mono">{shortHash(preview?.source_hash)}</span>.
                  Nếu dữ liệu nguồn đổi trước lúc ghi, server sẽ từ chối để bạn tải preview mới.
                </p>
                {monthNotEnded && (
                  <p className="font-medium text-amber-700">
                    {periodToLabel(period)} CHƯA KẾT THÚC. Phiếu ghi sau lúc chốt sẽ bị
                    khoá; mở khoá thì mất phần đã phân bổ và phải chốt lại. Nên đợi hết
                    tháng.
                  </p>
                )}
                {cashbookGaps.total > 0 && (
                  <p className="font-medium text-amber-700">
                    Còn {cashbookGaps.total} sổ quỹ chưa chốt hết tháng này — số lợi
                    nhuận đem chia chưa có ai đếm quỹ và ký nhận.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={closeMutation.isPending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmClose}
              disabled={
                closeMutation.isPending ||
                previewInputPending ||
                previewQuery.isFetching ||
                hasInvalidResidualDisposition
              }
            >
              {closeMutation.isPending ? "Đang xử lý…" : recloseMode ? "Chốt lại" : "Chốt tháng"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Đặt lại tháng {periodToLabel(period)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Thao tác này bỏ toàn bộ snapshot hiện tại của tháng, kể cả dòng legacy ẩn, để có thể chốt mới từ đầu.
              Lịch sử revision vẫn được lưu phục vụ kiểm toán.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <Textarea
              value={resetReason}
              onChange={(event) => setResetReason(event.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Bắt buộc: lý do đặt lại tháng"
              aria-label="Lý do đặt lại tháng"
            />
            {!resetReasonValid && (
              <p className="text-xs text-muted-foreground">Lý do cần có 8–1000 ký tự.</p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetMutation.isPending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmReset}
              disabled={!resetReasonValid || resetMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {resetMutation.isPending ? "Đang đặt lại…" : "Đặt lại tháng"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
