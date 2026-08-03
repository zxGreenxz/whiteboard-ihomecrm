import { useState } from "react";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import {
  useOpenClawDeadLetters,
  useOpenClawUnknown,
  useOpenClawUnknownAuthority,
} from "@/hooks/openclaw-zalo/useOpenClawOperations";
import {
  useOpenClawDeadLetterReplayMutation,
  useOpenClawLegalHoldMutations,
} from "@/hooks/openclaw-zalo/useOpenClawResources";
import { useOpenClawResolveUnknown } from "@/hooks/openclaw-zalo/useOpenClawMutations";
import { classifyReplayResult, type LegalHoldTargetKind, type ReplayOutcome } from "@/lib/openclaw-zalo/legalHold";
import {
  buildUnknownResolutionRequest,
  classifyResolutionFailure,
  operatorEvidenceHash,
  type ResolutionFailure,
} from "@/lib/openclaw-zalo/operations";
import type { OpenClawUnknownResolutionOutcome } from "@/lib/openclaw-zalo/types";
import OpenClawBoundaryState from "../OpenClawBoundaryState";
import OpenClawUnknownResolutionDialog, {
  type UnknownResolutionWinner,
} from "../dialogs/OpenClawUnknownResolutionDialog";
import OpenClawOperations from "./OpenClawOperations";

/**
 * What each failure means to the person who pressed the button.
 *
 * These are not interchangeable: "somebody else got there first" means reload and
 * read their outcome, while a malformed request is our bug and will fail the same
 * way however many times it is retried.
 */
const RESOLUTION_FAILURE_COPY: Record<ResolutionFailure, string> = {
  ALREADY_RESOLVED: "Người khác vừa đối chiếu tin này trước bạn. Đóng rồi mở lại để xem kết luận của họ.",
  PERMISSION_DENIED: "Bạn không có quyền vận hành để ghi nhận kết luận.",
  STALE_EVIDENCE:
    "Tin này vừa có thay đổi nên bằng chứng bạn đang xem đã cũ. Đóng rồi mở lại để đọc bằng chứng mới.",
  NEW_SEND_FAILED: "Đã ghi nhận kết luận, nhưng lần gửi mới không tạo được.",
  MALFORMED_REQUEST: "Yêu cầu gửi lên không hợp lệ — đây là lỗi của phần mềm, thử lại cũng hỏng như vậy.",
  UNKNOWN: "Chưa ghi nhận được kết luận. Thử lại sau.",
};

/** Wires the reconciliation screen and the one-time UNKNOWN resolution dialog. */
export default function OpenClawOperationsSection() {
  const { selectedOrganizationId, bootstrap, can } = useOpenClawRouteContext();
  const accountId = bootstrap.account?.accountId ?? null;
  const canManageOperations = can("manage_operations");
  const canAudit = can("audit");

  const [openUnknownId, setOpenUnknownId] = useState<string | null>(null);
  const [selectedOutcome, setSelectedOutcome] = useState<OpenClawUnknownResolutionOutcome | null>(null);
  const [observation, setObservation] = useState("");
  const [winner, setWinner] = useState<UnknownResolutionWinner | null>(null);
  const [resolutionFailure, setResolutionFailure] = useState<string | null>(null);
  const [lastReplay, setLastReplay] = useState<ReplayOutcome | null>(null);
  const [holdTargetKind, setHoldTargetKind] = useState<LegalHoldTargetKind>("ORGANIZATION");
  const [holdTargetId, setHoldTargetId] = useState("");
  const [holdReason, setHoldReason] = useState("");

  const unknownQuery = useOpenClawUnknown(selectedOrganizationId, accountId);
  const deadLetterQuery = useOpenClawDeadLetters(selectedOrganizationId, accountId);
  const replay = useOpenClawDeadLetterReplayMutation(
    selectedOrganizationId ?? "", accountId ?? "",
  );
  const legalHolds = useOpenClawLegalHoldMutations(
    selectedOrganizationId ?? "", accountId ?? "",
  );
  // Read only while the dialog is open, and never cached: the hash covers every
  // delivery attempt, so a stale one becomes a 40001 nobody can explain.
  const authority = useOpenClawUnknownAuthority(
    selectedOrganizationId, accountId, openUnknownId,
  );
  const resolveUnknown = useOpenClawResolveUnknown(
    selectedOrganizationId ?? "", accountId ?? "",
  );

  if (!bootstrap.account) return <OpenClawBoundaryState state="no-account" compact />;

  return (
    <>
      <OpenClawOperations
        // The unknown hook returns the array itself, not a page envelope, and an
        // UNKNOWN row carries no targetId - only the payload hash identifies it.
        unknownRows={(unknownQuery.data ?? []).map(item => ({
          outboxId: item.outboxId,
          payloadHash: item.payloadHash,
          terminalAt: item.terminalAt,
          resolutionOutcome: item.resolution?.outcome ?? null,
        }))}
        // Dead letters come back as a page envelope while UNKNOWN rows come back as a
        // bare array - the two hooks differ, so each is unwrapped on its own terms.
        deadLetters={(deadLetterQuery.data?.items ?? []).map(item => ({
          deadLetterId: item.deadLetterId,
          reasonCode: item.reasonCode,
          createdAt: item.createdAt,
        }))}
        loading={unknownQuery.isLoading || deadLetterQuery.isLoading}
        // A refused read must not read as "nothing to reconcile" - that is the one
        // sentence that would stop an operator looking further.
        listsUnavailable={unknownQuery.error != null || deadLetterQuery.error != null}
        canManageOperations={canManageOperations}
        canAudit={canAudit}
        busy={replay.isPending || legalHolds.create.isPending}
        lastReplay={lastReplay}
        holdTargetKind={holdTargetKind}
        holdTargetId={holdTargetId}
        holdReason={holdReason}
        onOpenUnknown={setOpenUnknownId}
        onReplayDeadLetter={deadLetterId => {
          replay.mutate({
            clientOperationId: crypto.randomUUID(),
            request: { version: 1, organizationId: selectedOrganizationId, deadLetterId },
          }, {
            // The RPC answers with one of two shapes and they mean different things,
            // so the outcome is classified rather than flattened to "done".
            onSuccess: result => setLastReplay(classifyReplayResult(result)),
          });
        }}
        onHoldTargetKindChange={setHoldTargetKind}
        onHoldTargetIdChange={setHoldTargetId}
        onHoldReasonChange={setHoldReason}
        onCreateHold={() => {
          legalHolds.create.mutate({
            clientOperationId: crypto.randomUUID(),
            request: {
              version: 1,
              organizationId: selectedOrganizationId,
              targetKind: holdTargetKind,
              targetId: holdTargetId.trim(),
              reason: holdReason.trim(),
              // Required as a key even when open-ended; the server distinguishes an
              // absent key from a null one.
              expiresAt: null,
            },
          }, {
            onSuccess: () => {
              setHoldTargetId("");
              setHoldReason("");
            },
          });
        }}
      />

      <OpenClawUnknownResolutionDialog
        open={openUnknownId !== null}
        outboxId={openUnknownId ?? ""}
        canManageOperations={canManageOperations}
        selectedOutcome={selectedOutcome}
        observation={observation}
        authorityHash={authority.data?.authorityHash ?? null}
        authorityLoading={authority.isLoading}
        authorityError={authority.error != null}
        winner={winner}
        busy={resolveUnknown.isPending}
        failureMessage={resolutionFailure}
        onSelectOutcome={setSelectedOutcome}
        onObservationChange={setObservation}
        onConfirm={() => {
          const evidence = authority.data;
          // The button is gated on this, but the gate lives in the dialog and this
          // read is what the request is actually built from.
          if (openUnknownId === null || selectedOutcome === null || !evidence) return;
          setResolutionFailure(null);
          void (async () => {
            const request = buildUnknownResolutionRequest({
              organizationId: selectedOrganizationId,
              outboxId: openUnknownId,
              outcome: selectedOutcome,
              authority: {
                authoritativeEvidenceDomain: evidence.authorityDomain,
                authoritativeEvidenceHash: evidence.authorityHash,
                resolutionVersion: evidence.resolutionVersion,
              },
              operatorEvidenceHash: await operatorEvidenceHash({
                outboxId: openUnknownId,
                outcome: selectedOutcome,
                observedAt: new Date().toISOString(),
                observation,
              }),
              newIntent: null,
            });
            resolveUnknown.mutate({
              clientOperationId: crypto.randomUUID(),
              request,
            }, {
              onSuccess: result => {
                // A 40001 makes the hook reload whoever won, so a success here can be
                // either our own resolution or somebody else's. Both are shown the
                // same way: as the outcome of record.
                setWinner({
                  resolutionId: result.resolutionId,
                  outcome: result.outcome,
                  resolvedAt: result.resolvedAt,
                  newOutboxId: result.newOutboxId ?? null,
                });
              },
              onError: error => setResolutionFailure(
                RESOLUTION_FAILURE_COPY[classifyResolutionFailure(error)],
              ),
            });
          })();
        }}
        onClose={() => {
          setOpenUnknownId(null);
          setSelectedOutcome(null);
          setObservation("");
          setWinner(null);
          setResolutionFailure(null);
        }}
      />
    </>
  );
}
