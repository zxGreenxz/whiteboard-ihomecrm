export type ProfitUnallocatedDisposition =
  | "RETAINED_EARNINGS"
  | "CARRY_FORWARD";

// Tháng chốt TRƯỚC V3 được migration 20260721110000 đánh dấu giá trị này (CHECK
// của profit_monthly cho phép). Chỉ để ĐỌC: lượt chốt mới/chốt lại phải chọn một
// trong hai giá trị trên (normalizeUnallocatedDisposition trả null cho giá trị cũ).
export const LEGACY_UNALLOCATED_DISPOSITION = "LEGACY_RETAINED_UNALLOCATED";
export type ProfitStoredUnallocatedDisposition =
  | ProfitUnallocatedDisposition
  | typeof LEGACY_UNALLOCATED_DISPOSITION;

export function unallocatedDispositionLabel(
  disposition: ProfitStoredUnallocatedDisposition | null | undefined,
): string {
  if (disposition === "RETAINED_EARNINGS") return "Giữ lại lợi nhuận";
  if (disposition === "CARRY_FORWARD") return "Chuyển kỳ sau";
  if (disposition === LEGACY_UNALLOCATED_DISPOSITION) return "Giữ lại (chốt kiểu cũ)";
  return "Chưa chọn";
}

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

// ── Lý do chép nguyên câu báo lỗi (F60, rà 21/10) ─────────────────────
//
// Luật cũ chỉ đo ĐỘ DÀI 8–500 ký tự, mà chính câu báo lỗi "Lý do xử lý phải có
// 8–500 ký tự" dài 31 ký tự ⇒ dán nó vào ô lý do là qua. Dữ liệu thật đã có 6 dòng
// chốt T7 mang đúng câu đó làm lý do giữ lại — nhật ký chốt mất nghĩa. Client từ
// chối khi cả ô chỉ là một câu báo lỗi/gợi ý của màn này (hoặc một câu luật độ dài).
// Máy chủ KHÔNG kiểm điều này (không sửa hàm SQL nào) — đây là lưới phía giao diện.

/** Câu báo lỗi / gợi ý mà màn chốt lợi nhuận hiện ra cho người dùng. */
const PROFIT_SYSTEM_MESSAGES: readonly string[] = [
  "Số điều chỉnh không hợp lệ",
  "Số điều chỉnh tối đa 2 chữ số thập phân",
  "Lý do điều chỉnh phải có 8–500 ký tự",
  "Phần chưa phân bổ phải chọn Giữ lại hoặc Chuyển kỳ sau",
  "Lý do xử lý phần chưa phân bổ phải có 8–500 ký tự",
  "Lý do xử lý phải có 8–500 ký tự",
  "Chọn cách xử lý phần chưa phân bổ",
  "Chọn cách xử lý",
  "Cách xử lý phần chưa phân bổ không hợp lệ",
  "Lý do chốt lại phải có 8–1000 ký tự",
  "Lý do mở khoá phải có 8–1000 ký tự",
  "Lý do đặt lại phải có 8–1000 ký tự",
  "Lý do cần có 8–1000 ký tự.",
  "Nhập lý do đặt lại từ 8 đến 1000 ký tự.",
  "Nhập lý do mở khóa từ 8 đến 1000 ký tự.",
  "Chọn ít nhất một nhà để chốt",
  "Vùng chọn đang lẫn nhà đã chốt và nhà chưa chốt — tách làm hai lượt",
  "Chưa xác nhận được dữ liệu nguồn. Tải lại số liệu trước khi chốt.",
  "Đang cập nhật preview theo điều chỉnh mới nhất",
  "Lý do (ít nhất 8 ký tự)",
  "Lý do xử lý (ít nhất 8 ký tự)",
  "Không bắt buộc",
  "Không bắt buộc cho lần chốt đầu",
  "Bắt buộc: lý do đặt lại",
  "Bắt buộc: mô tả vì sao cần thay snapshot đã chốt",
  "reason must contain 8..1000 characters",
];

/** Câu báo khi ô lý do chỉ là câu báo lỗi — CHÍNH chúng cũng bị từ chối nếu bị dán lại. */
export const ADJUSTMENT_REASON_SYSTEM_MESSAGE =
  "Lý do điều chỉnh đang chép câu báo lỗi của hệ thống — ghi lý do thật";
export const UNALLOCATED_REASON_SYSTEM_MESSAGE =
  "Lý do xử lý phần chưa phân bổ đang chép câu báo lỗi của hệ thống — ghi lý do thật";
export const RECLOSE_REASON_SYSTEM_MESSAGE =
  "Lý do chốt lại đang chép câu báo lỗi của hệ thống — ghi lý do thật";
export const CLOSE_NOTE_SYSTEM_MESSAGE =
  "Ghi chú lần chốt đang chép câu báo lỗi của hệ thống — ghi nội dung thật hoặc để trống";
export const UNLOCK_REASON_SYSTEM_MESSAGE =
  "Lý do mở khoá đang chép câu báo lỗi của hệ thống — ghi lý do thật";
export const RESET_REASON_SYSTEM_MESSAGE =
  "Lý do đặt lại đang chép câu báo lỗi của hệ thống — ghi lý do thật";

/** Chuẩn hoá để so: NFC, chữ thường, gạch ngang/khoảng trắng gom một kiểu, bỏ dấu câu cuối,
 *  dấu thanh kiểu cũ "khóa" ≡ kiểu mới "khoá". */
export function normalizeReasonText(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/óa/g, "oá")
    .replace(/òa/g, "oà")
    .replace(/ỏa/g, "oả")
    .replace(/õa/g, "oã")
    .replace(/ọa/g, "oạ")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .trim()
    .replace(/^["'“”‘’\s]+/u, "")
    .replace(/["'“”‘’\s.!?…:;,]+$/u, "");
}

const KNOWN_SYSTEM_MESSAGES: ReadonlySet<string> = new Set(
  [
    ...PROFIT_SYSTEM_MESSAGES,
    ADJUSTMENT_REASON_SYSTEM_MESSAGE,
    UNALLOCATED_REASON_SYSTEM_MESSAGE,
    RECLOSE_REASON_SYSTEM_MESSAGE,
    CLOSE_NOTE_SYSTEM_MESSAGE,
    UNLOCK_REASON_SYSTEM_MESSAGE,
    RESET_REASON_SYSTEM_MESSAGE,
  ].map(normalizeReasonText),
);

/** Câu NGẮN chỉ nói luật độ dài / chỉ là lời từ chối của màn này. */
const SYSTEM_MESSAGE_PATTERNS: readonly RegExp[] = [
  /(phải|cần) có \d+-\d+ ký tự$/u,
  /từ \d+ đến \d+ ký tự$/u,
  /\(?ít nhất \d+ ký tự\)?$/u,
  /\d+\.\.\d+ characters$/u,
  /đang chép câu báo lỗi/u,
];

/** true khi CẢ ô lý do chỉ là một câu báo lỗi / gợi ý của hệ thống, không phải lý do thật. */
export function isSystemMessageReason(text: string): boolean {
  const normalized = normalizeReasonText(text);
  if (!normalized) return false;
  if (KNOWN_SYSTEM_MESSAGES.has(normalized)) return true;
  if (normalized.length > 120) return false;
  return SYSTEM_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export type ReasonProblem = "LENGTH" | "SYSTEM_MESSAGE";

/** Lỗi của một ô lý do bắt buộc: độ dài (sau cắt khoảng trắng) hoặc chép câu báo lỗi. */
export function reasonProblem(text: string, min: number, max: number): ReasonProblem | null {
  const trimmed = text.trim();
  if (trimmed.length < min || trimmed.length > max) return "LENGTH";
  return isSystemMessageReason(trimmed) ? "SYSTEM_MESSAGE" : null;
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
    if (draft.adjustmentAmount !== 0) {
      const problem = reasonProblem(draft.adjustmentReason, 8, 500);
      if (problem) {
        rowErrors[buildingId] =
          problem === "LENGTH"
            ? "Lý do điều chỉnh phải có 8–500 ký tự"
            : ADJUSTMENT_REASON_SYSTEM_MESSAGE;
        continue;
      }
    }

    const unallocatedProfit =
      options.unallocatedProfitByBuilding?.[buildingId] ?? 0;
    if (hasUnallocatedProfitResidual(unallocatedProfit)) {
      if (!normalizeUnallocatedDisposition(draft.unallocatedDisposition)) {
        rowErrors[buildingId] =
          "Phần chưa phân bổ phải chọn Giữ lại hoặc Chuyển kỳ sau";
        continue;
      }
      const problem = reasonProblem(draft.unallocatedDispositionReason, 8, 500);
      if (problem) {
        rowErrors[buildingId] =
          problem === "LENGTH"
            ? "Lý do xử lý phần chưa phân bổ phải có 8–500 ký tự"
            : UNALLOCATED_REASON_SYSTEM_MESSAGE;
      }
    }
  }

  const overallProblem = options.reclose
    ? reasonProblem(options.overallReason, 8, 1000)
    : isSystemMessageReason(options.overallReason)
      ? "SYSTEM_MESSAGE"
      : null;
  const overallReasonError =
    overallProblem === "LENGTH"
      ? "Lý do chốt lại phải có 8–1000 ký tự"
      : overallProblem === "SYSTEM_MESSAGE"
        ? options.reclose
          ? RECLOSE_REASON_SYSTEM_MESSAGE
          : CLOSE_NOTE_SYSTEM_MESSAGE
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
