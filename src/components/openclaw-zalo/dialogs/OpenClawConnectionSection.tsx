import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { openClawQueryKeys } from "@/hooks/openclaw-zalo/queryKeys";
import { useOpenClawRouteContext } from "../OpenClawRouteGuard";
import {
  useOpenClawAcknowledgeDisclosure,
  useOpenClawDisconnectAccount,
} from "@/hooks/openclaw-zalo/useOpenClawMutations";
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
 * How many consecutive poll failures before one is shown to the operator.
 *
 * The first failure after a successful scan is EXPECTED - it is what a completed
 * login looks like through this endpoint - so reporting it immediately would tell
 * every successful user that something went wrong.
 */
const POLL_FAILURES_BEFORE_REPORTING = 3;

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
  // Consecutive poll failures. One is expected on the happy path (see the catch).
  const pollFailures = useRef(0);

  const queryClient = useQueryClient();
  const acknowledge = useOpenClawAcknowledgeDisclosure(
    selectedOrganizationId, account?.accountId ?? "",
  );
  const disconnect = useOpenClawDisconnectAccount(
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

  // SUCCESSFUL_LOGIN, decided by the ACCOUNT rather than by the challenge.
  //
  // The QR endpoint cannot tell us: it answers a completed login with the same
  // opaque 404 it uses for an expired or revoked code. The account moving to
  // CONNECTED is the one unambiguous signal, and the poll's catch refetches it.
  const connected = account?.connectionState === "CONNECTED";
  useEffect(() => {
    if (!connected) return;
    clear();
    onConnected?.();
  }, [clear, connected, onConnected]);

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
          pollFailures.current = 0;
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
          // Defensive only: over HTTP this branch is unreachable, because the Edge
          // function turns a null challenge into 404 QR_NOT_AVAILABLE rather than a
          // 200 with challenge:null. The real terminal signal is handled in the
          // catch below. Kept so a future 200-null response is not misread as
          // "still pending".
          if (status === null) {
            clear();
            return;
          }
          setChallenge(previous => (previous === null ? null : { ...previous, status }));
          // READY is the first moment there is anything to decrypt.
          if (status === "READY" && current.pngDataUrl === null && !consuming.current) {
            consuming.current = true;
            try {
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
            } finally {
              // Cleared by the tick that SET it. Attached to the whole tick, a later
              // tick that merely skipped the guard would clear the flag while the
              // first consume was still in flight, and a third tick would fire a
              // second consume with a fresh operation id - which idempotency cannot
              // deduplicate.
              consuming.current = false;
            }
          }
        } catch (error) {
          if (cancelled) return;
          // A poll failure is AMBIGUOUS by design: openclaw-qr collapses expired,
          // consumed, revoked and never-existed into one 404 QR_NOT_AVAILABLE, and
          // a successful scan produces exactly that - openclaw_poll_qr_login_v1
          // joins on connection_state in ('QR_PENDING','CONNECTING') AND on the
          // connection generation, and finalizing the login moves both.
          //
          // So a 404 must not be read as either success or failure. Ask the
          // authority instead: refetch the account and let the CONNECTED effect
          // below decide. Only after several consecutive failures, with the account
          // still not connected, is this reported as an error.
          pollFailures.current += 1;
          void queryClient.invalidateQueries({
            queryKey: openClawQueryKeys.bootstrap(selectedOrganizationId, account.accountId),
          });
          if (pollFailures.current >= POLL_FAILURES_BEFORE_REPORTING) {
            setErrorMessage(await messageOf(error));
          }
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
      setErrorMessage(await messageOf(error));
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
      pending={pending || acknowledge.isPending || disconnect.isPending}
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
      onDisconnect={gate.canManageConnections
        ? () => {
          setErrorMessage(null);
          disconnect.mutate({
            clientOperationId: crypto.randomUUID(),
            request: {
              version: 1,
              organizationId: selectedOrganizationId,
              accountId: account.accountId,
              // From the account, never a constant: the RPC raises 40001 on a
              // mismatch, the same way the disclosure version does.
              expectedConnectionGeneration: account.connectionGeneration,
              reasonCode: "USER_REQUESTED",
            },
          }, {
            onError: (error: unknown) => {
              void messageOf(error).then(setErrorMessage);
            },
          });
        }
        : undefined}
      onClose={onClose}
    />
  );
}

/**
 * What the SERVER refused with, in Vietnamese.
 *
 * `supabase.functions.invoke` throws a `FunctionsHttpError` whose `message` is the
 * constant "Edge Function returned a non-2xx status code" - the same sentence for a
 * 403 session-binding failure, a 429 rate limit and a 400 bad request. The useful
 * part is the response body `{error:{code,message}}`, reachable through
 * `error.context`, so 403/429/404 stop looking identical to the operator.
 *
 * Async because reading the body is; callers await it.
 */
const REFUSAL_COPY: Record<string, string> = {
  SESSION_BINDING_INVALID:
    "Phiên trình duyệt không khớp. Tải lại trang rồi thử lại.",
  QR_RATE_LIMITED: "Yêu cầu mã quá nhanh. Chờ một chút rồi thử lại.",
  QR_NOT_AVAILABLE: "Mã này không còn dùng được. Yêu cầu mã mới.",
  ORIGIN_DENIED: "Tên miền này chưa được cho phép gọi dịch vụ QR.",
  AUTHENTICATION_REQUIRED: "Phiên đăng nhập đã hết hạn. Đăng nhập lại rồi thử tiếp.",
  INVALID_REQUEST: "Yêu cầu không hợp lệ. Báo vận hành kèm thời điểm gặp lỗi.",
};

async function messageOf(error: unknown) {
  const context = (error as { context?: { json?: () => Promise<unknown> } })?.context;
  if (typeof context?.json === "function") {
    try {
      const body = await context.json() as { error?: { code?: string; message?: string } };
      const code = body?.error?.code;
      if (code && code in REFUSAL_COPY) return REFUSAL_COPY[code];
      if (code) return `Dịch vụ QR từ chối: ${code}`;
    } catch {
      // Body already consumed or not JSON; fall through to the generic message.
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return "Không lấy được mã QR. Thử lại hoặc báo vận hành.";
}

