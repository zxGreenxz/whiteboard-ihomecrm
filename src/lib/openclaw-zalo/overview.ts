import type {
  OpenClawAccountSummary,
  OpenClawConnectionState,
  OpenClawControlState,
  OpenClawSessionRiskState,
} from "./types";

export type OperationalTone = "OK" | "WARN" | "STOP" | "UNKNOWN";

export interface OperationalStatus {
  tone: OperationalTone;
  /** Short text. NEVER rely on the tone alone: colour is not a label. */
  label: string;
}

const CONNECTION_STATUS: Record<OpenClawConnectionState, OperationalStatus> = {
  CONNECTED: { tone: "OK", label: "Đang kết nối" },
  QR_PENDING: { tone: "WARN", label: "Đang chờ quét QR" },
  CONNECTING: { tone: "WARN", label: "Đang kết nối lại" },
  DISCONNECTING: { tone: "WARN", label: "Đang ngắt kết nối" },
  DISCONNECTED: { tone: "STOP", label: "Mất kết nối" },
  RECONNECT_REQUIRED: { tone: "STOP", label: "Cần kết nối lại" },
};

const RISK_STATUS: Record<OpenClawSessionRiskState, OperationalStatus> = {
  HEALTHY: { tone: "OK", label: "Phiên bình thường" },
  DEGRADED: { tone: "WARN", label: "Phiên suy giảm" },
  LIMITED: { tone: "WARN", label: "Phiên bị hạn chế" },
  SUSPECTED_THEFT: { tone: "STOP", label: "Nghi phiên bị chiếm" },
  INVALID: { tone: "STOP", label: "Phiên không hợp lệ" },
};

export function connectionStatus(state: OpenClawConnectionState) {
  return CONNECTION_STATUS[state];
}

export function sessionRiskStatus(state: OpenClawSessionRiskState) {
  return RISK_STATUS[state];
}

/**
 * Whether the configured mode is the one actually in force.
 *
 * These diverge whenever something downgraded the account - acknowledging a risk
 * and beginning a QR login both force DRAFT_ONLY - and the divergence is the whole
 * point: an operator who set PROACTIVE and is getting DRAFT_ONLY needs to see that,
 * not a single "mode" field that quietly shows one of the two.
 */
export function modeStatus(account: OpenClawAccountSummary): OperationalStatus {
  if (account.configuredMode === account.effectiveMode) {
    return { tone: "OK", label: `Chế độ ${account.effectiveMode}` };
  }
  return {
    tone: "WARN",
    label: `Đặt ${account.configuredMode}, đang chạy ${account.effectiveMode}`,
  };
}

export function globalStopStatus(control: OpenClawControlState | null): OperationalStatus {
  if (control === null) return { tone: "UNKNOWN", label: "Chưa đọc được trạng thái điều khiển" };
  if (control.globalStop) return { tone: "STOP", label: "GLOBAL_STOP đang bật" };
  if (!control.featureEnabled) return { tone: "STOP", label: "Tính năng đang tắt" };
  return { tone: "OK", label: "Đang cho phép gửi" };
}

/**
 * The queue figures the overview RPC actually returns.
 *
 * Unresolved and resolved UNKNOWN are SEPARATE counts, not one number and a
 * percentage: a historically resolved UNKNOWN is settled evidence, while an
 * unresolved one is work an operator still owes. Collapsing them would hide the
 * only one that needs action.
 */
export interface OverviewCounts {
  conversationCount: number;
  unreadCount: number;
  unresolvedUnknownCount: number;
  resolvedUnknownCount: number;
  deadLetterCount: number;
}

export function unknownStatus(counts: OverviewCounts): OperationalStatus {
  if (counts.unresolvedUnknownCount === 0) {
    return { tone: "OK", label: "Không còn tin nào cần đối chiếu" };
  }
  return {
    tone: "WARN",
    label: `${counts.unresolvedUnknownCount} tin cần đối chiếu`,
  };
}

export function deadLetterStatus(counts: OverviewCounts): OperationalStatus {
  return counts.deadLetterCount === 0
    ? { tone: "OK", label: "Không có dead-letter" }
    : { tone: "WARN", label: `${counts.deadLetterCount} dead-letter` };
}

/**
 * Metrics a health event carried, flattened for display.
 *
 * `contentFreeMetrics` is a free-form jsonb record: the schema constrains it to
 * scalars and nested values but names no keys, so the browser cannot promise that
 * CPU, RAM, disk, spool age or queue lag will be present. Rendering whatever
 * arrived, labelled by its own key, is honest; a fixed dashboard of named gauges
 * would show zeros for metrics the cell never reported.
 */
export function displayableMetrics(
  contentFreeMetrics: Record<string, unknown>,
): readonly { key: string; value: string }[] {
  return Object.entries(contentFreeMetrics)
    .filter(([, value]) => typeof value === "number" || typeof value === "string"
      || typeof value === "boolean")
    .map(([key, value]) => ({ key, value: String(value) }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

/**
 * Figures the plan asks for that NO read path provides.
 *
 * Listed rather than rendered as zeros. A dashboard tile reading "0 ms p95" when
 * nothing measures p95 is worse than an empty screen: it invites an operator to
 * conclude the system is fast.
 */
export const OVERVIEW_UNAVAILABLE = [
  { key: "queueLagP95", label: "Độ trễ hàng đợi p95" },
  { key: "transferQuota", label: "Hạn mức truyền tải" },
  { key: "supabaseEgress", label: "Băng thông Supabase" },
  { key: "objectStorage", label: "Yêu cầu và dung lượng R2" },
  // auditVerification is NOT here: openclaw_list_audit_events_v1 returns all four
  // inputs to the event hash, so the chain is recomputable in the browser. See
  // auditChain.ts; the tile states what that check does and does not prove.
  { key: "lastRestoreDrill", label: "Lần diễn tập khôi phục gần nhất" },
] as const;
