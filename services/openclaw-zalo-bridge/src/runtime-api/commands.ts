import { createCipheriv, createHash, randomBytes } from "node:crypto";

import type { ClosableCellRpcTransport } from "../adapters/channel-adapter.js";
import type {
  RuntimeCommandJournalClaim,
  RuntimeCommandJournalSnapshot,
  SqliteSpool,
} from "../spool/sqlite-spool.js";
import { canonicalJson } from "../spool/checksum.js";
import type { ChannelRuntimeClient } from "./client.js";
import type { CellWorkloadBinding } from "./workload-auth.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const QR_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u;
const COMMAND_LEASE_SECONDS = 60;
const MIN_EFFECT_MARGIN_MS = 15_000;
const QR_START_TIMEOUT_MS = 30_000;
/**
 * How long one `web.login.wait` blocks before it is re-armed.
 *
 * Deliberately short, because the wait holds the login gate (see `withLoginGate`)
 * and a queued `web.login.start` cannot run until it returns. 20s is the longest a
 * fresh "Lấy mã QR" should ever sit behind a stale one.
 *
 * Waiting longer in a single call buys nothing anyway: Zalo retires the code on its
 * own. Measured against the live provider, `web.login.wait` returned early at 31.7s
 * on a scan attempt while an unscanned code ran the full 120s. `finalizeQr` re-arms
 * the wait in a loop, so the scan window is bounded by the challenge deadline rather
 * than by this constant.
 */
const QR_WAIT_TIMEOUT_MS = 20_000;
const MAX_COMMAND_BATCH = 8;

type CommandKind = "QR_LOGIN" | "DISCONNECT";
type ExecutionState = "LEASED" | "STARTED";
type AuthMode = "NORMAL" | "COMMAND_TRANSITION";

interface RuntimeCommandBase extends RuntimeCommandJournalClaim {
  version: 1;
  commandVersion: 1;
  executionState: ExecutionState;
}

type QrLoginCommand = RuntimeCommandBase & {
  commandKind: "QR_LOGIN";
  payload: { version: 1; challengeId: string; browserNonceHash: string };
};

type DisconnectCommand = RuntimeCommandBase & {
  commandKind: "DISCONNECT";
  payload: {
    version: 1;
    reasonCode: string;
    revocationId: string;
    revokedSessionGeneration: number;
    minimumSessionGeneration: number;
  };
};

type RuntimeCommand = QrLoginCommand | DisconnectCommand;

type DisconnectResult = {
  version: 1;
  runtimeCommandId: string;
  commandKind: "DISCONNECT";
  claimGeneration: number;
  claimToken: string;
  outcome: "PROVIDER_LOGGED_OUT";
  result: {
    version: 1;
    revocationId: string;
    revokedSessionGeneration: number;
    minimumSessionGeneration: number;
    channel: "zalouser";
    accountId: string;
    credentialsCleared: false;
    loggedOut: true;
    status: "PROVIDER_LOGGED_OUT";
  };
};

interface RuntimeCommandResultAck {
  version: 1;
  runtimeCommandId: string;
  commandKind: CommandKind;
  claimGeneration: number;
  outcome: "PROVIDER_LOGGED_OUT" | "FAILED";
  resultHash: string;
  adoptSessionGeneration: number | null;
  status: "ACCEPTED";
}

interface ParsedHeartbeat {
  authMode: AuthMode;
  currentSessionGeneration: number;
  currentConnectionGeneration: number;
  commandResultAcks: RuntimeCommandResultAck[];
  commands: RuntimeCommand[];
}

export interface RuntimeCommandHeartbeat {
  pulse(): Promise<void>;
  stop(): void;
  settle(): Promise<void>;
}

interface RuntimeHealthSignal {
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  healthKind: string;
  status: "OPEN" | "RECOVERED";
  fingerprint: string;
  contentFreeMetrics: Record<string, string | number | boolean | null>;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  keys: readonly string[],
  name: string,
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  const result = record(value, name);
  const optional = new Set(optionalKeys);
  const actual = Object.keys(result).filter((key) => !optional.has(key)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return fail(`${name} fields are invalid`);
  }
  return result;
}

function boundedString(value: unknown, name: string, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum ||
    value !== value.trim()
  ) return fail(`${name} is invalid`);
  return value;
}

function uuid(value: unknown, name: string): string {
  const result = boundedString(value, name, 36, 36);
  if (!UUID.test(result)) return fail(`${name} is invalid`);
  return result;
}

function integer(value: unknown, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) return fail(`${name} is invalid`);
  return Number(value);
}

function timestamp(value: unknown, name: string): string {
  const result = boundedString(value, name, 20, 35);
  if (!RFC3339_TIMESTAMP.test(result) || !Number.isFinite(Date.parse(result))) {
    return fail(`${name} is invalid`);
  }
  return result;
}

function nullableTimestamp(value: unknown, name: string): string | null {
  return value === null ? null : timestamp(value, name);
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function parseCommand(value: unknown, expectedClaimToken: string): RuntimeCommand {
  const command = exact(value, [
    "version", "runtimeCommandId", "commandKind", "commandVersion", "claimGeneration",
    "claimToken", "leaseExpiresAt", "sourceSessionGeneration", "targetSessionGeneration",
    "sourceConnectionGeneration", "targetConnectionGeneration", "expectedFencingToken",
    "executionState", "effectDeadlineAt", "payload", "payloadHash",
  ], "runtime command");
  const claimToken = boundedString(command.claimToken, "runtime command claim token", 32, 512);
  const payloadHash = boundedString(command.payloadHash, "runtime command payload hash", 64, 64);
  if (
    command.version !== 1 || command.commandVersion !== 1 || claimToken !== expectedClaimToken ||
    !SHA256.test(payloadHash) || payloadHash !== hashCanonical(command.payload) ||
    (command.executionState !== "LEASED" && command.executionState !== "STARTED")
  ) return fail("runtime command binding is invalid");
  const effectDeadlineAt = nullableTimestamp(command.effectDeadlineAt, "runtime command effect deadline");
  if (
    (command.executionState === "LEASED" && effectDeadlineAt !== null) ||
    (command.executionState === "STARTED" && effectDeadlineAt === null)
  ) return fail("runtime command execution state is invalid");
  const base: RuntimeCommandBase = {
    version: 1,
    runtimeCommandId: uuid(command.runtimeCommandId, "runtime command ID"),
    commandKind: command.commandKind as CommandKind,
    commandVersion: 1,
    claimGeneration: integer(command.claimGeneration, "runtime command claim generation", 1),
    claimToken,
    leaseExpiresAt: timestamp(command.leaseExpiresAt, "runtime command lease expiry"),
    sourceSessionGeneration: integer(command.sourceSessionGeneration, "source session generation", 1),
    targetSessionGeneration: integer(command.targetSessionGeneration, "target session generation", 1),
    sourceConnectionGeneration: integer(command.sourceConnectionGeneration, "source connection generation", 0),
    targetConnectionGeneration: integer(command.targetConnectionGeneration, "target connection generation", 0),
    expectedFencingToken: integer(command.expectedFencingToken, "runtime command fencing token", 1),
    executionState: command.executionState,
    effectDeadlineAt,
    payload: command.payload,
    payloadHash,
  };
  if (command.commandKind === "QR_LOGIN") {
    const payload = exact(command.payload, ["version", "challengeId", "browserNonceHash"], "QR command");
    const browserNonceHash = boundedString(payload.browserNonceHash, "browser nonce hash", 64, 64);
    if (payload.version !== 1 || !SHA256.test(browserNonceHash)) return fail("QR command is invalid");
    return {
      ...base,
      commandKind: "QR_LOGIN",
      payload: {
        version: 1,
        challengeId: uuid(payload.challengeId, "QR challenge ID"),
        browserNonceHash,
      },
    };
  }
  if (command.commandKind === "DISCONNECT") {
    const payload = exact(command.payload, [
      "version", "reasonCode", "revocationId", "revokedSessionGeneration",
      "minimumSessionGeneration",
    ], "disconnect command");
    const revoked = integer(payload.revokedSessionGeneration, "revoked session generation", 1);
    const minimum = integer(payload.minimumSessionGeneration, "minimum session generation", 1);
    const reasonCode = boundedString(payload.reasonCode, "disconnect reason code", 1, 128);
    if (
      payload.version !== 1 || minimum !== revoked + 1 ||
      !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u.test(reasonCode)
    ) return fail("disconnect command is invalid");
    return {
      ...base,
      commandKind: "DISCONNECT",
      payload: {
        version: 1,
        reasonCode,
        revocationId: uuid(payload.revocationId, "revocation ID"),
        revokedSessionGeneration: revoked,
        minimumSessionGeneration: minimum,
      },
    };
  }
  return fail("runtime command kind is invalid");
}

function parseResultAck(value: unknown): RuntimeCommandResultAck {
  const ack = exact(value, [
    "version", "runtimeCommandId", "commandKind", "claimGeneration", "outcome",
    "resultHash", "adoptSessionGeneration", "status",
  ], "runtime command result acknowledgement");
  const resultHash = boundedString(ack.resultHash, "runtime command result hash", 64, 64);
  if (
    ack.version !== 1 || (ack.commandKind !== "QR_LOGIN" && ack.commandKind !== "DISCONNECT") ||
    (ack.outcome !== "PROVIDER_LOGGED_OUT" && ack.outcome !== "FAILED") ||
    ack.status !== "ACCEPTED" || !SHA256.test(resultHash)
  ) return fail("runtime command result acknowledgement is invalid");
  const adopt = ack.adoptSessionGeneration === null
    ? null
    : integer(ack.adoptSessionGeneration, "adopted session generation", 1);
  if ((ack.outcome === "PROVIDER_LOGGED_OUT") !== (adopt !== null)) {
    return fail("runtime command result adoption is invalid");
  }
  return {
    version: 1,
    runtimeCommandId: uuid(ack.runtimeCommandId, "runtime command ID"),
    commandKind: ack.commandKind,
    claimGeneration: integer(ack.claimGeneration, "runtime command claim generation", 1),
    outcome: ack.outcome,
    resultHash,
    adoptSessionGeneration: adopt,
    status: "ACCEPTED",
  };
}

function parseHeartbeatResponse(
  value: unknown,
  binding: CellWorkloadBinding,
  claimToken: string,
  localSessionGeneration: number,
): ParsedHeartbeat {
  // `capacityControls` is OPTIONAL, exactly as the Edge function treats it
  // (openclaw-runtime/contracts.ts:1097). The SQL facade
  // `openclaw_service_runtime_heartbeat_v1` returns it, the Edge passes it through,
  // and this strict key set rejected the whole response over it - so every heartbeat
  // answered 200 and every one was thrown away here, leaving the QR command at
  // LEASED with nothing logged. Edge and SQL deploy separately from this service, so
  // the key has to be tolerated whichever side is ahead.
  const response = exact(value, [
    "version", "organizationId", "accountId", "cellId", "observedAt", "accepted",
    "authMode", "currentSessionGeneration", "currentConnectionGeneration",
    "commandResultAcks", "commands",
  ], "heartbeat response", ["capacityControls"]);
  if (
    response.version !== 1 || response.organizationId !== binding.organizationId ||
    response.accountId !== binding.accountId || response.cellId !== binding.cellId ||
    response.accepted !== true || (response.authMode !== "NORMAL" && response.authMode !== "COMMAND_TRANSITION") ||
    !Array.isArray(response.commandResultAcks) || response.commandResultAcks.length > MAX_COMMAND_BATCH ||
    !Array.isArray(response.commands) || response.commands.length > MAX_COMMAND_BATCH
  ) return fail("heartbeat response binding is invalid");
  timestamp(response.observedAt, "heartbeat observation time");
  const currentSessionGeneration = integer(response.currentSessionGeneration, "current session generation", 1);
  const currentConnectionGeneration = integer(response.currentConnectionGeneration, "current connection generation", 0);
  if (
    (response.authMode === "NORMAL" && currentSessionGeneration !== localSessionGeneration) ||
    (response.authMode === "COMMAND_TRANSITION" && currentSessionGeneration !== localSessionGeneration + 1)
  ) return fail("heartbeat authentication mode is invalid");
  const commands = response.commands.map((command) => parseCommand(command, claimToken));
  const ids = new Set(commands.map((command) => command.runtimeCommandId));
  if (ids.size !== commands.length) return fail("heartbeat commands are duplicated");
  for (const command of commands) {
    if (command.expectedFencingToken !== binding.fencingToken) {
      return fail("runtime command fencing token is stale");
    }
    if (response.authMode === "COMMAND_TRANSITION") {
      if (
        command.commandKind !== "DISCONNECT" ||
        command.sourceSessionGeneration !== localSessionGeneration ||
        command.targetSessionGeneration !== currentSessionGeneration ||
        command.targetConnectionGeneration !== currentConnectionGeneration ||
        command.targetConnectionGeneration !== command.sourceConnectionGeneration + 1
      ) return fail("transition command binding is invalid");
    } else if (
      command.sourceSessionGeneration !== currentSessionGeneration ||
      command.targetSessionGeneration !== currentSessionGeneration ||
      // The command ADVANCES the connection generation; it does not sit on it.
      // Every runtime command is created with
      // `target_connection_generation = source_connection_generation + 1`
      // (20260727060000_openclaw_rpc_surface.sql:3084 for QR_LOGIN, :3246 for
      // DISCONNECT), and the same file enforces that invariant at :1671 and :5231.
      // The account's generation is bumped to the target in the same transaction,
      // so the server hands back source = current - 1.
      //
      // Requiring `sourceConnectionGeneration === currentConnectionGeneration` was
      // therefore unsatisfiable: it rejected every command the server ever issued.
      // The bridge threw "normal command binding is invalid" inside pulse(), which
      // nothing logs, so the QR command sat at LEASED forever and no QR was ever
      // produced - with a healthy bridge and 200s on every heartbeat.
      command.targetConnectionGeneration !== currentConnectionGeneration ||
      command.targetConnectionGeneration !== command.sourceConnectionGeneration + 1
    ) return fail("normal command binding is invalid");
  }
  return {
    authMode: response.authMode,
    currentSessionGeneration,
    currentConnectionGeneration,
    commandResultAcks: response.commandResultAcks.map(parseResultAck),
    commands,
  };
}

function exactLogoutResult(value: unknown, accountId: string): void {
  const result = record(value, "Gateway logout result");
  const keys = Object.keys(result);
  if (
    keys.some((key) => !["channel", "accountId", "cleared", "loggedOut", "message"].includes(key)) ||
    !["channel", "accountId", "cleared", "loggedOut"].every((key) => keys.includes(key)) ||
    result.channel !== "zalouser" || result.accountId !== accountId ||
    typeof result.cleared !== "boolean" || result.loggedOut !== true ||
    (result.message !== undefined && typeof result.message !== "string")
  ) fail("Gateway logout result is invalid");
}

function qrDataUrl(value: unknown): string {
  const result = record(value, "Gateway QR start result");
  const keys = Object.keys(result);
  if (
    keys.some((key) => !["message", "qrDataUrl", "connected"].includes(key)) ||
    !keys.includes("message") || !keys.includes("qrDataUrl") ||
    (result.connected !== undefined && typeof result.connected !== "boolean")
  ) fail("Gateway QR start result fields are invalid");
  boundedString(result.message, "Gateway QR message", 1, 4_096);
  // A real Zalo QR from the 2026.7.1 gateway is ~21 500 characters; the old 16 384
  // cap rejected every one of them. The failure was invisible twice over: the throw
  // is caught one frame up and sealed as AMBIGUOUS / QR_START_OUTCOME_UNKNOWN, which
  // reads like the gateway never answered - while the cell had logged
  // `res ✓ web.login.start` and handed back a perfectly good code.
  //
  // The ceiling is derived, not guessed: this string is AES-GCM encrypted and
  // base64-encoded into `ciphertextB64`, which the runtime contract bounds at
  // 240 000 characters (openclaw-runtime/contracts.ts:1252). Base64 costs 4/3, so
  // 131 072 plaintext characters yield ~174 800 - inside that bound with room to
  // spare, and far under the browser's own 1 048 576 limit.
  const qr = boundedString(result.qrDataUrl, "Gateway QR data URL", 23, 131_072);
  if (!QR_DATA_URL.test(qr)) return fail("Gateway QR data URL is invalid");
  return qr;
}

function connectedResult(value: unknown): boolean {
  const result = exact(value, ["connected", "message"], "Gateway QR wait result");
  boundedString(result.message, "Gateway QR wait message", 1, 4_096);
  if (typeof result.connected !== "boolean") return fail("Gateway QR wait result is invalid");
  return result.connected;
}

function encryptQrMaterial(key: Uint8Array, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertextB64: ciphertext.toString("base64"),
    cipherIvB64: iv.toString("base64"),
    authTagB64: cipher.getAuthTag().toString("base64"),
  };
}

function startMarker(command: RuntimeCommandJournalSnapshot) {
  return {
    version: 1,
    runtimeCommandId: command.runtimeCommandId,
    commandKind: command.commandKind,
    claimGeneration: command.claimGeneration,
    claimToken: command.claimToken,
    payloadHash: command.payloadHash,
  };
}

function commandResult(snapshot: RuntimeCommandJournalSnapshot): unknown {
  if (snapshot.result === null || snapshot.resultHash === null) {
    throw new Error("runtime command result journal is incomplete");
  }
  return snapshot.result;
}

export function createRuntimeCommandHeartbeat(options: {
  runtime: ChannelRuntimeClient;
  cellRpc: ClosableCellRpcTransport;
  binding: CellWorkloadBinding;
  spool: SqliteSpool;
  channelAccountId: string;
  commandClaimToken: string;
  qrEncryptionKey?: Uint8Array;
  healthSignal?: () => RuntimeHealthSignal | null;
  now?: () => number;
}): RuntimeCommandHeartbeat {
  const claimToken = boundedString(options.commandClaimToken, "command claim token", 32, 512);
  const now = options.now ?? Date.now;
  const qrEncryptionKey = options.qrEncryptionKey === undefined ? undefined : Buffer.from(options.qrEncryptionKey);
  if (qrEncryptionKey !== undefined && qrEncryptionKey.byteLength !== 32) {
    throw new TypeError("QR encryption key is invalid");
  }
  const localSessionGeneration = () => options.runtime.localSessionGeneration?.() ??
    options.binding.sessionGeneration;
  const persistedGeneration = options.spool.runtimeLocalSessionGeneration();
  if (persistedGeneration !== null && persistedGeneration !== localSessionGeneration()) {
    options.runtime.adoptSessionGeneration(persistedGeneration);
  }
  const background = new Set<Promise<void>>();
  const waitingQr = new Set<string>();
  let stopped = false;

  // THE crash that made every second QR fail.
  //
  // `web.login.start` and `web.login.wait` must never overlap on the same account.
  // When they do, the cell gateway allocates without bound and dies of "JavaScript
  // heap out of memory" roughly 60s later, taking ~68s to come back. Measured on the
  // live cell: three starts that overlapped an outstanding wait each killed the
  // process, while three that did not ran clean and left the heap flat at 276MB.
  //
  // The visible symptom was an exact alternation - QR 1 works, QR 2 never appears,
  // QR 3 works - because request N+1 arrived into the crash window opened by request
  // N and was answered by nothing. It also explains "mã quét không hoạt động": the
  // process holding the login attempt behind the displayed code was already gone.
  //
  // The gate serialises the two calls. `loginEpoch` supersedes an in-flight wait so a
  // new code does not queue behind the full lifetime of the code it replaces.
  let loginGate: Promise<unknown> = Promise.resolve();
  let loginEpoch = 0;

  const withLoginGate = async <T>(run: () => Promise<T>): Promise<T> => {
    const previous = loginGate;
    let release = (): void => undefined;
    loginGate = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
    }
  };

  const finalizeQr = (snapshot: RuntimeCommandJournalSnapshot): void => {
    if (waitingQr.has(snapshot.runtimeCommandId)) return;
    waitingQr.add(snapshot.runtimeCommandId);
    const payload = snapshot.payload as QrLoginCommand["payload"];
    const task = (async () => {
      const epoch = loginEpoch;
      const deadline = snapshot.effectDeadlineAt === null
        ? NaN
        : Date.parse(snapshot.effectDeadlineAt);
      const seal = (): void => {
        // Nobody scanned inside the window, Zalo retired the code, or a newer code
        // replaced it. The command is finished either way, and leaving it in
        // LOGIN_WAITING kept the journal row alive forever.
        options.spool.transitionRuntimeCommand(
          snapshot.runtimeCommandId,
          ["LOGIN_WAITING"],
          "SEALED",
          { sealedReason: "QR_EXPIRED_UNSCANNED" },
          now(),
        );
      };
      let waited: unknown;
      for (;;) {
        if (stopped) return;
        // A newer QR_LOGIN has taken the account. Stop re-arming so the start behind
        // the gate is served immediately instead of after this code's full lifetime.
        if (epoch !== loginEpoch) { seal(); return; }
        if (!Number.isFinite(deadline) || deadline - now() <= 0) { seal(); return; }
        waited = await withLoginGate(() => options.cellRpc.invoke("web.login.wait", {
          accountId: options.channelAccountId,
          timeoutMs: QR_WAIT_TIMEOUT_MS,
        }));
        if (stopped) return;
        if (connectedResult(waited)) break;
      }
      if (options.spool.hasNewerRuntimeDisconnect(snapshot.sourceSessionGeneration)) {
        const cleanup = options.spool.transitionRuntimeCommand(
          snapshot.runtimeCommandId,
          ["LOGIN_WAITING"],
          "STALE_LOGIN_CLEANUP_PENDING",
          { sealedReason: "STALE_QR_AFTER_DISCONNECT" },
          now(),
        );
        await execute(cleanup);
        return;
      }
      // `openclaw_finalize_account_connection_v1` answers with the ACCOUNT it just
      // connected - {version, accountId, connectionGeneration, connectionState,
      // evidenceHash} - on both the fresh and the idempotent-replay branch. It has
      // never returned `challengeId` or `connected`, so the old exact-key check
      // rejected every successful finalization and the scan could not complete.
      // Assert the field that carries the meaning, and tolerate the rest.
      const response = record(await options.runtime.post("/v1/qr/result", {
        version: 1,
        challengeId: payload.challengeId,
      }), "QR connection result");
      if (response.version !== 1 || response.connectionState !== "CONNECTED") {
        fail("QR connection result is invalid");
      }
      // Connected. Seal it - LOGIN_WAITING had NO exit at all, not even on success,
      // so the journal row outlived the command it described.
      options.spool.transitionRuntimeCommand(
        snapshot.runtimeCommandId,
        ["LOGIN_WAITING"],
        "SEALED",
        { sealedReason: "QR_LOGIN_CONFIRMED" },
        now(),
      );
    })();
    background.add(task);
    void task.finally(() => {
      background.delete(task);
      waitingQr.delete(snapshot.runtimeCommandId);
    }).catch(() => undefined);
  };

  const publishQr = async (snapshot: RuntimeCommandJournalSnapshot): Promise<void> => {
    if (snapshot.publishPayload === null) throw new Error("QR publication journal is incomplete");
    const payload = snapshot.payload as QrLoginCommand["payload"];
    // THE bug that stopped every QR after the first one.
    //
    // `openclaw_submit_qr_result_v1` returns FIVE keys on both of its branches -
    // {version, challengeId, materialVersion, publishedAt, accepted} - and the Edge
    // passes the SQL result through untouched (`/v1/qr/publish` falls to
    // `onlyVersionedObject`, which checks nothing but `version`). Demanding exactly
    // three keys therefore threw on EVERY publish, including the ones the server had
    // already committed.
    //
    // The damage was delayed and confusing: the challenge really did become READY, so
    // the first QR appeared and could be scanned - but the command never left
    // QR_MATERIAL_READY, so every following pulse republished it, threw again, and
    // took the whole pulse down with it. Heartbeats stopped, no new command was ever
    // claimed, and every later "Lấy mã QR" sat at "Đang chờ máy chủ phát mã" until it
    // expired. Wiping the spool "fixed" it exactly once, which is what made this look
    // like a network or timeout problem for hours.
    const published = record(
      await options.runtime.post("/v1/qr/publish", snapshot.publishPayload),
      "QR publication result",
    );
    if (published.version !== 1 || published.challengeId !== payload.challengeId || published.accepted !== true) {
      fail("QR publication result is invalid");
    }
    const waiting = options.spool.transitionRuntimeCommand(
      snapshot.runtimeCommandId,
      ["QR_MATERIAL_READY", "PUBLISH_PENDING"],
      "LOGIN_WAITING",
      {},
      now(),
    );
    finalizeQr(waiting);
  };

  const execute = async (snapshot: RuntimeCommandJournalSnapshot): Promise<boolean> => {
    if (snapshot.stage === "STALE_LOGIN_CLEANUP_PENDING") {
      exactLogoutResult(await options.cellRpc.invoke("channels.logout", {
        channel: "zalouser",
        accountId: options.channelAccountId,
      }), options.channelAccountId);
      options.spool.transitionRuntimeCommand(
        snapshot.runtimeCommandId,
        ["STALE_LOGIN_CLEANUP_PENDING"],
        "SEALED",
        { sealedReason: "STALE_QR_AFTER_DISCONNECT" },
        now(),
      );
      return true;
    }
    if (snapshot.stage === "LOGIN_WAITING") {
      finalizeQr(snapshot);
      return false;
    }
    if (snapshot.stage === "QR_MATERIAL_READY" || snapshot.stage === "PUBLISH_PENDING") {
      await publishQr(snapshot);
      return true;
    }
    if (snapshot.stage === "EFFECT_INTENT") {
      if (snapshot.commandKind === "QR_LOGIN") {
        options.spool.transitionRuntimeCommand(
          snapshot.runtimeCommandId,
          ["EFFECT_INTENT"],
          "AMBIGUOUS",
          { sealedReason: "QR_START_OUTCOME_UNKNOWN" },
          now(),
        );
        return true;
      }
    } else if (snapshot.stage !== "START_AUTHORIZED") {
      return false;
    }

    if (snapshot.stage === "START_AUTHORIZED") {
      const deadline = snapshot.effectDeadlineAt === null ? NaN : Date.parse(snapshot.effectDeadlineAt);
      if (!Number.isFinite(deadline) || deadline - now() < MIN_EFFECT_MARGIN_MS) {
        options.spool.transitionRuntimeCommand(
          snapshot.runtimeCommandId,
          ["START_AUTHORIZED"],
          "AMBIGUOUS",
          { sealedReason: "INSUFFICIENT_EFFECT_DEADLINE" },
          now(),
        );
        return true;
      }
      snapshot = options.spool.transitionRuntimeCommand(
        snapshot.runtimeCommandId,
        ["START_AUTHORIZED"],
        "EFFECT_INTENT",
        {},
        now(),
      );
    }

    if (snapshot.commandKind === "DISCONNECT") {
      const payload = snapshot.payload as DisconnectCommand["payload"];
      exactLogoutResult(await options.cellRpc.invoke("channels.logout", {
        channel: "zalouser",
        accountId: options.channelAccountId,
      }), options.channelAccountId);
      const result: DisconnectResult = {
        version: 1,
        runtimeCommandId: snapshot.runtimeCommandId,
        commandKind: "DISCONNECT",
        claimGeneration: snapshot.claimGeneration,
        claimToken: snapshot.claimToken,
        outcome: "PROVIDER_LOGGED_OUT",
        result: {
          version: 1,
          revocationId: payload.revocationId,
          revokedSessionGeneration: payload.revokedSessionGeneration,
          minimumSessionGeneration: payload.minimumSessionGeneration,
          channel: "zalouser",
          accountId: options.channelAccountId,
          credentialsCleared: false,
          loggedOut: true,
          status: "PROVIDER_LOGGED_OUT",
        },
      };
      options.spool.transitionRuntimeCommand(
        snapshot.runtimeCommandId,
        ["EFFECT_INTENT"],
        "PROVIDER_RECORDED",
        {},
        now(),
      );
      options.spool.transitionRuntimeCommand(
        snapshot.runtimeCommandId,
        ["PROVIDER_RECORDED"],
        "RESULT_PENDING",
        { result, resultHash: hashCanonical(result.result) },
        now(),
      );
      return true;
    }

    if (qrEncryptionKey === undefined) {
      options.spool.transitionRuntimeCommand(
        snapshot.runtimeCommandId,
        ["EFFECT_INTENT"],
        "AMBIGUOUS",
        { sealedReason: "QR_ENCRYPTION_KEY_UNAVAILABLE" },
        now(),
      );
      return true;
    }
    const payload = snapshot.payload as QrLoginCommand["payload"];
    let qr: string;
    try {
      // Supersede first, then take the gate: any outstanding `web.login.wait` stops
      // re-arming and releases, so this start never overlaps it. Overlapping is what
      // killed the cell with an out-of-memory abort - see `withLoginGate`.
      loginEpoch += 1;
      qr = qrDataUrl(await withLoginGate(() => options.cellRpc.invoke("web.login.start", {
        accountId: options.channelAccountId,
        force: true,
        verbose: false,
        timeoutMs: QR_START_TIMEOUT_MS,
      })));
    } catch {
      options.spool.transitionRuntimeCommand(
        snapshot.runtimeCommandId,
        ["EFFECT_INTENT"],
        "AMBIGUOUS",
        { sealedReason: "QR_START_OUTCOME_UNKNOWN" },
        now(),
      );
      return true;
    }
    const publishPayload = {
      version: 1,
      challengeId: payload.challengeId,
      runtimeCommandId: snapshot.runtimeCommandId,
      claimGeneration: snapshot.claimGeneration,
      claimToken: snapshot.claimToken,
      ...encryptQrMaterial(qrEncryptionKey, qr),
    };
    const ready = options.spool.transitionRuntimeCommand(
      snapshot.runtimeCommandId,
      ["EFFECT_INTENT"],
      "QR_MATERIAL_READY",
      { publishPayload },
      now(),
    );
    await publishQr(ready);
    return true;
  };

  const applyAcks = (acks: RuntimeCommandResultAck[]): void => {
    const validated = acks.map((ack) => {
      const snapshot = options.spool.runtimeCommandSnapshot(ack.runtimeCommandId);
      const result = snapshot?.result as Record<string, unknown> | null | undefined;
      if (
        snapshot === null || snapshot === undefined || snapshot.stage !== "RESULT_PENDING" ||
        snapshot.commandKind !== ack.commandKind || snapshot.claimGeneration !== ack.claimGeneration ||
        snapshot.resultHash !== ack.resultHash || result === null || result === undefined ||
        result.outcome !== ack.outcome ||
        (ack.adoptSessionGeneration !== null && ack.adoptSessionGeneration !== snapshot.targetSessionGeneration)
      ) fail("runtime command result acknowledgement does not match journal");
      return { ack, snapshot };
    });
    for (const { ack } of validated) {
      options.spool.acceptRuntimeCommandResult(
        ack.runtimeCommandId,
        ack.resultHash,
        ack.adoptSessionGeneration,
        now(),
      );
      if (ack.adoptSessionGeneration !== null) {
        options.runtime.adoptSessionGeneration(ack.adoptSessionGeneration);
      }
    }
  };

  return Object.freeze({
    async pulse(): Promise<void> {
      if (stopped) return;
      for (let iteration = 0; iteration < 6; iteration += 1) {
        const claimedStarts = options.spool.runtimeCommandStarts(MAX_COMMAND_BATCH);
        const renewals = options.spool.runtimeCommandRenewals(now(), 30_000, MAX_COMMAND_BATCH);
        const starts = [...new Map(
          [...claimedStarts, ...renewals].map((snapshot) => [snapshot.runtimeCommandId, snapshot]),
        ).values()].slice(0, MAX_COMMAND_BATCH);
        const results = options.spool.runtimeCommandResults(MAX_COMMAND_BATCH);
        const healthSignal = options.healthSignal?.() ?? null;
        const response = parseHeartbeatResponse(
          await options.runtime.post("/v1/heartbeat", {
            version: 1,
            commandClaimToken: claimToken,
            commandLeaseSeconds: COMMAND_LEASE_SECONDS,
            commandStarts: starts.map(startMarker),
            commandResults: results.map(commandResult),
            ...(healthSignal ?? {}),
          }),
          options.binding,
          claimToken,
          localSessionGeneration(),
        );
        applyAcks(response.commandResultAcks);
        for (const command of response.commands) {
          if (command.commandKind === "QR_LOGIN" && options.spool.hasBlockingRuntimeDisconnect()) {
            fail("QR command is blocked by an unresolved disconnect");
          }
          let snapshot = options.spool.recordRuntimeCommandClaim(command, now());
          if (command.executionState === "STARTED" && snapshot.stage === "CLAIMED") {
            snapshot = options.spool.transitionRuntimeCommand(
              command.runtimeCommandId,
              ["CLAIMED"],
              "START_AUTHORIZED",
              { effectDeadlineAt: command.effectDeadlineAt },
              now(),
            );
          }
          if (command.executionState === "STARTED") await execute(snapshot);
        }
        for (const snapshot of options.spool.runtimeCommandReconciliations(MAX_COMMAND_BATCH)) {
          await execute(snapshot);
        }
        const hasPendingStart = options.spool.runtimeCommandStarts(MAX_COMMAND_BATCH).length > 0;
        const hasPendingResult = options.spool.runtimeCommandResults(MAX_COMMAND_BATCH).length > 0;
        if (!hasPendingStart && !hasPendingResult) break;
      }
    },
    stop(): void {
      stopped = true;
    },
    async settle(): Promise<void> {
      await Promise.allSettled(background);
      qrEncryptionKey?.fill(0);
    },
  });
}
