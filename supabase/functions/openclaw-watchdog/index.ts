import { canonicalJson, sha256Hex, utf8 } from "../_shared/openclaw/crypto.ts";
import {
  handleWatchdogRequest,
  WATCHDOG_HEALTH_RPC,
  type ConsumeEnvelopeNonceInput,
  type WatchdogSnapshot,
} from "./handler.ts";
import { parseWatchdogKeyRegistry } from "./schemas.ts";

const env = Deno.env.toObject();

function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function httpsUrl(name: string, path: RegExp): string {
  const value = new URL(required(name));
  if (value.protocol !== "https:" || value.username || value.password || value.search || value.hash ||
    !path.test(value.pathname) || /gateway/iu.test(value.hostname + value.pathname) ||
    ["18789", "3000", "8080"].includes(value.port)) throw new Error(`${name} is invalid`);
  return value.toString();
}

function csv(name: string): string[] {
  const values = required(name).split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length < 1 || values.length > 20 || new Set(values).size !== values.length) {
    throw new Error(`${name} is invalid`);
  }
  return values;
}

function envelopeKeys(name: string): ReturnType<typeof parseWatchdogKeyRegistry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(required(name));
  } catch {
    throw new Error(`${name} is invalid`);
  }
  const registry = parseWatchdogKeyRegistry(parsed);
  if (!registry) throw new Error(`${name} is invalid`);
  return registry;
}

const watchdogEnvelopeKeys = envelopeKeys("OPENCLAW_WATCHDOG_ENVELOPE_KEYS_JSON");
const supabaseUrl = new URL(required("SUPABASE_URL")).origin;
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const probeUrl = httpsUrl("OPENCLAW_WATCHDOG_PROBE_URL", /\/openclaw-health\/v1\/snapshot\/?$/u);
const controlUrl = httpsUrl("OPENCLAW_WATCHDOG_CONTROL_URL", /\/openclaw-health\/v1\/controls\/?$/u);
const probeToken = required("OPENCLAW_WATCHDOG_PROBE_TOKEN");
const controlToken = required("OPENCLAW_WATCHDOG_CONTROL_TOKEN");
const pushUserIds = csv("OPENCLAW_WATCHDOG_OWNER_ADMIN_USER_IDS");
const emailRecipients = csv("OPENCLAW_WATCHDOG_OWNER_ADMIN_EMAILS");
const resendApiKey = required("RESEND_API_KEY");
const resendFrom = required("OPENCLAW_WATCHDOG_EMAIL_FROM");
const principal = JSON.parse(required("OPENCLAW_WATCHDOG_PRINCIPAL_JSON")) as Record<string, unknown>;

function timeoutSignal(parent: AbortSignal, milliseconds: number): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  setTimeout(() => controller.abort(), milliseconds);
  return controller.signal;
}

async function postJson(url: string, token: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Envelope nonces are spent in-process and bounded by the same 60-second window
 * the envelope itself enforces, so a replay can never outlive its own clock
 * window inside an isolate. The durable backstop for the two operations that
 * mutate state is the database: their deterministic operation id is the service
 * envelope nonce, and `openclaw_service_nonces` rejects the second insert. PROBE
 * mutates nothing, so an isolate-local store is the whole requirement there.
 */
const NONCE_STORE_LIMIT = 4_096;
const spentNonces = new Map<string, number>();

function consumeEnvelopeNonce(input: ConsumeEnvelopeNonceInput): Promise<boolean> {
  const nowEpochSeconds = Math.floor(Date.now() / 1_000);
  for (const [nonce, expiresAt] of spentNonces) {
    if (expiresAt <= nowEpochSeconds) spentNonces.delete(nonce);
  }
  const key = `${input.organizationId}\u0000${input.keyGeneration}\u0000${input.nonce}`;
  if (spentNonces.has(key)) return Promise.resolve(false);
  // A full store must deny rather than forget: forgetting is a replay window.
  if (spentNonces.size >= NONCE_STORE_LIMIT) return Promise.resolve(false);
  spentNonces.set(key, input.expiresAtEpochSeconds);
  return Promise.resolve(true);
}

async function serviceRequestHash(request: unknown): Promise<string> {
  return await sha256Hex(utf8(
    `ihome-openclaw-service-request-v1\0openclaw_record_watchdog_health_v1\0${canonicalJson(request)}`,
  ));
}

Deno.serve((request: Request) =>
  handleWatchdogRequest(request, {
    envelopeKeys: watchdogEnvelopeKeys,
    consumeEnvelopeNonce,
    probe: async (organizationId, signal): Promise<WatchdogSnapshot> => {
      const response = await postJson(probeUrl, probeToken, {
        version: 1,
        organizationId,
        requestedFields: [
          "heartbeatAt", "queueLagP95Seconds", "unknownCount10m", "unknownRate10m", "attempts10m",
          "adapterErrorRate5m", "reconnectCount10m", "cpuPercentOfCap", "ramPercentOfCap",
          "rootDiskUsedPercent", "spoolUsedPercent", "spoolOldestAgeSeconds", "spoolBytes",
          "mediaBacklog", "r2FailureCount5m", "supabaseEgressPercent", "r2StoragePercent",
          "r2RequestPercent", "vpsOutboundPercent", "transferQuotaPercent",
        ],
      }, timeoutSignal(signal, 8_000));
      if (!response.ok) {
        return {
          version: 1,
          organizationId,
          observedAt: new Date().toISOString(),
          probeOk: false,
          heartbeatAt: null,
          metrics: Object.fromEntries([
            "queueLagP95Seconds", "unknownCount10m", "unknownRate10m", "attempts10m",
            "adapterErrorRate5m", "reconnectCount10m", "cpuPercentOfCap", "ramPercentOfCap",
            "rootDiskUsedPercent", "spoolUsedPercent", "spoolOldestAgeSeconds", "spoolBytes",
            "mediaBacklog", "r2FailureCount5m", "supabaseEgressPercent", "r2StoragePercent",
            "r2RequestPercent", "vpsOutboundPercent", "transferQuotaPercent",
          ].map((key) => [key, 0])),
        };
      }
      const snapshot = await response.json() as WatchdogSnapshot;
      return { ...snapshot, organizationId };
    },
    recordHealth: async ({ organizationId, operationId, observedAt, events }) => {
      const rpcRequest = { version: 1, events };
      const issuedAt = new Date(observedAt);
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${WATCHDOG_HEALTH_RPC}`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          p_principal: {
            ...principal,
            organizationId,
            allowedOperations: ["openclaw_record_watchdog_health_v1"],
          },
          p_envelope: {
            version: 1,
            operation: "openclaw_record_watchdog_health_v1",
            nonce: operationId,
            iat: issuedAt.toISOString(),
            exp: new Date(issuedAt.getTime() + 60_000).toISOString(),
            requestHash: await serviceRequestHash(rpcRequest),
          },
          p_request: rpcRequest,
        }),
      });
      if (!response.ok) throw new Error("watchdog health facade failed");
      const result = await response.json() as { recorded?: unknown };
      if (!Number.isSafeInteger(result.recorded) || Number(result.recorded) !== events.length) {
        throw new Error("watchdog health facade returned an invalid result");
      }
      return { recorded: Number(result.recorded) };
    },
    applyCapacityControls: async ({ organizationId, operationId, controls, reasonFingerprint }) => {
      const response = await postJson(controlUrl, controlToken, {
        version: 1,
        organizationId,
        operationId,
        controls,
        reasonFingerprint,
        automaticResume: false,
        requiredResumePermission: "openclaw_zalo.manage_operations",
      });
      if (!response.ok) throw new Error("watchdog control dependency failed");
    },
    notifyOwnerAdmins: async ({ organizationId, operationId, fingerprints, repeatWindow }) => {
      const safeBody = {
        title: "OpenClaw cần kiểm tra",
        body: `Sự cố vận hành ${fingerprints.join(", ")}`,
        url: "/openclaw-zalo?area=operations",
        tag: `openclaw-watchdog-${organizationId}-${repeatWindow}`,
      };
      const pushResults = await Promise.all(pushUserIds.map((userId) =>
        postJson(`${supabaseUrl}/functions/v1/send-push`, serviceRoleKey, { userId, ...safeBody })
      ));
      if (pushResults.some((response) => !response.ok)) throw new Error("watchdog push notification failed");
      const emailResponse = await postJson("https://api.resend.com/emails", resendApiKey, {
        from: resendFrom,
        to: emailRecipients,
        subject: "[iHome CRM] OpenClaw cần kiểm tra",
        text: `Organization ${organizationId}; incident ${fingerprints.join(", ")}; operation ${operationId}. Mở CRM Operations để xử lý.`,
      });
      if (!emailResponse.ok) throw new Error("watchdog email notification failed");
      return { push: pushResults.length, email: emailRecipients.length };
    },
    logger: { error: (message, context) => console.error(message, context) },
  })
);
