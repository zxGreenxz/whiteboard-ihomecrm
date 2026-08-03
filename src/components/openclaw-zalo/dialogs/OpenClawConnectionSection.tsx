import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import { useOpenClawAcknowledgeDisclosure } from "@/hooks/openclaw-zalo/useOpenClawMutations";
import { qrCountdownSeconds, qrGateState } from "@/lib/openclaw-zalo/connection";
import {
  beginQrLogin,
  consumeQrChallenge,
  pollQrLogin,
  type QrChallengeSnapshot,
} from "@/lib/openclaw-zalo/qrClient";
import OpenClawConnectionDialog from "./OpenClawConnectionDialog";

interface OpenClawConnectionSectionProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The server allows ten polls per ten seconds per challenge, so 2s leaves headroom
 * for a retry without tripping the limiter.
 */
const POLL_INTERVAL_MS = 2_000;

/**
 * Owns the QR lifetime, and it is the only thing that ever holds the image.
 *
 * The nonce is generated here and only its digest leaves the browser. The decrypted
 * PNG comes back from a CONSUME through the Edge function and lives in component
 * state alone - never localStorage, sessionStorage, the React Query cache (the poll
 * is a plain fetch loop here precisely so no cache entry outlives the dialog),
 * analytics, or toast text.
 */
export default function OpenClawConnectionSection({
  open,
  onClose,
}: OpenClawConnectionSectionProps) {
  const { selectedOrganizationId, bootstrap, can } = useOpenClawRouteContext();
  const account = bootstrap.account;
  const [challenge, setChallenge] = useState<{
    challengeId: string; expiresAt: string; nonce: string;
    status: QrChallengeSnapshot["challengeStatus"]; pngDataUrl: string | null;
  } | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Read inside the poll loop without making it a dependency, so a status update
  // does not tear down and restart the interval.
  const challengeRef = useRef(challenge);
  challengeRef.current = challenge;

  const acknowledge = useOpenClawAcknowledgeDisclosure(
    selectedOrganizationId, account?.accountId ?? "",
  );

  const clear = useCallback(() => {
    setChallenge(null);
    setErrorMessage(null);
  }, []);

  // ORGANIZATION_SWITCH and ACCOUNT_SWITCH: a code minted for one scope must never
  // survive into another, even for the instant before a refetch lands.
  useEffect(() => { clear(); }, [clear, selectedOrganizationId, account?.accountId]);

  // DIALOG_CLOSED. ROUTE_UNMOUNTED and LOGOUT are covered by this component being
  // torn down, which drops the state with it.
  useEffect(() => { if (!open) clear(); }, [clear, open]);

  useEffect(() => {
    if (challenge === null || account === null) return undefined;
    const tick = setInterval(() => setNow(new Date().toISOString()), 1_000);

    let cancelled = false;
    const poll = setInterval(() => {
      void (async () => {
        const current = challengeRef.current;
        if (current === null) return;
        // EXPIRED: stop polling and drop the material rather than leaving a dead
        // payload on screen for someone to photograph.
        if (qrCountdownSeconds(current.expiresAt, new Date().toISOString()) <= 0) {
          setChallenge(previous => (previous === null ? null : { ...previous, status: "EXPIRED" }));
          return;
        }
        try {
          const { data } = await supabase.auth.getSession();
          const accessToken = data.session?.access_token;
          if (!accessToken) return;
          const result = await pollQrLogin({
            clientOperationId: crypto.randomUUID(),
            organizationId: selectedOrganizationId,
            accountId: account.accountId,
            challengeId: current.challengeId,
            browserNonce: current.nonce,
            accessToken,
          });
          if (cancelled) return;
          const status = result.challenge?.challengeStatus ?? null;
          // A null challenge means the account has left QR_PENDING/CONNECTING - the
          // join in openclaw_poll_qr_login_v1 stops matching once login succeeds or
          // the session is revoked. Treating that as "still PENDING" is what kept a
          // consumed code on screen; treat it as terminal instead.
          if (status === null || status === "CONSUMED" || status === "REVOKED") {
            clear();
            return;
          }
          setChallenge(previous => (previous === null ? null : { ...previous, status }));
          // READY is the first moment there is anything to decrypt.
          if (status === "READY" && current.pngDataUrl === null) {
            const consumed = await consumeQrChallenge({
              clientOperationId: crypto.randomUUID(),
              organizationId: selectedOrganizationId,
              accountId: account.accountId,
              challengeId: current.challengeId,
              browserNonce: current.nonce,
              accessToken,
            });
            if (cancelled) return;
            setChallenge(previous => (previous === null
              ? null
              : { ...previous, pngDataUrl: consumed.qrPngDataUrl }));
          }
        } catch (error) {
          if (!cancelled) setErrorMessage(messageOf(error));
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [account, challenge === null, clear, selectedOrganizationId]);

  const requestQr = useCallback(async () => {
    if (account?.currentCellId == null) return;
    setPending(true);
    setErrorMessage(null);
    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) throw new Error("Phiên đăng nhập đã hết hạn, đăng nhập lại rồi thử tiếp.");
      const nonce = crypto.randomUUID();
      const result = await beginQrLogin({
        clientOperationId: crypto.randomUUID(),
        organizationId: selectedOrganizationId,
        accountId: account.accountId,
        cellId: account.currentCellId,
        browserNonce: nonce,
        accessToken,
        disclosureVersion: account.disclosureVersion,
      });
      setChallenge({
        challengeId: result.challengeId,
        expiresAt: result.expiresAt,
        nonce,
        status: "PENDING",
        pngDataUrl: null,
      });
      setNow(new Date().toISOString());
    } catch (error) {
      setErrorMessage(messageOf(error));
    } finally {
      setPending(false);
    }
  }, [account, selectedOrganizationId]);

  if (account === null) return null;

  const gate = qrGateState({ account, canManageConnections: can("manage_connections") });
  const secondsLeft = challenge === null ? 0 : qrCountdownSeconds(challenge.expiresAt, now);

  return (
    <OpenClawConnectionDialog
      open={open}
      gate={gate}
      accountName={account.displayName}
      challenge={challenge === null ? null : {
        challengeId: challenge.challengeId,
        pngDataUrl: challenge.pngDataUrl,
        secondsLeft,
        status: challenge.status,
      }}
      pending={pending || acknowledge.isPending}
      errorMessage={errorMessage}
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

function messageOf(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Không lấy được mã QR. Thử lại hoặc báo vận hành.";
}
