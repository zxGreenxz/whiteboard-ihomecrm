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

// ── Chốt theo từng nhà ────────────────────────────────────────────────
//
// Quy tắc lương điều hành `TOTAL_GROUP` chia một khoản cho CẢ NHÓM nhà theo lợi
// nhuận từng nhà. Chốt nửa nhóm thì phần lương của cả nhóm bị dồn sai vào phần
// nhà đã chốt — server từ chối bằng `[TOTAL_GROUP_KHONG_DU]`. Ở client ta mở
// rộng vùng chọn TRƯỚC, để người dùng không điền xong lý do cho từng nhà rồi mới
// ăn lỗi.

export interface TotalGroupPeerEntry {
  peerIds: string[];
  peerNames: string;
  ruleLabels: string;
}

export type TotalGroupPeerMap = Record<string, TotalGroupPeerEntry>;

export interface TotalGroupExpansion {
  buildingIds: string[];
  added: string[];
}

/**
 * Bao đóng bắc cầu của vùng chọn theo nhóm TOTAL_GROUP.
 *
 * Bắc cầu chứ không phải một vòng: một nhà có thể nằm trong hai quy tắc khác
 * nhau, kéo theo nhà thứ ba vốn không dính quy tắc đầu. Lặp tới điểm bất động.
 */
export function expandTotalGroupSelection(
  selected: readonly string[],
  peers: TotalGroupPeerMap,
): TotalGroupExpansion {
  const result = new Set(selected);
  const queue = [...result];
  const added: string[] = [];

  while (queue.length > 0) {
    const buildingId = queue.pop() as string;
    for (const peerId of peers[buildingId]?.peerIds ?? []) {
      if (result.has(peerId)) continue;
      result.add(peerId);
      added.push(peerId);
      queue.push(peerId);
    }
  }

  return { buildingIds: [...result].sort(), added: added.sort() };
}

/**
 * Nhà nào đang kéo nhà nào vào — dùng dựng câu giải thích cho người dùng.
 * Trả về entry của nhà ĐẦU TIÊN trong vùng chọn có peer bị thêm vào.
 */
export function describeTotalGroupExpansion(
  selected: readonly string[],
  added: readonly string[],
  peers: TotalGroupPeerMap,
): TotalGroupPeerEntry | null {
  if (added.length === 0) return null;
  for (const buildingId of selected) {
    const entry = peers[buildingId];
    if (entry && added.some((peerId) => entry.peerIds.includes(peerId))) {
      return entry;
    }
  }
  return null;
}

export type ProfitCloseAction = "CLOSE" | "RECLOSE" | "MIXED" | "EMPTY";

export interface ProfitCloseStatusRow {
  building_id: string;
  current_snapshot: { status: "DRAFT" | "LOCKED" } | null;
}

/**
 * CLOSE và RECLOSE là hai RPC riêng, mỗi cái đòi trạng thái ĐỒNG NHẤT trong tập
 * ghi (`profit_close_v2` từ chối nếu có nhà đã LOCKED; `profit_reclose_v2` đòi
 * mọi nhà đều LOCKED). Nên vùng chọn lẫn hai trạng thái là không hợp lệ — nói
 * thẳng ở client thay vì để server trả lỗi tiếng Anh.
 */
export function resolveCloseAction(
  rows: readonly ProfitCloseStatusRow[],
): ProfitCloseAction {
  if (rows.length === 0) return "EMPTY";
  let locked = 0;
  for (const row of rows) {
    if (row.current_snapshot?.status === "LOCKED") locked += 1;
  }
  if (locked === 0) return "CLOSE";
  if (locked === rows.length) return "RECLOSE";
  return "MIXED";
}
