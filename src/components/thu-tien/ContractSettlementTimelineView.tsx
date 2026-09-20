import { useState } from "react";
import "./contract-settlement.css";

export interface SettlementTimelineStepView {
  label: string;
  value: string;
  detail?: string;
  warning?: string;
}
export interface SettlementTimelineLaneView {
  id: string;
  role: "previous" | "target" | "following" | "current" | "reservation";
  code: string;
  customer: string;
  status: string;
  /** Formatted, verified facts from the data adapter; unavailable facts stay explicitly unknown. */
  steps: readonly [SettlementTimelineStepView, SettlementTimelineStepView, SettlementTimelineStepView, SettlementTimelineStepView];
}
interface Props {
  lanes: readonly SettlementTimelineLaneView[];
  hint: string;
  loading?: boolean;
  error?: string | null;
  warning?: string | null;
  onRetry?: () => void;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}
const roleLabels: Record<SettlementTimelineLaneView["role"], string> = {
  previous: "Liền trước", target: "Đang xử lý", following: "Kế tiếp", current: "Hiện tại", reservation: "Nguồn giữ chỗ",
};

/** Read-only timeline: no contract/voucher selection or financial calculations in this view. */
export function ContractSettlementTimelineView({ lanes, hint, loading = false, error, warning, onRetry, expanded: controlledExpanded, onExpandedChange }: Props) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const setExpanded = (value: boolean) => { setLocalExpanded(value); onExpandedChange?.(value); };
  const compact = lanes.filter((lane, index) => lane.role !== "following" || index === lanes.length - 1);
  const hiddenCount = lanes.length - compact.length;
  const visible = expanded ? lanes : compact;
  return <div className="cs-lifecycle">
    <div className="cs-lifecycle-heading"><h3>Vòng đời hợp đồng của phòng</h3><span>{hint}</span></div>
    {loading && <p role="status">Đang tải vòng đời hợp đồng…</p>}
    {error && <div className="cs-lifecycle-warning" role="alert">{error}{onRetry && <button className="cs-button" onClick={onRetry}>Tải lại vòng đời</button>}</div>}
    {warning && <div className="cs-lifecycle-warning" role="alert">{warning}</div>}
    {visible.map(lane => <article key={lane.id} className="cs-lifecycle-lane" data-role={lane.role} aria-label={`${roleLabels[lane.role]} · ${lane.code}`}>
      <div className="cs-lifecycle-lane-heading"><span className="cs-lifecycle-role">{roleLabels[lane.role]}</span><b className="cs-mono">{lane.code}</b><span>{lane.customer}</span><span className="cs-spacer" /><span className="cs-badge">{lane.status}</span></div>
      <div className="cs-lifecycle-steps">{lane.steps.map((step, index) => <div className="cs-lifecycle-step" key={index}>
        <div className="cs-lifecycle-step-label">{step.label}</div><div className="cs-lifecycle-step-value">{step.value}</div>
        {step.detail && <div className="cs-lifecycle-step-detail">{step.detail}</div>}{step.warning && <div className="cs-lifecycle-step-warning">{step.warning}</div>}
      </div>)}</div>
    </article>)}
    {!loading && !error && lanes.length === 0 && <p className="cs-secondary">Chưa có dữ liệu vòng đời trong phạm vi được xem.</p>}
    {hiddenCount > 0 && <button className="cs-clear" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Thu gọn dòng thời gian" : `Xem thêm ${hiddenCount} hợp đồng`}</button>}
  </div>;
}
