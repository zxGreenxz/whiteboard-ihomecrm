export type ProfitUnallocatedDisposition =
  | "RETAINED_EARNINGS"
  | "CARRY_FORWARD";

export const UNALLOCATED_PROFIT_TOLERANCE = 0.01;

export interface ProfitCloseDraft {
  adjustmentAmount: number;
  adjustmentReason: string;
  unallocatedDisposition: ProfitUnallocatedDisposition | null;
  unallocatedDispositionReason: string;
}

export type ProfitCloseDraftMap = Record<string, ProfitCloseDraft>;

export interface ProfitCloseDraftSeed {
  buildingId: string;
  locked: boolean;
  snapshotAdjustmentAmount?: number | null;
  snapshotAdjustmentReason?: string | null;
  unallocatedDisposition?: ProfitUnallocatedDisposition | string | null;
  unallocatedDispositionReason?: string | null;
}

// `type` chứ không phải `interface`: chỉ type alias mới được TypeScript coi là có
// index signature ngầm, nên mới gán được vào `Json` khi truyền làm tham số RPC.
// Interface thì không, vì nó còn có thể bị declaration merging mở rộng sau này.
// Đổi một chữ ở đây thay được một `as any` ở chỗ gọi.
export type ProfitCloseAdjustmentPayload = {
  building_id: string;
  adjustment_amount: number;
  adjustment_reason: string | null;
  unallocated_disposition: ProfitUnallocatedDisposition | null;
  unallocated_disposition_reason: string | null;
}

export interface ProfitCloseValidationResult {
  valid: boolean;
  overallReasonError: string | null;
  rowErrors: Record<string, string>;
}

export interface ProfitCloseOrganizationOption {
  organization_id: string;
}

export function resolveProfitCloseOrganizationId(
  organizations: ProfitCloseOrganizationOption[],
  currentOrganizationId: string,
): string {
  if (
    currentOrganizationId &&
    organizations.some(
      (organization) => organization.organization_id === currentOrganizationId,
    )
  ) {
    return currentOrganizationId;
  }
  return organizations.length === 1 ? organizations[0].organization_id : "";
}

function finiteMoney(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

export function normalizeUnallocatedDisposition(
  value: unknown,
): ProfitUnallocatedDisposition | null {
  return value === "RETAINED_EARNINGS" || value === "CARRY_FORWARD"
    ? value
    : null;
}

export function hasUnallocatedProfitResidual(value: unknown): boolean {
  const parsed = Number(value);
  return (
    Number.isFinite(parsed) &&
    Math.abs(parsed) >= UNALLOCATED_PROFIT_TOLERANCE
  );
}

function seedDraft(row: ProfitCloseDraftSeed): ProfitCloseDraft {
  return {
    // A locked snapshot contributes only its signed adjustment. Its old absolute
    // adjusted profit must never become the base for a fresh server calculation.
    adjustmentAmount: row.locked ? finiteMoney(row.snapshotAdjustmentAmount) : 0,
    adjustmentReason: row.locked ? row.snapshotAdjustmentReason?.trim() ?? "" : "",
    unallocatedDisposition: normalizeUnallocatedDisposition(
      row.unallocatedDisposition,
    ),
    unallocatedDispositionReason:
      row.unallocatedDispositionReason?.trim() ?? "",
  };
}

export function mergeProfitCloseDrafts(
  rows: ProfitCloseDraftSeed[],
  previous: ProfitCloseDraftMap,
  dirtyBuildingIds: ReadonlySet<string>,
): ProfitCloseDraftMap {
  const next: ProfitCloseDraftMap = {};
  for (const row of rows) {
    next[row.buildingId] =
      dirtyBuildingIds.has(row.buildingId) && previous[row.buildingId]
        ? previous[row.buildingId]
        : seedDraft(row);
  }
  return next;
}

export function buildProfitCloseAdjustments(
  buildingIds: string[],
  drafts: ProfitCloseDraftMap,
  unallocatedProfitByBuilding?: Readonly<Record<string, number>>,
): ProfitCloseAdjustmentPayload[] {
  return buildingIds.map((buildingId) => {
    const draft = drafts[buildingId] ?? {
      adjustmentAmount: 0,
      adjustmentReason: "",
      unallocatedDisposition: null,
      unallocatedDispositionReason: "",
    };
    const adjustmentAmount = finiteMoney(draft.adjustmentAmount);
    const adjustmentReason = draft.adjustmentReason.trim();
    const hasResidual = unallocatedProfitByBuilding
      ? hasUnallocatedProfitResidual(unallocatedProfitByBuilding[buildingId])
      : draft.unallocatedDisposition !== null;
    const unallocatedDisposition = hasResidual
      ? normalizeUnallocatedDisposition(draft.unallocatedDisposition)
      : null;
    const unallocatedDispositionReason = hasResidual
      ? draft.unallocatedDispositionReason.trim()
      : "";
    return {
      building_id: buildingId,
      adjustment_amount: adjustmentAmount,
      adjustment_reason:
        adjustmentAmount === 0 ? null : adjustmentReason || null,
      unallocated_disposition: unallocatedDisposition,
      unallocated_disposition_reason:
        unallocatedDispositionReason || null,
    };
  });
}

export function validateProfitCloseDrafts(
  buildingIds: string[],
  drafts: ProfitCloseDraftMap,
  options: {
    reclose: boolean;
    overallReason: string;
    unallocatedProfitByBuilding?: Readonly<Record<string, number>>;
  },
): ProfitCloseValidationResult {
  const rowErrors: Record<string, string> = {};

  for (const buildingId of buildingIds) {
    const draft = drafts[buildingId];
    if (!draft || !Number.isFinite(draft.adjustmentAmount)) {
      rowErrors[buildingId] = "Số điều chỉnh không hợp lệ";
      continue;
    }
    if (
      Math.abs(draft.adjustmentAmount) > 9_999_999_999_999.99 ||
      Math.abs(
        Math.round(draft.adjustmentAmount * 100) - draft.adjustmentAmount * 100,
      ) > 1e-8
    ) {
      rowErrors[buildingId] = "Số điều chỉnh tối đa 2 chữ số thập phân";
      continue;
    }
    if (
      draft.adjustmentAmount !== 0 &&
      (draft.adjustmentReason.trim().length < 8 ||
        draft.adjustmentReason.trim().length > 500)
    ) {
      rowErrors[buildingId] = "Lý do điều chỉnh phải có 8–500 ký tự";
      continue;
    }

    const unallocatedProfit =
      options.unallocatedProfitByBuilding?.[buildingId] ?? 0;
    if (hasUnallocatedProfitResidual(unallocatedProfit)) {
      if (!normalizeUnallocatedDisposition(draft.unallocatedDisposition)) {
        rowErrors[buildingId] =
          "Phần chưa phân bổ phải chọn Giữ lại hoặc Chuyển kỳ sau";
        continue;
      }
      const dispositionReason = draft.unallocatedDispositionReason.trim();
      if (dispositionReason.length < 8 || dispositionReason.length > 500) {
        rowErrors[buildingId] =
          "Lý do xử lý phần chưa phân bổ phải có 8–500 ký tự";
      }
    }
  }

  const overallReasonError =
    options.reclose &&
    (options.overallReason.trim().length < 8 || options.overallReason.trim().length > 1000)
      ? "Lý do chốt lại phải có 8–1000 ký tự"
      : null;

  return {
    valid: Object.keys(rowErrors).length === 0 && !overallReasonError,
    overallReasonError,
    rowErrors,
  };
}
