import { useCallback, useEffect, useState } from "react";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import {
  useOpenClawAcknowledgeDisclosure,
  useOpenClawBeginQrLogin,
} from "@/hooks/openclaw-zalo/useOpenClawMutations";
import { useOpenClawQrPoll } from "@/hooks/openclaw-zalo/useOpenClawResources";
import { qrCountdownSeconds, qrGateState } from "@/lib/openclaw-zalo/connection";
import OpenClawConnectionDialog from "./OpenClawConnectionDialog";

interface OpenClawConnectionSectionProps {
  open: boolean;
  onClose: () => void;
}

/** SHA-256 hex of a string, using Web Crypto - no dependency, no polyfill. */
async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Owns the QR lifetime.
 *
 * The nonce is generated here and its HASH is what leaves the browser; the challenge
 * itself is component state and nothing else. It is dropped on close, on expiry, on
 * success, and whenever the organization or account changes - which is every reason
 * in `qrClearReasons()` that this component can observe, with route unmount and
 * logout covered by the component being torn down.
 */
export default function OpenClawConnectionSection({
  open,
  onClose,
}: OpenClawConnectionSectionProps) {
  const { selectedOrganizationId, bootstrap, can } = useOpenClawRouteContext();
  const account = bootstrap.account;
  const [challenge, setChallenge] = useState<{
    challengeId: string; qrPayload: string; expiresAt: string;
    browserNonceHash: string; authSessionHash: string;
  } | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());

  const beginQr = useOpenClawBeginQrLogin(selectedOrganizationId, account?.accountId ?? "");
  const acknowledge = useOpenClawAcknowledgeDisclosure(
    selectedOrganizationId, account?.accountId ?? "",
  );
  const poll = useOpenClawQrPoll(
    selectedOrganizationId,
    account?.accountId ?? null,
    challenge === null ? null : {
      version: 1,
      organizationId: selectedOrganizationId,
      challengeId: challenge.challengeId,
      browserNonceHash: challenge.browserNonceHash,
      authSessionHash: challenge.authSessionHash,
    },
  );

  // One second is the smallest unit the countdown displays, so that is the tick.
  useEffect(() => {
    if (challenge === null) return undefined;
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [challenge]);

  // ORGANIZATION_SWITCH and ACCOUNT_SWITCH: a code minted for one scope must never
  // survive into another, even for the instant before a refetch lands.
  useEffect(() => {
    setChallenge(null);
  }, [selectedOrganizationId, account?.accountId]);

  // DIALOG_CLOSED.
  useEffect(() => {
    if (!open) setChallenge(null);
  }, [open]);

  // SUCCESSFUL_LOGIN: once the challenge is consumed there is nothing left to show,
  // and keeping the payload around would only widen the window for a screenshot.
  const challengeStatus = poll.data?.challenge?.challengeStatus ?? "PENDING";
  useEffect(() => {
    if (challengeStatus === "CONSUMED" || challengeStatus === "REVOKED") setChallenge(null);
  }, [challengeStatus]);

  const gate = account === null
    ? null
    : qrGateState({
      account,
      control: bootstrap.control,
      canManageConnections: can("manage_connections"),
      now,
    });

  const requestQr = useCallback(async () => {
    if (account?.currentCellId == null) return;
    // The nonce never leaves the browser; only its digest does, so a stolen
    // challenge row cannot be completed by anyone who did not mint it here.
    const nonce = crypto.randomUUID();
    const browserNonceHash = await sha256Hex(nonce);
    const authSessionHash = await sha256Hex(`${selectedOrganizationId}:${bootstrap.actorId}`);
    const result = await beginQr.mutateAsync({
      clientOperationId: crypto.randomUUID(),
      request: {
        version: 1,
        organizationId: selectedOrganizationId,
        accountId: account.accountId,
        cellId: account.currentCellId,
        browserNonceHash,
        authSessionHash,
        disclosureVersion: account.disclosureVersion,
      },
    });
    setChallenge({
      challengeId: result.challengeId,
      // The scannable payload is the challenge id plus the browser nonce; neither is
      // useful without the other, and neither is persisted anywhere.
      qrPayload: `${result.challengeId}.${nonce}`,
      expiresAt: result.expiresAt,
      browserNonceHash,
      authSessionHash,
    });
    setNow(new Date().toISOString());
  }, [account, beginQr, bootstrap.actorId, selectedOrganizationId]);

  if (account === null || gate === null) return null;

  const secondsLeft = challenge === null ? 0 : qrCountdownSeconds(challenge.expiresAt, now);

  return (
    <OpenClawConnectionDialog
      open={open}
      gate={gate}
      accountName={account.displayName}
      challenge={challenge === null ? null : {
        challengeId: challenge.challengeId,
        qrPayload: challenge.qrPayload,
        secondsLeft,
        status: challengeStatus,
      }}
      pending={beginQr.isPending || acknowledge.isPending}
      onRequestQr={() => void requestQr()}
      onAcknowledgeDisclosure={() => {
        acknowledge.mutate({
          clientOperationId: crypto.randomUUID(),
          request: {
            version: 1,
            organizationId: selectedOrganizationId,
            accountId: account.accountId,
            // From the account, never a constant: the RPC raises 40001 on a mismatch.
            disclosureVersion: gate.disclosure.versionToAcknowledge,
          },
        });
      }}
      onClose={onClose}
    />
  );
}
