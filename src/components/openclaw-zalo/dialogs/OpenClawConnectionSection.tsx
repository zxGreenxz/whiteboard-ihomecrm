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
  /** Fired when the poll shows the account has left the QR flow - see below. */
  onConnected?: () => void;
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
  onConnected,
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
  // A CONSUME in flight. Without this the next 2s tick reads the pre-commit
  // `pngDataUrl === null` and fires a SECOND consume with a fresh operation id, so
  // idempotency does not deduplicate it - the challenge is no longer PENDING with
  // material, the strict select finds nothing, and an error banner lands on top of
  // a QR that actually worked.
  const consuming = useRef(false);

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
        // EXPIRED: drop the material rather than leave a dead payload on screen for
        // someone to photograph. Cleared outright rather than flagged, because the
        // effect never restarts while a challenge exists - flagging it re-created a
        // new object every 2s forever, re-rendering until the dialog closed, and
        // kept `pngDataUrl` in state despite a comment claiming otherwise.
        if (qrCountdownSeconds(current.expiresAt, new Date().toISOString()) <= 0) {
          setChallenge(null);
          setErrorMessage("Mã đã hết hạn. Yêu cầu mã mới để tiếp tục.");
          return;
        }
        try {
          const { data } = await supabase.auth.getSession();
          const accessToken = data.session?.access_token;
          if (!accessToken) return;
          const result = await pollQrLogin({
            organizationId: selectedOrganizationId,
            challengeId: current.challengeId,
            browserNonce: current.nonce,
            accessToken,
          });
          if (cancelled) return;
          const status = result.challenge?.challengeStatus ?? null;
          // A NULL challenge is the success signal: openclaw_poll_qr_login_v1 joins
          // on `connection_state in ('QR_PENDING','CONNECTING')`, so the row stops
          // matching once the scan lands and the account moves on - or once the
          // session is revoked. Either way there is nothing left to show.
          //
          // CONSUMED is NOT that signal. The consume RPC sets it to record that THIS
          // BROWSER fetched the material, so it appears on the very next tick after
          // a successful decrypt. Treating it as terminal wiped the QR about two
          // seconds after it appeared, before anyone could scan it.
          if (status === null || status === "REVOKED") {
            clear();
            onConnected?.();
            return;
          }
          setChallenge(previous => (previous === null ? null : { ...previous, status }));
          // READY is the first moment there is anything to decrypt.
          if (status === "READY" && current.pngDataUrl === null && !consuming.current) {
            consuming.current = true;
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
        } finally {
          consuming.current = false;
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [account, challenge === null, clear, onConnected, selectedOrganizationId]);

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
