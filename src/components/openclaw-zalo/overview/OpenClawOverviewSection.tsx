import { useEffect, useState } from "react";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import { useOpenClawOverview } from "@/hooks/openclaw-zalo/useOpenClawOverview";
import {
  useOpenClawAuditEvents,
  useOpenClawHealthEvents,
} from "@/hooks/openclaw-zalo/useOpenClawOperations";
import { useOpenClawSetControlState } from "@/hooks/openclaw-zalo/useOpenClawMutations";
import { verifyAuditChain, type AuditChainVerdict } from "@/lib/openclaw-zalo/auditChain";
import OpenClawBoundaryState from "../OpenClawBoundaryState";
import OpenClawGlobalStopDialog from "../dialogs/OpenClawGlobalStopDialog";
import OpenClawOverview from "./OpenClawOverview";

/** Wires the operational overview and the emergency stop it can open. */
export default function OpenClawOverviewSection() {
  const { selectedOrganizationId, organization, bootstrap, can } = useOpenClawRouteContext();
  const account = bootstrap.account;
  const accountId = account?.accountId ?? null;
  const canManageOperations = can("manage_operations");
  const [stopOpen, setStopOpen] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState("");
  const [stopFailure, setStopFailure] = useState<string | null>(null);

  const overviewQuery = useOpenClawOverview(selectedOrganizationId, accountId);
  const healthQuery = useOpenClawHealthEvents(selectedOrganizationId, accountId, 10);
  const auditQuery = useOpenClawAuditEvents(selectedOrganizationId, accountId, 50);
  const [auditChain, setAuditChain] = useState<AuditChainVerdict | null>(null);

  // Verification is async (SHA-256 via WebCrypto), so it runs as an effect rather
  // than during render. It is deliberately recomputed on every fetch: a verdict
  // held over from an earlier page would claim assurance about rows nobody checked.
  const auditItems = auditQuery.data?.items;
  useEffect(() => {
    if (auditItems === undefined) {
      setAuditChain(null);
      return;
    }
    let cancelled = false;
    void verifyAuditChain(auditItems.map(item => ({
      auditEventId: item.auditEventId,
      organizationSequence: item.organizationSequence,
      eventType: item.eventType,
      evidenceHash: item.evidenceHash,
      previousHash: item.previousHash,
      eventHash: item.eventHash,
    }))).then(verdict => {
      if (!cancelled) setAuditChain(verdict);
    });
    return () => { cancelled = true; };
  }, [auditItems]);
  const setControlState = useOpenClawSetControlState(
    selectedOrganizationId ?? "", accountId ?? "",
  );

  if (!account) return <OpenClawBoundaryState state="no-account" compact />;

  return (
    <>
      <OpenClawOverview
        account={account}
        control={bootstrap.control}
        counts={overviewQuery.data ?? null}
        // A failed read is NOT "no incidents". This is the default landing section, so
        // that distinction decides whether every view-only member is told the system
        // is healthy.
        incidentsUnavailable={healthQuery.error != null}
        incidents={(healthQuery.data?.items ?? []).map(item => ({
          healthEventId: item.healthEventId,
          severity: item.severity,
          healthKind: item.healthKind,
          status: item.status,
          observedAt: item.observedAt,
          contentFreeMetrics: item.contentFreeMetrics,
        }))}
        loading={overviewQuery.isLoading}
        canManageOperations={canManageOperations}
        canAudit={can("audit")}
        auditChain={auditChain}
        onOpenGlobalStop={() => {
          // The phrase is retyped every time. Carrying it over between openings
          // would turn a deliberate confirmation into a second click.
          setTypedConfirmation("");
          setStopOpen(true);
        }}
      />

      <OpenClawGlobalStopDialog
        open={stopOpen}
        organizationName={organization.name}
        canManageOperations={canManageOperations}
        alreadyStopped={bootstrap.control?.globalStop === true}
        typedConfirmation={typedConfirmation}
        busy={setControlState.isPending}
        failureMessage={stopFailure}
        onTypedConfirmationChange={setTypedConfirmation}
        onConfirm={() => {
          const control = bootstrap.control;
          if (control === null) {
            // The gate cannot see this, so without the message the button would be
            // enabled and the click would do nothing at all.
            setStopFailure("Chưa đọc được trạng thái điều khiển hiện tại. Tải lại trang rồi thử lại.");
            return;
          }
          setStopFailure(null);
          setControlState.mutate({
            clientOperationId: crypto.randomUUID(),
            request: {
              version: 1,
              organizationId: selectedOrganizationId,
              // Compare-and-set on the version the operator is looking at: if
              // somebody else changed the controls meanwhile, the server refuses
              // rather than stamping over a decision nobody reviewed.
              expectedControlVersion: control.controlVersion,
              globalStop: true,
              reasonCode: "OPERATOR_EMERGENCY_STOP",
            },
          }, {
            onSuccess: () => setStopOpen(false),
            // Silence on the one control whose entire purpose is a panic button is the
            // worst possible outcome: the operator cannot tell whether sending stopped.
            onError: error => setStopFailure(
              (error as { code?: string })?.code === "40001"
                ? "Ai đó vừa đổi cấu hình điều khiển. Tải lại trang rồi thử lại."
                : "Không dừng được. Tin vẫn có thể đang được gửi — thử lại hoặc báo vận hành.",
            ),
          });
        }}
        onClose={() => setStopOpen(false)}
      />
    </>
  );
}
