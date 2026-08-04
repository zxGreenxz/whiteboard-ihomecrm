import { useState } from "react";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import {
  useOpenClawDeadLetters,
  useOpenClawLegalHolds,
  useOpenClawUnknown,
  useOpenClawUnknownAuthority,
} from "@/hooks/openclaw-zalo/useOpenClawOperations";
import {
  useOpenClawDeadLetterReplayMutation,
  useOpenClawLegalHoldMutations,
} from "@/hooks/openclaw-zalo/useOpenClawResources";
import { useOpenClawResolveUnknown } from "@/hooks/openclaw-zalo/useOpenClawMutations";
import {
  classifyLegalHoldFailure,
  classifyReplayResult,
  type LegalHoldFailure,
  type LegalHoldTargetKind,
  type ReplayOutcome,
} from "@/lib/openclaw-zalo/legalHold";
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

/** What a legal-hold write failed with, in words the operator can act on. */
const LEGAL_HOLD_FAILURE_COPY: Record<LegalHoldFailure, string> = {
  ALREADY_HELD: "Đối tượng này đã có một lệnh giữ đang hiệu lực — không cần tạo thêm.",
  PERMISSION_DENIED: "Bị từ chối: cần đủ quyền kiểm toán, quyền vận hành, và là chủ sở hữu tổ chức đang hoạt động.",
  VERSION_CONFLICT: "Lệnh giữ vừa thay đổi (có thể ai đó đã gỡ trước). Tải lại danh sách rồi thử lại.",
  NOT_FOUND: "Không tìm thấy lệnh giữ này nữa.",
  UNKNOWN: "Chưa thực hiện được thao tác với lệnh giữ. Thử lại sau.",
};

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
  const [holdFailure, setHoldFailure] = useState<string | null>(null);
  const [replayFailure, setReplayFailure] = useState<string | null>(null);
  const [releasingHoldId, setReleasingHoldId] = useState<string | null>(null);
  const [releaseReason, setReleaseReason] = useState("");

  const unknownQuery = useOpenClawUnknown(selectedOrganizationId, accountId);
  const deadLetterQuery = useOpenClawDeadLetters(selectedOrganizationId, accountId);
  const holdsQuery = useOpenClawLegalHolds(selectedOrganizationId, accountId);
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
        isActiveOwner={bootstrap.isActiveOwner}
        busy={replay.isPending || legalHolds.create.isPending || legalHolds.release.isPending}
        lastReplay={lastReplay}
        replayFailure={replayFailure}
        holdTargetKind={holdTargetKind}
        holdTargetId={holdTargetId}
        holdReason={holdReason}
        holds={(holdsQuery.data?.items ?? []).map(hold => ({
          holdId: hold.holdId,
          targetKind: hold.targetKind,
          targetId: hold.targetId,
          reason: hold.reason,
          holdVersion: hold.holdVersion,
          createdAt: hold.createdAt,
          expiresAt: hold.expiresAt ?? null,
          releasedAt: hold.releasedAt ?? null,
          releaseReason: hold.releaseReason ?? null,
        }))}
        holdsLoading={holdsQuery.isLoading}
        holdsUnavailable={holdsQuery.error != null}
        holdFailure={holdFailure}
        releasingHoldId={releasingHoldId}
        releaseReason={releaseReason}
        onOpenUnknown={setOpenUnknownId}
        onReplayDeadLetter={deadLetterId => {
          setReplayFailure(null);
          replay.mutate({
            clientOperationId: crypto.randomUUID(),
            request: { version: 1, organizationId: selectedOrganizationId, deadLetterId },
          }, {
            // The RPC answers with one of two shapes and they mean different things,
            // so the outcome is classified rather than flattened to "done".
            onSuccess: result => setLastReplay(classifyReplayResult(result)),
            onError: () => setReplayFailure(
              "Chưa phát lại được dead-letter này. Không có tin nào được tạo; thử lại sau.",
            ),
          });
        }}
        onHoldTargetKindChange={setHoldTargetKind}
        onHoldTargetIdChange={setHoldTargetId}
        onHoldReasonChange={setHoldReason}
        onCreateHold={() => {
          setHoldFailure(null);
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
            onError: error => setHoldFailure(
              LEGAL_HOLD_FAILURE_COPY[classifyLegalHoldFailure(error)],
            ),
          });
        }}
        onSelectHoldForRelease={holdId => {
          setReleasingHoldId(holdId);
          setReleaseReason("");
          setHoldFailure(null);
        }}
        onReleaseReasonChange={setReleaseReason}
        onReleaseHold={hold => {
          setHoldFailure(null);
          legalHolds.release.mutate({
            clientOperationId: crypto.randomUUID(),
            request: {
              version: 1,
              organizationId: selectedOrganizationId,
              holdId: hold.holdId,
              // The server compares this against the stored version and refuses a
              // mismatch with 40001, so it comes from the row being shown rather
              // than from a counter this component keeps.
              expectedHoldVersion: hold.holdVersion,
              releaseReason: releaseReason.trim(),
            },
          }, {
            onSuccess: () => {
              setReleasingHoldId(null);
              setReleaseReason("");
            },
            onError: error => setHoldFailure(
              LEGAL_HOLD_FAILURE_COPY[classifyLegalHoldFailure(error)],
            ),
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
