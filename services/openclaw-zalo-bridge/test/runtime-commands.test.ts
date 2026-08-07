import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeCommandHeartbeat } from "../src/runtime-api/commands.js";
import { canonicalJson } from "../src/spool/checksum.js";
import { SqliteSpool } from "../src/spool/sqlite-spool.js";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const COMMAND_ID = "dddd5000-0000-4000-8000-000000000001";
const CLAIM_TOKEN = "dddd7000-0000-4000-8000-000000000001";
const CHANNEL_ACCOUNT_ID = "primary";
const NOW = Date.parse("2026-08-01T00:00:00.000Z");

const directories: string[] = [];
const spools: SqliteSpool[] = [];

afterEach(() => {
  for (const spool of spools.splice(0)) {
    try { spool.close(); } catch { /* already closed for restart testing */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function openSpool(path?: string): { spool: SqliteSpool; path: string } {
  const directory = path === undefined ? mkdtempSync(join(tmpdir(), "openclaw-command-")) : null;
  if (directory !== null) directories.push(directory);
  const spoolPath = path ?? join(directory!, "spool.db");
  const spool = new SqliteSpool(spoolPath);
  spools.push(spool);
  return { spool, path: spoolPath };
}

function command(
  commandKind: "QR_LOGIN" | "DISCONNECT",
  payload: unknown,
  executionState = "LEASED",
  effectDeadlineAt = "2026-08-01T00:00:45.000Z",
) {
  return {
    version: 1,
    runtimeCommandId: COMMAND_ID,
    commandKind,
    commandVersion: 1,
    claimGeneration: 1,
    claimToken: CLAIM_TOKEN,
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
    sourceSessionGeneration: 5,
    targetSessionGeneration: commandKind === "DISCONNECT" ? 6 : 5,
    // A command always ADVANCES the connection generation: the server writes
    // `target = source + 1` for both kinds and bumps the account to the target in
    // the same transaction, so `source` is one BEHIND `currentConnectionGeneration`.
    // This fixture used to make QR_LOGIN sit still at 3/3 - a shape the server
    // cannot produce - which is why the client's matching (and unsatisfiable)
    // check went unnoticed while every real QR command was rejected.
    sourceConnectionGeneration: commandKind === "DISCONNECT" ? 3 : 2,
    targetConnectionGeneration: commandKind === "DISCONNECT" ? 4 : 3,
    expectedFencingToken: 7,
    executionState,
    effectDeadlineAt: executionState === "STARTED" ? effectDeadlineAt : null,
    payload,
    payloadHash: sha256(payload),
  };
}

function heartbeat(options: {
  commands?: unknown[];
  commandResultAcks?: unknown[];
  authMode?: "NORMAL" | "COMMAND_TRANSITION";
  currentSessionGeneration?: number;
}) {
  const authMode = options.authMode ?? "NORMAL";
  return {
    version: 1,
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    cellId: CELL_ID,
    observedAt: "2026-08-01T00:00:00.000Z",
    accepted: true,
    authMode,
    currentSessionGeneration: options.currentSessionGeneration ?? 5,
    currentConnectionGeneration: authMode === "COMMAND_TRANSITION" ? 4 : 3,
    commandResultAcks: options.commandResultAcks ?? [],
    commands: options.commands ?? [],
  };
}

function runtime(responses: Array<unknown | Error>, generation = 5) {
  let localGeneration = generation;
  const bodies: unknown[] = [];
  return {
    bodies,
    client: {
      post: vi.fn(async (path: string, body: unknown) => {
        if (path !== "/v1/heartbeat" && path !== "/v1/qr/publish" && path !== "/v1/qr/result") {
          throw new Error(`unexpected path ${path}`);
        }
        bodies.push({ path, body });
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        if (response instanceof Error) throw response;
        return response;
      }),
      localSessionGeneration: () => localGeneration,
      adoptSessionGeneration: vi.fn((next: number) => { localGeneration = next; }),
      close: vi.fn(async () => undefined),
    },
  };
}

function createHeartbeat(options: {
  spool: SqliteSpool;
  runtime: ReturnType<typeof runtime>["client"];
  invoke: (method: string, params: unknown) => Promise<unknown>;
  qrEncryptionKey?: Uint8Array;
}) {
  return createRuntimeCommandHeartbeat({
    runtime: options.runtime,
    cellRpc: { invoke: vi.fn(options.invoke), close: vi.fn(async () => undefined) },
    binding: {
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
    },
    spool: options.spool,
    channelAccountId: CHANNEL_ACCOUNT_ID,
    commandClaimToken: CLAIM_TOKEN,
    now: () => NOW,
    ...(options.qrEncryptionKey === undefined ? {} : { qrEncryptionKey: options.qrEncryptionKey }),
  });
}

describe("durable runtime command heartbeat", () => {
  it("durably STARTs before logout, accepts real idempotent logout, and adopts the ACK generation", async () => {
    const payload = {
      version: 1,
      reasonCode: "ACCOUNT_DISCONNECT",
      revocationId: "dddd6000-0000-4000-8000-000000000001",
      revokedSessionGeneration: 5,
      minimumSessionGeneration: 6,
    };
    const providerResult = {
      version: 1,
      revocationId: payload.revocationId,
      revokedSessionGeneration: 5,
      minimumSessionGeneration: 6,
      channel: "zalouser",
      accountId: CHANNEL_ACCOUNT_ID,
      credentialsCleared: false,
      loggedOut: true,
      status: "PROVIDER_LOGGED_OUT",
    };
    const resultHash = sha256(providerResult);
    const runtimeHarness = runtime([
      heartbeat({ authMode: "COMMAND_TRANSITION", currentSessionGeneration: 6, commands: [command("DISCONNECT", payload)] }),
      heartbeat({
        authMode: "COMMAND_TRANSITION",
        currentSessionGeneration: 6,
        commands: [command("DISCONNECT", payload, "STARTED")],
      }),
      heartbeat({
        authMode: "COMMAND_TRANSITION",
        currentSessionGeneration: 6,
        commandResultAcks: [{
          version: 1,
          runtimeCommandId: COMMAND_ID,
          commandKind: "DISCONNECT",
          claimGeneration: 1,
          outcome: "PROVIDER_LOGGED_OUT",
          resultHash,
          adoptSessionGeneration: 6,
          status: "ACCEPTED",
        }],
      }),
    ]);
    const { spool } = openSpool();
    const logout = vi.fn(async () => ({
      channel: "zalouser",
      accountId: CHANNEL_ACCOUNT_ID,
      cleared: false,
      loggedOut: true,
      message: "already logged out",
    }));
    const consumer = createHeartbeat({ spool, runtime: runtimeHarness.client, invoke: logout });

    await consumer.pulse();

    expect(runtimeHarness.bodies).toHaveLength(3);
    expect(runtimeHarness.bodies[0]).toEqual({ path: "/v1/heartbeat", body: {
      version: 1,
      commandClaimToken: CLAIM_TOKEN,
      commandLeaseSeconds: 60,
      commandStarts: [],
      commandResults: [],
    } });
    expect(runtimeHarness.bodies[1]).toEqual({ path: "/v1/heartbeat", body: {
      version: 1,
      commandClaimToken: CLAIM_TOKEN,
      commandLeaseSeconds: 60,
      commandStarts: [{
        version: 1,
        runtimeCommandId: COMMAND_ID,
        commandKind: "DISCONNECT",
        claimGeneration: 1,
        claimToken: CLAIM_TOKEN,
        payloadHash: sha256(payload),
      }],
      commandResults: [],
    } });
    expect(runtimeHarness.bodies[2]).toEqual({ path: "/v1/heartbeat", body: {
      version: 1,
      commandClaimToken: CLAIM_TOKEN,
      commandLeaseSeconds: 60,
      commandStarts: [],
      commandResults: [{
        version: 1,
        runtimeCommandId: COMMAND_ID,
        commandKind: "DISCONNECT",
        claimGeneration: 1,
        claimToken: CLAIM_TOKEN,
        outcome: "PROVIDER_LOGGED_OUT",
        result: providerResult,
      }],
    } });
    expect(logout).toHaveBeenCalledOnce();
    expect(runtimeHarness.client.adoptSessionGeneration).toHaveBeenCalledWith(6);
    expect(spool.runtimeCommandSnapshot(COMMAND_ID)?.stage).toBe("SERVER_ACCEPTED");
  });

  it("replays a durable logout result after restart without calling logout twice", async () => {
    const payload = {
      version: 1,
      reasonCode: "ACCOUNT_DISCONNECT",
      revocationId: "dddd6000-0000-4000-8000-000000000001",
      revokedSessionGeneration: 5,
      minimumSessionGeneration: 6,
    };
    const firstRuntime = runtime([
      heartbeat({ authMode: "COMMAND_TRANSITION", currentSessionGeneration: 6, commands: [command("DISCONNECT", payload)] }),
      heartbeat({ authMode: "COMMAND_TRANSITION", currentSessionGeneration: 6, commands: [command("DISCONNECT", payload, "STARTED")] }),
      new Error("lost result response"),
    ]);
    const opened = openSpool();
    const firstLogout = vi.fn(async () => ({
      channel: "zalouser", accountId: CHANNEL_ACCOUNT_ID, cleared: true, loggedOut: true,
    }));
    const first = createHeartbeat({ spool: opened.spool, runtime: firstRuntime.client, invoke: firstLogout });
    await expect(first.pulse()).rejects.toThrow(/lost result response/i);
    opened.spool.close();

    const restarted = openSpool(opened.path);
    const stored = restarted.spool.runtimeCommandSnapshot(COMMAND_ID)!;
    expect(stored.stage).toBe("RESULT_PENDING");
    const secondRuntime = runtime([heartbeat({
      authMode: "COMMAND_TRANSITION",
      currentSessionGeneration: 6,
      commandResultAcks: [{
        version: 1,
        runtimeCommandId: COMMAND_ID,
        commandKind: "DISCONNECT",
        claimGeneration: 1,
        outcome: "PROVIDER_LOGGED_OUT",
        resultHash: stored.resultHash,
        adoptSessionGeneration: 6,
        status: "ACCEPTED",
      }],
    })]);
    const secondLogout = vi.fn();
    const second = createHeartbeat({ spool: restarted.spool, runtime: secondRuntime.client, invoke: secondLogout });

    await second.pulse();

    expect(secondLogout).not.toHaveBeenCalled();
    expect((secondRuntime.bodies[0] as { body: { commandResults: unknown[] } }).body.commandResults)
      .toEqual([stored.result]);
    expect(secondRuntime.client.adoptSessionGeneration).toHaveBeenCalledWith(6);
  });

  it("never re-runs QR start after a crash-window EFFECT_INTENT without QR bytes", async () => {
    const payload = {
      version: 1,
      challengeId: "dddd6000-0000-4000-8000-000000000002",
      browserNonceHash: "a".repeat(64),
    };
    const firstRuntime = runtime([
      heartbeat({ commands: [command("QR_LOGIN", payload)] }),
      heartbeat({ commands: [command("QR_LOGIN", payload, "STARTED")] }),
    ]);
    const opened = openSpool();
    const firstStart = vi.fn(async () => { throw new Error("provider response lost"); });
    const first = createHeartbeat({
      spool: opened.spool,
      runtime: firstRuntime.client,
      invoke: firstStart,
      qrEncryptionKey: Buffer.alloc(32, 7),
    });
    await first.pulse();
    expect(opened.spool.runtimeCommandSnapshot(COMMAND_ID)?.stage).toBe("AMBIGUOUS");
    opened.spool.close();

    const restarted = openSpool(opened.path);
    const secondRuntime = runtime([heartbeat({ commands: [command("QR_LOGIN", payload, "STARTED")] })]);
    const secondStart = vi.fn();
    const second = createHeartbeat({
      spool: restarted.spool,
      runtime: secondRuntime.client,
      invoke: secondStart,
      qrEncryptionKey: Buffer.alloc(32, 7),
    });
    await second.pulse();

    expect(secondStart).not.toHaveBeenCalled();
    expect(restarted.spool.runtimeCommandSnapshot(COMMAND_ID)?.stage).toBe("AMBIGUOUS");
  });

  /**
   * What `openclaw_submit_qr_result_v1` actually answers, on BOTH its branches.
   * The Edge does not reshape it: `/v1/qr/publish` falls through to
   * `onlyVersionedObject`, which checks nothing but `version`.
   */
  const publishResult = (challengeId: string) => ({
    version: 1,
    challengeId,
    materialVersion: 1,
    publishedAt: "2026-08-01T00:00:01.000Z",
    accepted: true,
  });

  /** What `openclaw_finalize_account_connection_v1` actually answers. */
  const connectionResult = () => ({
    version: 1,
    accountId: ACCOUNT_ID,
    connectionGeneration: 4,
    connectionState: "CONNECTED",
    evidenceHash: "b".repeat(64),
  });

  // The regression that stopped every QR after the first one. The fixtures used to
  // carry a three-key publish response the server has never sent, so an exact-key
  // check passed here and threw in production on every publish - leaving the command
  // at QR_MATERIAL_READY, republishing on every pulse, taking the heartbeat down with
  // it, and stranding the cockpit at "Đang chờ máy chủ phát mã".
  it("completes a QR login against the shapes the server really returns", async () => {
    const payload = {
      version: 1,
      challengeId: "dddd6000-0000-4000-8000-000000000002",
      browserNonceHash: "a".repeat(64),
    };
    const qrDataUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
    const harness = runtime([
      heartbeat({ commands: [command("QR_LOGIN", payload)] }),
      heartbeat({ commands: [command("QR_LOGIN", payload, "STARTED")] }),
      publishResult(payload.challengeId),
      connectionResult(),
    ]);
    const { spool } = openSpool();
    const invoke = vi.fn(async (method: string) => {
      if (method === "web.login.start") return { message: "scan", qrDataUrl, connected: false };
      if (method === "web.login.wait") return { connected: true, message: "connected" };
      throw new Error(`unexpected method ${method}`);
    });
    const consumer = createHeartbeat({
      spool,
      runtime: harness.client,
      invoke,
      qrEncryptionKey: Buffer.alloc(32, 7),
    });

    await consumer.pulse();
    await consumer.stop();

    // The publish was accepted, so the command must LEAVE QR_MATERIAL_READY. Staying
    // there is exactly the loop that jammed production.
    expect(spool.runtimeCommandSnapshot(COMMAND_ID)?.stage).not.toBe("QR_MATERIAL_READY");
    expect(harness.bodies.map((entry) => entry.path)).toContain("/v1/qr/result");
  });

  // The crash that made every second QR fail. `web.login.start` overlapping an
  // outstanding `web.login.wait` drives the cell gateway out of memory in ~60s, so
  // the request that arrives during the restart is answered by nothing and the code
  // behind the one already on screen is dead. Measured on the live cell: three
  // overlapping starts, three aborts; three non-overlapping ones, heap flat.
  it("never runs web.login.start while a web.login.wait is outstanding", async () => {
    const payload = {
      version: 1,
      challengeId: "dddd6000-0000-4000-8000-000000000002",
      browserNonceHash: "a".repeat(64),
    };
    const qrDataUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
    const later = {
      ...command("QR_LOGIN", payload, "STARTED"),
      runtimeCommandId: "dddd5000-0000-4000-8000-000000000002",
    };
    const harness = runtime([
      heartbeat({ commands: [command("QR_LOGIN", payload)] }),
      heartbeat({ commands: [command("QR_LOGIN", payload, "STARTED")] }),
      publishResult(payload.challengeId),
      heartbeat({ commands: [later] }),
      publishResult(payload.challengeId),
      connectionResult(),
    ]);
    const { spool } = openSpool();

    let waitsOutstanding = 0;
    let overlaps = 0;
    let waitCalls = 0;
    const invoke = vi.fn(async (method: string) => {
      if (method === "web.login.start") {
        if (waitsOutstanding > 0) overlaps += 1;
        return { message: "scan", qrDataUrl, connected: false };
      }
      if (method === "web.login.wait") {
        waitsOutstanding += 1;
        waitCalls += 1;
        try {
          await new Promise((resolve) => { setTimeout(resolve, 5); });
          // Nobody has scanned yet. The old code sealed here; the fix re-arms.
          return { connected: waitCalls > 2, message: "pending" };
        } finally {
          waitsOutstanding -= 1;
        }
      }
      throw new Error(`unexpected method ${method}`);
    });
    const consumer = createHeartbeat({
      spool,
      runtime: harness.client,
      invoke,
      qrEncryptionKey: Buffer.alloc(32, 7),
    });

    await consumer.pulse();
    // A second "Lấy mã QR" lands while the first code is still being waited on.
    await consumer.pulse();
    await consumer.stop();

    expect(overlaps).toBe(0);
    // An unscanned code must be re-armed, not sealed on the first empty answer.
    expect(waitCalls).toBeGreaterThan(1);
  });

  // Renewing a QR command the server has already finished with is fatal, not wasteful.
  //
  // `/v1/qr/publish` sets the server row to ACKNOWLEDGED and nulls its claim token and
  // lease. A start-marker for such a command makes the facade raise 40001, which rolls
  // back the WHOLE heartbeat transaction - and because the journal's leaseExpiresAt is
  // frozen at that moment, the renewal filter matches forever. Every later heartbeat
  // dies the same way: no command is ever leased again and no QR ever appears, while
  // the process stays up. Excluding LOGIN_WAITING alone is not enough; every QR stage
  // from QR_MATERIAL_READY onward carries the same poison, because a lost publish
  // response leaves the journal behind the server.
  it("never renews a QR command the server has already acknowledged", () => {
    const { spool } = openSpool();
    const payload = {
      version: 1,
      challengeId: "dddd6000-0000-4000-8000-000000000002",
      browserNonceHash: "a".repeat(64),
    };
    spool.recordRuntimeCommandClaim(command("QR_LOGIN", payload, "STARTED"), NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["CLAIMED"], "START_AUTHORIZED", {}, NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["START_AUTHORIZED"], "EFFECT_INTENT", {}, NOW);
    // Long past the frozen lease - exactly when the old filter matched forever.
    const later = NOW + 10 * 60_000;

    for (const stage of ["QR_MATERIAL_READY", "PUBLISH_PENDING", "LOGIN_WAITING", "PROVIDER_RECORDED"] as const) {
      const from = spool.runtimeCommandSnapshot(COMMAND_ID)!.stage;
      spool.transitionRuntimeCommand(COMMAND_ID, [from], stage, {}, NOW);
      expect(spool.runtimeCommandRenewals(later).map((s) => s.stage)).toEqual([]);
    }
  });

  // The other direction, so the fix above cannot be over-applied: a DISCONNECT stays
  // STARTED server-side until its result is accepted, so it must still be renewed.
  it("still renews a DISCONNECT waiting for its result to be accepted", () => {
    const { spool } = openSpool();
    const payload = {
      version: 1,
      reasonCode: "ACCOUNT_DISCONNECT",
      revocationId: "dddd6000-0000-4000-8000-000000000001",
      revokedSessionGeneration: 5,
      minimumSessionGeneration: 6,
    };
    spool.recordRuntimeCommandClaim(command("DISCONNECT", payload, "STARTED"), NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["CLAIMED"], "START_AUTHORIZED", {}, NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["START_AUTHORIZED"], "EFFECT_INTENT", {}, NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["EFFECT_INTENT"], "PROVIDER_RECORDED", {}, NOW);

    expect(spool.runtimeCommandRenewals(NOW + 10 * 60_000).map((s) => s.stage))
      .toEqual(["PROVIDER_RECORDED"]);
  });

  // The scan the owner really made, that the system reported as "nobody scanned".
  //
  // `waitForZaloQrLogin` calls `resetQrLogin(profile)` BEFORE answering
  // {connected:true}, so the confirmation exists nowhere but in that one response -
  // every later `web.login.wait` answers "No active Zalo QR login in progress" in
  // ~55ms. A failed `/v1/qr/result` therefore used to destroy a real login: the throw
  // vanished into a swallowed catch, the next pulse went back to waiting on an attempt
  // that no longer existed, and the deadline sealed it QR_EXPIRED_UNSCANNED while Zalo
  // had already told the owner's phone the login succeeded.
  it("keeps a provider-confirmed scan across a failed report and retries it", async () => {
    const payload = {
      version: 1,
      challengeId: "dddd6000-0000-4000-8000-000000000002",
      browserNonceHash: "a".repeat(64),
    };
    const qrDataUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
    const harness = runtime([
      heartbeat({ commands: [command("QR_LOGIN", payload)] }),
      heartbeat({ commands: [command("QR_LOGIN", payload, "STARTED")] }),
      publishResult(payload.challengeId),
      new Error("qr result response lost"),
      heartbeat({}),
      connectionResult(),
    ]);
    const { spool } = openSpool();
    let waits = 0;
    const invoke = vi.fn(async (method: string) => {
      if (method === "web.login.start") return { message: "scan", qrDataUrl, connected: false };
      if (method === "web.login.wait") {
        waits += 1;
        // The provider confirms once, then forgets - exactly like the real one.
        if (waits === 1) return { connected: true, message: "Login successful." };
        return { connected: false, message: "No active Zalo QR login in progress." };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const consumer = createHeartbeat({
      spool,
      runtime: harness.client,
      invoke,
      qrEncryptionKey: Buffer.alloc(32, 7),
    });

    await consumer.pulse();
    await new Promise((resolve) => { setTimeout(resolve, 40); });

    // The report failed, but the scan must survive it.
    expect(spool.runtimeCommandSnapshot(COMMAND_ID)?.stage).toBe("PROVIDER_RECORDED");

    await consumer.pulse();
    await consumer.stop();

    const snapshot = spool.runtimeCommandSnapshot(COMMAND_ID);
    expect(snapshot?.stage).toBe("SEALED");
    expect(snapshot?.sealedReason).toBe("QR_LOGIN_CONFIRMED");
    // The retry must be the report, never another wait against a dead attempt.
    expect(harness.bodies.filter((entry) => entry.path === "/v1/qr/result")).toHaveLength(2);
  });

  it("replays byte-identical encrypted QR publication after a lost response", async () => {
    const payload = {
      version: 1,
      challengeId: "dddd6000-0000-4000-8000-000000000002",
      browserNonceHash: "a".repeat(64),
    };
    const qrDataUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
    const firstRuntime = runtime([
      heartbeat({ commands: [command("QR_LOGIN", payload)] }),
      heartbeat({ commands: [command("QR_LOGIN", payload, "STARTED")] }),
      new Error("publish response lost"),
    ]);
    const opened = openSpool();
    const firstStart = vi.fn(async (method: string) => {
      if (method === "web.login.start") return { message: "scan", qrDataUrl, connected: false };
      throw new Error(`unexpected method ${method}`);
    });
    const first = createHeartbeat({
      spool: opened.spool,
      runtime: firstRuntime.client,
      invoke: firstStart,
      qrEncryptionKey: Buffer.alloc(32, 7),
    });
    await expect(first.pulse()).rejects.toThrow(/publish response lost/i);
    const firstPublish = firstRuntime.bodies[2];
    opened.spool.close();

    const restarted = openSpool(opened.path);
    const secondRuntime = runtime([
      heartbeat({ commands: [command("QR_LOGIN", payload, "STARTED")] }),
      publishResult(payload.challengeId),
    ]);
    const secondStart = vi.fn();
    const second = createHeartbeat({
      spool: restarted.spool,
      runtime: secondRuntime.client,
      invoke: secondStart,
      qrEncryptionKey: Buffer.alloc(32, 7),
    });
    await second.pulse();

    expect(secondStart).not.toHaveBeenCalledWith("web.login.start", expect.anything());
    expect(secondRuntime.bodies[1]).toEqual(firstPublish);
  });

  it("does not initiate a provider effect with less than fifteen seconds remaining", async () => {
    const payload = {
      version: 1,
      challengeId: "dddd6000-0000-4000-8000-000000000002",
      browserNonceHash: "a".repeat(64),
    };
    const runtimeHarness = runtime([
      heartbeat({ commands: [command("QR_LOGIN", payload)] }),
      heartbeat({ commands: [command(
        "QR_LOGIN",
        payload,
        "STARTED",
        "2026-08-01T00:00:10.000Z",
      )] }),
    ]);
    const { spool } = openSpool();
    const start = vi.fn();
    const consumer = createHeartbeat({
      spool,
      runtime: runtimeHarness.client,
      invoke: start,
      qrEncryptionKey: Buffer.alloc(32, 7),
    });

    await consumer.pulse();

    expect(start).not.toHaveBeenCalled();
    expect(spool.runtimeCommandSnapshot(COMMAND_ID)).toMatchObject({
      stage: "AMBIGUOUS",
      sealedReason: "INSUFFICIENT_EFFECT_DEADLINE",
    });
  });

  it("renews the same STARTED claim token when its lease has at most thirty seconds left", async () => {
    const payload = {
      version: 1,
      reasonCode: "ACCOUNT_DISCONNECT",
      revocationId: "dddd6000-0000-4000-8000-000000000001",
      revokedSessionGeneration: 5,
      minimumSessionGeneration: 6,
    };
    const { spool } = openSpool();
    const started = {
      ...command("DISCONNECT", payload, "STARTED"),
      leaseExpiresAt: "2026-08-01T00:00:20.000Z",
    };
    spool.recordRuntimeCommandClaim(started, NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["CLAIMED"], "START_AUTHORIZED", {
      effectDeadlineAt: started.effectDeadlineAt,
    }, NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["START_AUTHORIZED"], "EFFECT_INTENT", {}, NOW);
    const runtimeHarness = runtime([heartbeat({
      authMode: "COMMAND_TRANSITION",
      currentSessionGeneration: 6,
      commands: [command("DISCONNECT", payload, "STARTED")],
    })]);
    const consumer = createHeartbeat({
      spool,
      runtime: runtimeHarness.client,
      invoke: async () => { throw new Error("stop after renewal"); },
    });

    await expect(consumer.pulse()).rejects.toThrow(/stop after renewal/i);

    expect((runtimeHarness.bodies[0] as { body: { commandStarts: unknown[] } }).body.commandStarts)
      .toEqual([{
        version: 1,
        runtimeCommandId: COMMAND_ID,
        commandKind: "DISCONNECT",
        claimGeneration: 1,
        claimToken: CLAIM_TOKEN,
        payloadHash: sha256(payload),
      }]);
  });

  it("cleans up a late QR success after a newer disconnect without posting qr/result", async () => {
    const qrPayload = {
      version: 1,
      challengeId: "dddd6000-0000-4000-8000-000000000002",
      browserNonceHash: "a".repeat(64),
    };
    const disconnectPayload = {
      version: 1,
      reasonCode: "ACCOUNT_DISCONNECT",
      revocationId: "dddd6000-0000-4000-8000-000000000001",
      revokedSessionGeneration: 5,
      minimumSessionGeneration: 6,
    };
    const { spool } = openSpool();
    spool.recordRuntimeCommandClaim(command("QR_LOGIN", qrPayload, "STARTED"), NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["CLAIMED"], "START_AUTHORIZED", {
      effectDeadlineAt: "2026-08-01T00:00:45.000Z",
    }, NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["START_AUTHORIZED"], "EFFECT_INTENT", {}, NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["EFFECT_INTENT"], "QR_MATERIAL_READY", {
      publishPayload: { version: 1, challengeId: qrPayload.challengeId },
    }, NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["QR_MATERIAL_READY"], "LOGIN_WAITING", {}, NOW);
    const disconnectId = "dddd5000-0000-4000-8000-000000000002";
    spool.recordRuntimeCommandClaim({
      ...command("DISCONNECT", disconnectPayload),
      runtimeCommandId: disconnectId,
    }, NOW);
    spool.transitionRuntimeCommand(
      disconnectId,
      ["CLAIMED"],
      "AMBIGUOUS",
      { sealedReason: "DISCONNECT_OUTCOME_UNKNOWN" },
      NOW,
    );
    const runtimeHarness = runtime([heartbeat({})]);
    const invoke = vi.fn(async (method: string) => {
      if (method === "web.login.wait") return { connected: true, message: "connected" };
      if (method === "channels.logout") return {
        channel: "zalouser",
        accountId: CHANNEL_ACCOUNT_ID,
        cleared: false,
        loggedOut: true,
        message: "cleanup",
      };
      throw new Error(`unexpected method ${method}`);
    });
    const consumer = createHeartbeat({ spool, runtime: runtimeHarness.client, invoke });

    await consumer.pulse();
    await consumer.settle();

    expect(runtimeHarness.bodies.map((entry) => (entry as { path: string }).path))
      .not.toContain("/v1/qr/result");
    expect(invoke).toHaveBeenCalledWith("channels.logout", {
      channel: "zalouser",
      accountId: CHANNEL_ACCOUNT_ID,
    });
    expect(spool.runtimeCommandSnapshot(COMMAND_ID)).toMatchObject({
      stage: "SEALED",
      sealedReason: "STALE_QR_AFTER_DISCONNECT",
    });
  });

  it("retains the whole durable result when the server ACK hash is not exact", async () => {
    const payload = {
      version: 1,
      reasonCode: "ACCOUNT_DISCONNECT",
      revocationId: "dddd6000-0000-4000-8000-000000000001",
      revokedSessionGeneration: 5,
      minimumSessionGeneration: 6,
    };
    const { spool } = openSpool();
    spool.recordRuntimeCommandClaim(command("DISCONNECT", payload, "STARTED"), NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["CLAIMED"], "START_AUTHORIZED", {
      effectDeadlineAt: "2026-08-01T00:00:45.000Z",
    }, NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["START_AUTHORIZED"], "EFFECT_INTENT", {}, NOW);
    spool.transitionRuntimeCommand(COMMAND_ID, ["EFFECT_INTENT"], "PROVIDER_RECORDED", {}, NOW);
    const result = {
      version: 1,
      runtimeCommandId: COMMAND_ID,
      commandKind: "DISCONNECT",
      claimGeneration: 1,
      claimToken: CLAIM_TOKEN,
      outcome: "PROVIDER_LOGGED_OUT",
      result: {
        version: 1,
        revocationId: payload.revocationId,
        revokedSessionGeneration: 5,
        minimumSessionGeneration: 6,
        channel: "zalouser",
        accountId: CHANNEL_ACCOUNT_ID,
        credentialsCleared: false,
        loggedOut: true,
        status: "PROVIDER_LOGGED_OUT",
      },
    };
    spool.transitionRuntimeCommand(COMMAND_ID, ["PROVIDER_RECORDED"], "RESULT_PENDING", {
      result,
      resultHash: sha256(result.result),
    }, NOW);
    const runtimeHarness = runtime([heartbeat({
      authMode: "COMMAND_TRANSITION",
      currentSessionGeneration: 6,
      commandResultAcks: [{
        version: 1,
        runtimeCommandId: COMMAND_ID,
        commandKind: "DISCONNECT",
        claimGeneration: 1,
        outcome: "PROVIDER_LOGGED_OUT",
        resultHash: "f".repeat(64),
        adoptSessionGeneration: 6,
        status: "ACCEPTED",
      }],
    })]);
    const consumer = createHeartbeat({ spool, runtime: runtimeHarness.client, invoke: vi.fn() });

    await expect(consumer.pulse()).rejects.toThrow(/does not match journal/i);

    expect(spool.runtimeCommandSnapshot(COMMAND_ID)).toMatchObject({
      stage: "RESULT_PENDING",
      resultHash: sha256(result.result),
      result,
    });
    expect(runtimeHarness.client.adoptSessionGeneration).not.toHaveBeenCalled();
  });
});
