import { useState } from "react";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import {
  useOpenClawDeadLetters,
  useOpenClawUnknown,
} from "@/hooks/openclaw-zalo/useOpenClawOperations";
import {
  useOpenClawDeadLetterReplayMutation,
  useOpenClawLegalHoldMutations,
} from "@/hooks/openclaw-zalo/useOpenClawResources";
import { classifyReplayResult, type LegalHoldTargetKind, type ReplayOutcome } from "@/lib/openclaw-zalo/legalHold";
import OpenClawBoundaryState from "../OpenClawBoundaryState";
import OpenClawUnknownResolutionDialog from "../dialogs/OpenClawUnknownResolutionDialog";
import OpenClawOperations from "./OpenClawOperations";

/** Wires the reconciliation screen and the one-time UNKNOWN resolution dialog. */
export default function OpenClawOperationsSection() {
  const { selectedOrganizationId, bootstrap, can } = useOpenClawRouteContext();
  const accountId = bootstrap.account?.accountId ?? null;
  const canManageOperations = can("manage_operations");
  const canAudit = can("audit");

  const [openUnknownId, setOpenUnknownId] = useState<string | null>(null);
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
        selectedOutcome={null}
        // The winner is shown once the resolution hook reloads it after a 40001;
        // until the outcome selection is wired, this dialog is read-only.
        winner={null}
        busy={false}
        onSelectOutcome={() => undefined}
        onConfirm={() => undefined}
        onClose={() => setOpenUnknownId(null)}
      />
    </>
  );
}
