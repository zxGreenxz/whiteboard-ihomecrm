import { canonicalJson, sha256Hex, utf8 } from "../_shared/openclaw/crypto.ts";
import {
  handleWatchdogRequest,
  WATCHDOG_APPLY_CONTROLS_RPC,
  WATCHDOG_HEALTH_RPC,
  WATCHDOG_NONCE_RPC,
  WATCHDOG_SNAPSHOT_RPC,
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
const pushUserIds = csv("OPENCLAW_WATCHDOG_OWNER_ADMIN_USER_IDS");
const emailRecipients = csv("OPENCLAW_WATCHDOG_OWNER_ADMIN_EMAILS");
const resendApiKey = required("RESEND_API_KEY");
const resendFrom = required("OPENCLAW_WATCHDOG_EMAIL_FROM");
const principal = JSON.parse(required("OPENCLAW_WATCHDOG_PRINCIPAL_JSON")) as Record<string, unknown>;

/**
 * There is no probe URL and no control URL any more.
 *
 * Both used to point at `/openclaw-health/v1/*` on the OpenClaw VPS, which would
 * require an INBOUND port on the host that holds the Zalo session - forbidden by
 * the design spec, and never implemented. Everything the watchdog needs already
 * travels outward: the cell pushes heartbeat + content-free metrics through
 * POST /v1/heartbeat, and reads capacity controls back from that same response.
 * So the Edge reads health from the database and writes controls to it.
 */
const CAPACITY_METRIC_KEYS = Object.freeze([
  "queueLagP95Seconds", "unknownCount10m", "unknownRate10m", "attempts10m",
  "adapterErrorRate5m", "reconnectCount10m", "cpuPercentOfCap", "ramPercentOfCap",
  "rootDiskUsedPercent", "spoolUsedPercent", "spoolOldestAgeSeconds", "spoolBytes",
  "mediaBacklog", "r2FailureCount5m", "supabaseEgressPercent", "r2StoragePercent",
  "r2RequestPercent", "vpsOutboundPercent", "transferQuotaPercent",
] as const);

/**
 * The Worker's parser demands exactly these nineteen numeric metrics. A cell that
 * reports a partial bundle must not crash the watchdog, and an unknown key must
 * not travel onward, so the set is rebuilt here rather than passed through.
 */
function normalizeMetrics(value: unknown): Record<string, number> {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(CAPACITY_METRIC_KEYS.map((key) => {
    const metric = source[key];
    return [key, typeof metric === "number" && Number.isFinite(metric) && metric >= 0 ? metric : 0];
  }));
}

async function serviceRequestHash(operation: string, request: unknown): Promise<string> {
  return await sha256Hex(utf8(
    `ihome-openclaw-service-request-v1\u0000${operation}\u0000${canonicalJson(request)}`,
  ));
}

/** Calls one narrow service facade with the canonical machine envelope. */
async function serviceRpc(input: {
  facade: string;
  operation: string;
  organizationId: string;
  nonce: string;
  observedAt: string;
  request: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const issuedAt = new Date(input.observedAt);
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${input.facade}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      p_principal: {
        ...principal,
        organizationId: input.organizationId,
        allowedOperations: [input.operation],
      },
      p_envelope: {
        version: 1,
        operation: input.operation,
        nonce: input.nonce,
        iat: issuedAt.toISOString(),
        exp: new Date(issuedAt.getTime() + 60_000).toISOString(),
        requestHash: await serviceRequestHash(input.operation, input.request),
      },
      p_request: input.request,
    }),
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`${input.facade} failed`);
  const result = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`${input.facade} returned an invalid result`);
  }
  return result as Record<string, unknown>;
}

Deno.serve((request: Request) =>
  handleWatchdogRequest(request, {
    envelopeKeys: watchdogEnvelopeKeys,
    // Durable across isolates: an in-process map cannot be a replay guard when
    // Supabase runs many isolates, and the notification-only RECORD path spends
    // no other nonce.
    consumeEnvelopeNonce: async (input: ConsumeEnvelopeNonceInput): Promise<boolean> => {
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${WATCHDOG_NONCE_RPC}`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          p_request: {
            version: 1,
            organizationId: input.organizationId,
            keyGeneration: input.keyGeneration,
            operation: input.operation,
            nonce: input.nonce,
            bodySha256: input.bodySha256,
            signedAtEpochSeconds: input.signedAtEpochSeconds,
          },
        }),
      });
      // A replay is a deliberate 42501 from the database, not a transport error.
      return response.ok;
    },
    probe: async (organizationId, probeId, observedAt, signal): Promise<WatchdogSnapshot> => {
      const result = await serviceRpc({
        facade: WATCHDOG_SNAPSHOT_RPC,
        operation: "openclaw_watchdog_snapshot_v1",
        organizationId,
        nonce: probeId,
        observedAt,
        request: { version: 1 },
        signal,
      });
      return {
        version: 1,
        organizationId,
        observedAt: typeof result.observedAt === "string" ? result.observedAt : observedAt,
        probeOk: result.probeOk === true,
        heartbeatAt: typeof result.heartbeatAt === "string" ? result.heartbeatAt : null,
        metrics: normalizeMetrics(result.metrics),
      };
    },
    recordHealth: async ({ organizationId, operationId, observedAt, events }) => {
      const result = await serviceRpc({
        facade: WATCHDOG_HEALTH_RPC,
        operation: "openclaw_record_watchdog_health_v1",
        organizationId,
        nonce: operationId,
        observedAt,
        request: { version: 1, events },
      });
      if (!Number.isSafeInteger(result.recorded) || Number(result.recorded) !== events.length) {
        throw new Error("watchdog health facade returned an invalid result");
      }
      return { recorded: Number(result.recorded) };
    },
    applyCapacityControls: async ({ organizationId, operationId, observedAt, controls, reasonFingerprint }) => {
      await serviceRpc({
        facade: WATCHDOG_APPLY_CONTROLS_RPC,
        operation: "openclaw_apply_capacity_controls_v1",
        organizationId,
        // Deterministic operation id doubles as the nonce, so a retried tick after
        // a lost response cannot apply the same control twice.
        nonce: operationId,
        observedAt,
        request: {
          version: 1,
          operationId,
          controls,
          reasonFingerprint,
          // Health-generated pauses never auto-resume; only manage_operations releases them.
          requiresManualResume: true,
        },
      });
    },
    notifyOwnerAdmins: async ({ organizationId, operationId, fingerprints, repeatWindow }) => {
      const safeBody = {
        title: "OpenClaw cần kiểm tra",
        body: `Sự cố vận hành ${fingerprints.join(", ")}`,
        url: "/openclaw-zalo?area=operations",
        tag: `openclaw-watchdog-${organizationId}-${repeatWindow}`,
      };
      const pushResults = await Promise.all(pushUserIds.map((userId) =>
        fetch(`${supabaseUrl}/functions/v1/send-push`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${serviceRoleKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ userId, ...safeBody }),
        })
      ));
      if (pushResults.some((response) => !response.ok)) throw new Error("watchdog push notification failed");
      const emailResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${resendApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: resendFrom,
          to: emailRecipients,
          subject: "[iHome CRM] OpenClaw cần kiểm tra",
          text: `Organization ${organizationId}; incident ${fingerprints.join(", ")}; operation ${operationId}. Mở CRM Operations để xử lý.`,
        }),
      });
      if (!emailResponse.ok) throw new Error("watchdog email notification failed");
      return { push: pushResults.length, email: emailRecipients.length };
    },
    logger: { error: (message, context) => console.error(message, context) },
  })
);
