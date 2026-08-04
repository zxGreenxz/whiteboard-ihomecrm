import {
  connectionStatus,
  deadLetterStatus,
  displayableMetrics,
  globalStopStatus,
  modeStatus,
  OVERVIEW_UNAVAILABLE,
  sessionRiskStatus,
  unknownStatus,
  type OperationalStatus,
  type OverviewCounts,
} from "@/lib/openclaw-zalo/overview";
import {
  AUDIT_CHAIN_LIMITATION,
  type AuditChainVerdict,
} from "@/lib/openclaw-zalo/auditChain";
import type { OpenClawAccountSummary, OpenClawControlState } from "@/lib/openclaw-zalo/types";

export interface HealthIncidentView {
  healthEventId: string;
  severity: string;
  healthKind: string;
  status: string;
  observedAt: string;
  contentFreeMetrics: Record<string, unknown>;
}

interface OpenClawOverviewProps {
  account: OpenClawAccountSummary;
  control: OpenClawControlState | null;
  counts: OverviewCounts | null;
  incidents: readonly HealthIncidentView[];
  /** True when the incident query itself failed - usually a missing `audit` permission. */
  incidentsUnavailable: boolean;
  loading: boolean;
  canManageOperations: boolean;
  /** Reading the audit log needs the audit permission; without it there is nothing to verify. */
  canAudit: boolean;
  /** Null while unread or unreadable - NOT the same as a chain that verified. */
  auditChain: AuditChainVerdict | null;
  onOpenGlobalStop: () => void;
}

/** Icon AND text, always. Colour alone is not a label. */
const TONE_ICON = { OK: "✓", WARN: "!", STOP: "■", UNKNOWN: "?" } as const;

function StatusLine({ status, name }: { status: OperationalStatus; name: string }) {
  return (
    <p className="flex items-baseline gap-2 text-sm" data-openclaw-status={name}>
      <span
        aria-hidden="true"
        data-openclaw-tone={status.tone}
        className="inline-block w-4 text-center font-black"
      >
        {TONE_ICON[status.tone]}
      </span>
      <span>
        <span className="sr-only">{status.tone}: </span>
        {status.label}
      </span>
    </p>
  );
}

export default function OpenClawOverview(props: OpenClawOverviewProps) {
  return (
    <div className="grid gap-4 p-4" data-openclaw-overview="root">
      <section className="border border-[#cbd5df] bg-white p-4">
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#607585]">
          Kết nối và chế độ
        </h2>
        <div className="mt-2 grid gap-1">
          <StatusLine name="connection" status={connectionStatus(props.account.connectionState)} />
          <StatusLine name="session-risk" status={sessionRiskStatus(props.account.sessionRiskState)} />
          <StatusLine name="mode" status={modeStatus(props.account)} />
          <StatusLine name="global-stop" status={globalStopStatus(props.control)} />
        </div>
        <p className="mt-2 font-mono text-xs text-[#607585]">
          cell {props.account.currentCellId ?? "—"} · phiên v{props.account.sessionGeneration} ·
          kết nối v{props.account.connectionGeneration}
        </p>
        {props.canManageOperations && (
          <button
            type="button"
            onClick={props.onOpenGlobalStop}
            data-openclaw-action="open-global-stop"
            className="mt-3 min-h-11 w-full border border-[#c0563a] bg-white px-4 text-sm font-bold text-[#8a2f1c]"
          >
            Dừng toàn bộ việc gửi…
          </button>
        )}
      </section>

      <section className="border border-[#cbd5df] bg-white p-4">
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#607585]">
          Hàng đợi và đối chiếu
        </h2>
        {props.counts === null ? (
          <p data-openclaw-overview="counts-unavailable" className="mt-2 text-sm text-[#607585]">
            {props.loading ? "Đang tải số liệu…" : "Chưa đọc được số liệu tổng quan."}
          </p>
        ) : (
          <div className="mt-2 grid gap-1">
            <StatusLine name="unknown" status={unknownStatus(props.counts)} />
            <StatusLine name="dead-letter" status={deadLetterStatus(props.counts)} />
            {/* Separate on purpose: a resolved UNKNOWN is settled evidence, an
                unresolved one is work still owed. One combined number would hide
                the only one that needs action. */}
            <p className="text-sm" data-openclaw-overview="resolved-unknown">
              Đã đối chiếu trong quá khứ: {props.counts.resolvedUnknownCount}
            </p>
            <p className="text-sm" data-openclaw-overview="conversations">
              {props.counts.conversationCount} hội thoại · {props.counts.unreadCount} chưa đọc
            </p>
          </div>
        )}
      </section>

      <section className="border border-[#cbd5df] bg-white p-4">
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#607585]">
          Sự cố gần đây
        </h2>
        {props.incidentsUnavailable ? (
          // "No incidents recorded" for a member who simply cannot READ incidents is
          // a false all-clear, and this is the default landing section - so every
          // view-only member was being told the system was healthy.
          <p
            data-openclaw-overview="incidents-unavailable"
            className="mt-2 text-sm font-bold text-[#8a4b12]"
          >
            Không đọc được nhật ký sự cố. Mục này cần quyền kiểm toán; đây KHÔNG phải là
            &quot;không có sự cố&quot;.
          </p>
        ) : props.incidents.length === 0 ? (
          <p data-openclaw-overview="no-incidents" className="mt-2 text-sm text-[#607585]">
            Chưa ghi nhận sự cố nào.
          </p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {props.incidents.map(incident => (
              <li
                key={incident.healthEventId}
                data-openclaw-incident={incident.healthEventId}
                className="border border-[#e2e8ee] p-2"
              >
                <p className="text-sm font-bold">
                  {incident.severity} · {incident.healthKind} · {incident.status}
                </p>
                <p className="mt-1 font-mono text-xs text-[#607585]">{incident.observedAt}</p>
                {/* Rendered by whatever key arrived. `contentFreeMetrics` names no
                    keys in its schema, so a fixed dashboard of named gauges would
                    show zeros for metrics the cell never reported. */}
                <ul className="mt-1 grid gap-0.5">
                  {displayableMetrics(incident.contentFreeMetrics).map(metric => (
                    <li key={metric.key} className="font-mono text-xs text-[#526777]">
                      {metric.key}: {metric.value}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="border border-[#cbd5df] bg-white p-4">
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#607585]">
          Kiểm chứng chuỗi nhật ký kiểm toán
        </h2>
        {props.auditChain === null ? (
          <p data-openclaw-audit-chain="unavailable" className="mt-2 text-sm font-bold text-[#8a4b12]">
            {props.canAudit
              ? "Chưa đọc được nhật ký kiểm toán, nên chưa kiểm chứng được."
              : "Cần quyền kiểm toán để đọc và kiểm chứng chuỗi này."}
          </p>
        ) : props.auditChain.checkedCount === 0 ? (
          // "Nothing to check" must not read as "checked and fine".
          <p data-openclaw-audit-chain="empty" className="mt-2 text-sm text-[#607585]">
            Chưa có sự kiện kiểm toán nào để kiểm chứng.
          </p>
        ) : (
          <>
            <p
              data-openclaw-audit-chain={props.auditChain.intact ? "INTACT" : "BROKEN"}
              data-openclaw-tone={props.auditChain.intact ? "OK" : "STOP"}
              className={`mt-2 text-sm font-bold ${
                props.auditChain.intact ? "text-[#0f766e]" : "text-[#8a2f1c]"
              }`}
            >
              {props.auditChain.intact
                ? `✓ Tính lại khớp cho ${props.auditChain.checkedCount} sự kiện `
                  + `(bản ${props.auditChain.fromSequence}–${props.auditChain.toSequence}), `
                  + `${props.auditChain.linkedCount} mối nối liền mạch.`
                : `✗ Chuỗi có vấn đề ở ${props.auditChain.findings.length} chỗ trong `
                  + `${props.auditChain.checkedCount} sự kiện đọc được.`}
            </p>
            {props.auditChain.findings.length > 0 && (
              <ul className="mt-1 grid gap-0.5">
                {props.auditChain.findings.map((finding, index) => (
                  <li
                    key={`${finding.kind}-${index}`}
                    data-openclaw-audit-finding={finding.kind}
                    className="font-mono text-xs text-[#8a2f1c]"
                  >
                    {finding.kind === "SEQUENCE_GAP"
                      ? `Thiếu sự kiện giữa bản ${finding.fromSequence} và ${finding.toSequence}`
                      : `${finding.kind} tại bản ${finding.organizationSequence}`}
                  </li>
                ))}
              </ul>
            )}
            {/* Required, not optional: without it "✓ verified" overstates what a
                browser can see, and an auditor could rely on the wrong assurance. */}
            <p data-openclaw-audit-chain="limitation" className="mt-2 text-xs leading-5 text-[#607585]">
              {AUDIT_CHAIN_LIMITATION}
            </p>
          </>
        )}
      </section>

      <section className="border border-[#cbd5df] bg-white p-4">
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#607585]">
          Chưa đo được từ giao diện
        </h2>
        {/* Listed, not rendered as zeros. A tile reading "0 ms p95" when nothing
            measures p95 invites the operator to conclude the system is fast. */}
        <ul className="mt-2 grid gap-0.5">
          {OVERVIEW_UNAVAILABLE.map(item => (
            <li
              key={item.key}
              data-openclaw-unavailable={item.key}
              className="text-xs leading-5 text-[#607585]"
            >
              {item.label}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs leading-5 text-[#607585]">
          Những mục trên chưa có đường đọc nào cho trình duyệt. Hiển thị số 0 ở đây sẽ khiến bạn
          tin là đã đo và mọi thứ đều ổn.
        </p>
      </section>
    </div>
  );
}
