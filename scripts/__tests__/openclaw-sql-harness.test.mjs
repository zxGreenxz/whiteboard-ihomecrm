import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  DEMO_ORG_ID,
  EXPECTED_PROJECT_REF,
  PROD_ORG_ID,
  assertLiveDemoTarget,
  assertSafeHarnessOutput,
  parseSqlHarnessArgs,
  redactSensitiveText,
  runSqlHarness,
} from "../test-openclaw-sql.mjs";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalSendSha256(value) {
  return createHash("sha256")
    .update("ihome-openclaw-send-v1", "utf8")
    .update(Buffer.from([0]))
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalDomainSha256(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(Buffer.from([0]))
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function domainTextSha256(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(Buffer.from([0]))
    .update(value, "utf8")
    .digest("hex");
}

const REQUIRED_SQL_AUTHORIZATION_PROOFS = Object.freeze([
  "membership.inactive-revoked",
  "permissions.mixed",
  "tenant.wrong-account",
  "tenant.composite-fk",
  "qr.unique",
  "outbox-work.claim-cas",
  "marker.mint-consume-ttl",
  "completion-requeue.serialization",
  "inbound.atomic-commit",
  "work-outbox.atomic-rollback",
  "policy.stale-rejected",
  "audit.immutability-receipt",
  "retention.hold-version-receipt",
  "rollout.stage-cas",
  "realtime.safe-publication",
  "operation.scope-separation",
  "claims.non-null-lineage",
  "maintenance.channel-paused",
  "tenant.cross-org-stale-credential",
]);

const REQUIRED_CREDENTIAL_EXCHANGE_PROOFS = Object.freeze([
  "credential.channel-success",
  "credential.declared-channel-routes",
  "credential.maintenance-success",
  "credential.wrong-proof-domain-separated",
  "credential.cross-binding-denied",
  "credential.scope-revocation-denied",
  "credential.stale-principal-lease-denied",
  "credential.expired-envelope-denied",
  "credential.malformed-input-denied",
  "credential.auth-failure-does-not-consume-nonce",
  "credential.nonce-replay-denied",
  "credential.exchange-nonce-namespace-separated",
  "credential.disconnect-transition-heartbeat-only",
]);

const QR_ACTOR_ID = "99999999-9999-4999-8999-999999999999";
const QR_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const QR_CELL_ID = "22222222-2222-4222-8222-222222222222";

async function createQrControlDatabase({
  disclosureAcknowledged = true,
  connectionState = "DISCONNECTED",
  sessionGeneration = 1,
  connectionGeneration = 0,
} = {}) {
  const {
    createDisposableOpenClawDatabase,
    prepareDisposableConcurrencyFixtures,
  } = await import("../test-openclaw-migrations.mjs");
  const database = await createDisposableOpenClawDatabase();
  await prepareDisposableConcurrencyFixtures(database);
  await database.exec(`
    select set_config('request.jwt.claim.sub','${QR_ACTOR_ID}',false);
    set session_replication_role='replica';
    update public.openclaw_accounts
    set connection_state='${connectionState}', effective_mode='DRAFT_ONLY',
        paused_at=null, session_generation=${sessionGeneration},
        connection_generation=${connectionGeneration},
        disclosure_acknowledged_version=${disclosureAcknowledged ? "1" : "null"},
        disclosure_acknowledged_at=${disclosureAcknowledged ? "statement_timestamp()" : "null"}
    where organization_id='${DEMO_ORG_ID}' and id='${QR_ACCOUNT_ID}';
    set session_replication_role='origin';
  `);
  return database;
}

function qrBeginRequest(overrides = {}) {
  return {
    version: 1,
    organizationId: DEMO_ORG_ID,
    accountId: QR_ACCOUNT_ID,
    cellId: QR_CELL_ID,
    browserNonceHash: "a".repeat(64),
    authSessionHash: "b".repeat(64),
    disclosureVersion: 1,
    ...overrides,
  };
}

function qrRuntimePrincipal(overrides = {}) {
  return {
    version: 1,
    principalKind: "CHANNEL",
    organizationId: DEMO_ORG_ID,
    accountId: QR_ACCOUNT_ID,
    cellId: QR_CELL_ID,
    credentialGeneration: 1,
    leaseGeneration: 1,
    fencingToken: 1,
    sessionGeneration: 1,
    localSessionGeneration: 1,
    authMode: "NORMAL",
    ...overrides,
  };
}

async function beginQrLogin(database, clientOperationId, request = qrBeginRequest()) {
  const result = await database.query(
    `select public.openclaw_begin_qr_login_v1($1::jsonb,$2::uuid) result`,
    [JSON.stringify(request), clientOperationId],
  );
  return result.rows[0].result;
}

async function publishQrMaterial(database, qr, principal = qrRuntimePrincipal()) {
  const claimToken = `qr-command-${qr.runtimeCommandId}`;
  let heartbeat;
  try {
    heartbeat = await database.query(
      `select app_private.openclaw_runtime_heartbeat_v1(
         $1::jsonb,'{}'::jsonb,$2::jsonb
       ) result`,
      [JSON.stringify(principal), JSON.stringify({
        version: 1,
        commandClaimToken: claimToken,
        commandLeaseSeconds: 60,
        commandStarts: [],
        commandResults: [],
      })],
    );
  } catch {
    throw new Error("QR runtime command is not available.");
  }
  const command = heartbeat.rows[0].result.commands.find(
    (candidate) => candidate.runtimeCommandId === qr.runtimeCommandId,
  );
  if (!command) throw new Error("QR runtime command is not available.");
  const claimHash = createHash("sha256")
    .update("ihome-openclaw-runtime-command-claim-v1\0", "utf8")
    .update(claimToken, "utf8")
    .digest("hex");
  const started = await database.query(
    `update public.openclaw_runtime_commands set
       state='STARTED',started_at=statement_timestamp(),
       effect_deadline_at=statement_timestamp()+interval '60 seconds'
     where organization_id=$1 and id=$2 and state='LEASED'
       and claim_generation=$3 and claim_token_hash=$4
     returning id`,
    [DEMO_ORG_ID, command.runtimeCommandId, command.claimGeneration, claimHash],
  );
  if (started.rows.length !== 1) throw new Error("QR runtime command is not available.");
  const request = {
    version: 1,
    challengeId: qr.challengeId,
    runtimeCommandId: qr.runtimeCommandId,
    claimGeneration: command.claimGeneration,
    claimToken,
    ciphertextB64: Buffer.alloc(32, 1).toString("base64"),
    cipherIvB64: Buffer.alloc(12, 2).toString("base64"),
    authTagB64: Buffer.alloc(16, 3).toString("base64"),
  };
  const result = await database.query(
    `select app_private.openclaw_submit_qr_result_v1(
       $1::jsonb,'{}'::jsonb,$2::jsonb
     ) result`,
    [JSON.stringify(principal), JSON.stringify(request)],
  );
  return { request, result: result.rows[0].result };
}

async function consumeQrMaterial(
  database,
  qr,
  clientOperationId,
  request = qrBeginRequest(),
) {
  const result = await database.query(
    `select public.openclaw_service_consume_qr_challenge_v1(
       $1::uuid,$2::jsonb,$3::uuid
     ) result`,
    [
      QR_ACTOR_ID,
      JSON.stringify({
        version: 1,
        organizationId: DEMO_ORG_ID,
        accountId: QR_ACCOUNT_ID,
        challengeId: qr.challengeId,
        browserNonceHash: request.browserNonceHash,
        authSessionHash: request.authSessionHash,
      }),
      clientOperationId,
    ],
  );
  return result.rows[0].result;
}

describe("OpenClaw SQL harness safety boundary", () => {
  it("freezes the project and organization identities", () => {
    expect(EXPECTED_PROJECT_REF).toBe("tryymsxyyckgbrmmvozx");
    expect(DEMO_ORG_ID).toBe("dddd0000-0000-4000-8000-000000000001");
    expect(PROD_ORG_ID).toBe("aaaa0000-0000-4000-8000-000000000001");
  });

  it("accepts only explicit local or protected live-demo modes", () => {
    expect(parseSqlHarnessArgs(["--local"])).toEqual({ mode: "local" });
    expect(parseSqlHarnessArgs(["--live-demo"])).toEqual({ mode: "live-demo" });
    expect(() => parseSqlHarnessArgs([])).toThrow(/explicit/i);
    expect(() => parseSqlHarnessArgs(["--live-demo", "--local"])).toThrow(/exactly one/i);
    expect(() => parseSqlHarnessArgs(["--project-ref", EXPECTED_PROJECT_REF])).toThrow(
      /explicit/i,
    );
  });

  it("rejects a wrong project, PROD fixture, or unapplied manifest before transport", async () => {
    expect(() =>
      assertLiveDemoTarget({
        projectRef: "wrongprojectref00000",
        organizationId: DEMO_ORG_ID,
        authorized: true,
      }),
    ).toThrow(/project ref/i);
    expect(() =>
      assertLiveDemoTarget({
        projectRef: EXPECTED_PROJECT_REF,
        organizationId: PROD_ORG_ID,
        authorized: true,
      }),
    ).toThrow(/PROD/i);
    expect(() =>
      assertLiveDemoTarget({
        projectRef: EXPECTED_PROJECT_REF,
        organizationId: DEMO_ORG_ID,
        authorized: false,
      }),
    ).toThrow(/authorized/i);

    const transport = vi.fn();
    await expect(
      runSqlHarness({
        args: ["--live-demo"],
        environment: {
          OPENCLAW_PROJECT_REF: "wrongprojectref00000",
          OPENCLAW_DEMO_ORG_ID: DEMO_ORG_ID,
          OPENCLAW_AUTHORIZED_LIVE_DEMO: "1",
        },
        transport,
      }),
    ).rejects.toThrow(/project ref/i);
    expect(transport).not.toHaveBeenCalled();

    const authorizedTransport = vi.fn(async () => ({ summary: "PASS live DEMO" }));
    const authorized = await runSqlHarness({
      args: ["--live-demo"],
      environment: {
        OPENCLAW_PROJECT_REF: EXPECTED_PROJECT_REF,
        OPENCLAW_DEMO_ORG_ID: DEMO_ORG_ID,
        OPENCLAW_AUTHORIZED_LIVE_DEMO: "1",
      },
      transport: authorizedTransport,
    });
    expect(authorized.organizationId).toBe(DEMO_ORG_ID);
    expect(authorizedTransport).toHaveBeenCalledOnce();
  });

  it("refuses possible secret output", () => {
    expect(() => assertSafeHarnessOutput("ok: rollback complete")).not.toThrow();
    expect(() => assertSafeHarnessOutput("token=sbp_secret-1234567890")).toThrow(/secret/i);
    expect(() =>
      assertSafeHarnessOutput("postgresql://postgres:password@localhost:5432/postgres"),
    ).toThrow(/secret/i);
    expect(() => assertSafeHarnessOutput("claimToken=private-value")).toThrow(/secret/i);
  });

  it("redacts every supported secret shape before a CLI error is printed", () => {
    const samples = [
      ["token=sbp_secret-1234567890", ["sbp_secret-1234567890"]],
      [
        "postgresql://postgres:database-password@localhost:5432/postgres",
        ["database-password"],
      ],
      ["claimToken=private-claim-value", ["private-claim-value"]],
      ["markerNonce: private-marker-value", ["private-marker-value"]],
      ["credentialHash=private-credential-hash", ["private-credential-hash"]],
      [
        "credentialProofSha256=private-credential-proof",
        ["private-credential-proof"],
      ],
      ["SUPABASE_PAT=opaque-personal-access-token", ["opaque-personal-access-token"]],
      [
        "Authorization: Bearer opaque.bearer.token-value-1234567890",
        ["opaque.bearer.token-value-1234567890"],
      ],
      ["Authorization: Basic dXNlcjpwYXNzd29yZA==", ["dXNlcjpwYXNzd29yZA=="]],
      [
        "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-value",
        ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-value"],
      ],
      ['{"claimToken":"json-private-claim"}', ["json-private-claim"]],
      ['{"markerNonce":"json-private-marker"}', ["json-private-marker"]],
      ["Cookie: session=private-cookie-value", ["private-cookie-value"]],
      ["Set-Cookie: session=private-set-cookie-value", ["private-set-cookie-value"]],
      ["qrPayload=private-qr-payload", ["private-qr-payload"]],
      ["OPENAI_API_KEY=model-provider-private-key", ["model-provider-private-key"]],
      [
        "https://media.example.invalid/object?token=private-ticket&signature=private-signature",
        ["private-ticket", "private-signature"],
      ],
    ];

    for (const [sample, secrets] of samples) {
      const redacted = redactSensitiveText(`failure ${sample}`);
      expect(redacted, sample).toContain("[REDACTED");
      for (const secret of secrets) expect(redacted, sample).not.toContain(secret);
      expect(() => assertSafeHarnessOutput(sample), sample).toThrow(/secret/i);
    }

    const exactSecret = "opaque-value-with-no-secret-shaped-prefix";
    const exactRedaction = redactSensitiveText(
      `transport failed with ${exactSecret}`,
      [exactSecret],
    );
    expect(exactRedaction).toContain("[REDACTED");
    expect(exactRedaction).not.toContain(exactSecret);
  });

  it("executes the complete rollback-only SQL authorization matrix", async () => {
    const { SQL_AUTHORIZATION_PROOFS, runDisposableSqlAuthorizationMatrix } =
      await import("../test-openclaw-migrations.mjs");

    expect(SQL_AUTHORIZATION_PROOFS).toEqual(REQUIRED_SQL_AUTHORIZATION_PROOFS);
    const result = await runDisposableSqlAuthorizationMatrix();
    expect(result.proofs).toEqual(REQUIRED_SQL_AUTHORIZATION_PROOFS);
  }, 30_000);

  it("authenticates root credentials before consuming exchange nonces", async () => {
    const {
      CREDENTIAL_EXCHANGE_AUTHORIZATION_PROOFS,
      runDisposableCredentialExchangeAuthorizationMatrix,
    } = await import("../test-openclaw-migrations.mjs");

    expect(CREDENTIAL_EXCHANGE_AUTHORIZATION_PROOFS).toEqual(
      REQUIRED_CREDENTIAL_EXCHANGE_PROOFS,
    );
    const result = await runDisposableCredentialExchangeAuthorizationMatrix();
    expect(result.proofs).toEqual(REQUIRED_CREDENTIAL_EXCHANGE_PROOFS);
  }, 30_000);

  it("keeps disconnect fail-closed until revocation acknowledgement and reveals QR material once", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    const actorId = "99999999-9999-4999-8999-999999999999";
    const accountId = "11111111-1111-4111-8111-111111111111";
    const cellId = "22222222-2222-4222-8222-222222222222";
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await database.exec(`
        select set_config('request.jwt.claim.sub','${actorId}',false);
        set session_replication_role='replica';
        update public.openclaw_accounts
        set connection_state='CONNECTED', effective_mode='MANUAL_SEND',
            paused_at=null, session_generation=4, connection_generation=7,
            disclosure_acknowledged_version=disclosure_version,
            disclosure_acknowledged_at=statement_timestamp()
        where organization_id='${DEMO_ORG_ID}' and id='${accountId}';
        set session_replication_role='origin';
      `);

      const disconnect = await database.query(
        `select public.openclaw_disconnect_account_v1($1::jsonb,$2::uuid) result`,
        [
          JSON.stringify({
            version: 1,
            organizationId: DEMO_ORG_ID,
            accountId,
            expectedConnectionGeneration: 7,
            reasonCode: "OPERATOR_REQUESTED",
          }),
          "de000000-0000-4000-8000-000000000001",
        ],
      );
      const revocation = disconnect.rows[0].result;
      expect(revocation).toMatchObject({
        version: 1,
        organizationId: DEMO_ORG_ID,
        accountId,
        cellId,
        revocationKind: "SESSION",
        revokedGeneration: 4,
        minimumValidGeneration: 5,
        connectionState: "DISCONNECTING",
      });

      const durableState = await database.query(`
        select account.connection_state,account.session_generation,
               account.connection_generation,account.effective_mode,
               revocation.acknowledged_at,revocation.minimum_valid_generation
        from public.openclaw_accounts account
        join public.openclaw_generation_revocations revocation
          on revocation.organization_id=account.organization_id
         and revocation.account_id=account.id
         and revocation.id='${revocation.revocationId}'::uuid
        where account.organization_id='${DEMO_ORG_ID}' and account.id='${accountId}'
      `);
      expect(durableState.rows[0]).toMatchObject({
        connection_state: "DISCONNECTING",
        session_generation: 5,
        connection_generation: 8,
        effective_mode: "DRAFT_ONLY",
        acknowledged_at: null,
        minimum_valid_generation: 5,
      });

      const qrRequest = {
        version: 1,
        organizationId: DEMO_ORG_ID,
        accountId,
        cellId,
        browserNonceHash: "a".repeat(64),
        authSessionHash: "b".repeat(64),
        disclosureVersion: 1,
      };
      await expect(database.query(
        `select public.openclaw_begin_qr_login_v1($1::jsonb,$2::uuid) result`,
        [JSON.stringify(qrRequest), "de000000-0000-4000-8000-000000000002"],
      )).rejects.toThrow();

      const acknowledgementHash = "c".repeat(64);
      const acknowledged = await database.query(
        `select public.openclaw_service_ack_disconnect_revocation_v1($1::uuid,$2::jsonb) result`,
        [
          actorId,
          JSON.stringify({
            version: 1,
            organizationId: DEMO_ORG_ID,
            accountId,
            revocationId: revocation.revocationId,
            minimumValidGeneration: 5,
            acknowledgementHash,
          }),
        ],
      );
      expect(acknowledged.rows[0].result).toMatchObject({
        acknowledged: true,
        connectionState: "DISCONNECTING",
        minimumValidGeneration: 5,
      });

      await database.exec(`
        set session_replication_role='replica';
        update public.openclaw_runtime_commands set
          state='ACKNOWLEDGED',started_at=statement_timestamp(),
          effect_deadline_at=statement_timestamp(),effect_disposition='PROVIDER_CONFIRMED',
          result=jsonb_build_object('version',1,'status','PROVIDER_LOGGED_OUT'),
          result_hash=encode(extensions.digest(
            app_private.openclaw_jcs_bytes_v1(
              jsonb_build_object('version',1,'status','PROVIDER_LOGGED_OUT')
            ),'sha256'
          ),'hex'),acknowledged_at=statement_timestamp(),updated_at=statement_timestamp()
        where organization_id='${DEMO_ORG_ID}' and id='${revocation.runtimeCommandId}';
        set session_replication_role='origin';
      `);
      await database.query(
        `select app_private.openclaw_try_finalize_disconnect_v1($1,$2,$3) result`,
        [DEMO_ORG_ID, accountId, revocation.runtimeCommandId],
      );

      const qr = await database.query(
        `select public.openclaw_begin_qr_login_v1($1::jsonb,$2::uuid) result`,
        [JSON.stringify(qrRequest), "de000000-0000-4000-8000-000000000003"],
      );
      expect(qr.rows[0].result).toMatchObject({ status: "PENDING" });
      const challengeId = qr.rows[0].result.challengeId;
      const runtimeCommandId = qr.rows[0].result.runtimeCommandId;
      const qrRuntimePrincipal = {
        version: 1,
        principalKind: "CHANNEL",
        organizationId: DEMO_ORG_ID,
        accountId,
        cellId,
        credentialGeneration: 1,
        leaseGeneration: 1,
        fencingToken: 1,
        sessionGeneration: 5,
        localSessionGeneration: 5,
        authMode: "NORMAL",
      };
      const qrClaimToken = "qr-control-claim-token".padEnd(32, "x");
      const qrClaimHash = createHash("sha256")
        .update("ihome-openclaw-runtime-command-claim-v1\0", "utf8")
        .update(qrClaimToken, "utf8").digest("hex");
      await database.query(`
        update public.openclaw_runtime_commands set
          state='STARTED',claim_token_hash=$3,claim_generation=1,
          lease_expires_at=statement_timestamp()+interval '60 seconds',
          started_at=statement_timestamp(),
          effect_deadline_at=statement_timestamp()+interval '60 seconds'
        where organization_id=$1 and id=$2
      `, [DEMO_ORG_ID, runtimeCommandId, qrClaimHash]);
      const qrPublishRequest = {
        version: 1,
        challengeId,
        runtimeCommandId,
        claimGeneration: 1,
        claimToken: qrClaimToken,
        ciphertextB64: Buffer.alloc(32, 1).toString("base64"),
        cipherIvB64: Buffer.alloc(12, 2).toString("base64"),
        authTagB64: Buffer.alloc(16, 3).toString("base64"),
      };
      const published = await database.query(
        `select app_private.openclaw_submit_qr_result_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(qrRuntimePrincipal), JSON.stringify(qrPublishRequest)],
      );
      const republished = await database.query(
        `select app_private.openclaw_submit_qr_result_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(qrRuntimePrincipal), JSON.stringify(qrPublishRequest)],
      );
      expect(republished.rows[0].result).toEqual(published.rows[0].result);
      const consumeRequest = {
        version: 1,
        organizationId: DEMO_ORG_ID,
        accountId,
        challengeId,
        browserNonceHash: qrRequest.browserNonceHash,
        authSessionHash: qrRequest.authSessionHash,
      };
      await database.exec(`select set_config('request.jwt.claim.sub','',false)`);
      const consumed = await database.query(
        `select public.openclaw_service_consume_qr_challenge_v1(
           $1::uuid,$2::jsonb,$3::uuid
         ) result`,
        [
          actorId,
          JSON.stringify(consumeRequest),
          "de000000-0000-4000-8000-000000000004",
        ],
      );
      expect(consumed.rows[0].result).toMatchObject({
        status: "CONSUMED",
        materialVersion: 1,
        ciphertextB64: Buffer.alloc(32, 1).toString("base64"),
        cipherIvB64: Buffer.alloc(12, 2).toString("base64"),
        authTagB64: Buffer.alloc(16, 3).toString("base64"),
      });
      const cleared = await database.query(
        `select challenge_status,material_version,ciphertext,cipher_iv,auth_tag
         from public.openclaw_qr_challenges
         where organization_id='${DEMO_ORG_ID}' and id=$1::uuid`,
        [challengeId],
      );
      expect(cleared.rows[0]).toMatchObject({
        challenge_status: "CONSUMED",
        material_version: 0,
        ciphertext: null,
        cipher_iv: null,
        auth_tag: null,
      });
      await expect(database.query(
        `select public.openclaw_service_consume_qr_challenge_v1(
           $1::uuid,$2::jsonb,$3::uuid
         ) result`,
        [
          actorId,
          JSON.stringify(consumeRequest),
          "de000000-0000-4000-8000-000000000005",
        ],
      )).rejects.toThrow(/not available/i);

      const finalizeFacade = await database.query(`
        select
          to_regprocedure(
            'public.openclaw_service_finalize_account_connection_v1(jsonb,jsonb,jsonb)'
          )::text signature,
          case when to_regprocedure(
            'public.openclaw_service_finalize_account_connection_v1(jsonb,jsonb,jsonb)'
          ) is null then false else has_function_privilege(
            'service_role',
            to_regprocedure(
              'public.openclaw_service_finalize_account_connection_v1(jsonb,jsonb,jsonb)'
            ),
            'execute'
          ) end service_execute,
          case when to_regprocedure(
            'public.openclaw_service_finalize_account_connection_v1(jsonb,jsonb,jsonb)'
          ) is null then false else has_function_privilege(
            'authenticated',
            to_regprocedure(
              'public.openclaw_service_finalize_account_connection_v1(jsonb,jsonb,jsonb)'
            ),
            'execute'
          ) end browser_execute
      `);
      expect(finalizeFacade.rows[0]).toEqual({
        signature: "openclaw_service_finalize_account_connection_v1(jsonb,jsonb,jsonb)",
        service_execute: true,
        browser_execute: false,
      });

      const finalized = await database.query(
        `select app_private.openclaw_finalize_account_connection_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [
          JSON.stringify(qrRuntimePrincipal),
          JSON.stringify({ version: 1, challengeId }),
        ],
      );
      expect(finalized.rows[0].result).toMatchObject({
        version: 1,
        accountId,
        connectionState: "CONNECTED",
      });
      const refinalized = await database.query(
        `select app_private.openclaw_finalize_account_connection_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(qrRuntimePrincipal), JSON.stringify({ version: 1, challengeId })],
      );
      expect(refinalized.rows[0].result).toEqual(finalized.rows[0].result);
      const finalizationCount = await database.query(
        `select count(*)::integer count
         from public.openclaw_account_connections
         where organization_id=$1 and account_id=$2
           and reason_code='CANONICAL_QR_FINALIZED'`,
        [DEMO_ORG_ID, accountId],
      );
      expect(finalizationCount.rows[0].count).toBe(1);

      const browserGrant = await database.query(`
        select has_function_privilege(
          'authenticated',
          'public.openclaw_consume_qr_challenge_v1(jsonb,uuid)',
          'execute'
        ) allowed
      `);
      expect(browserGrant.rows[0].allowed).toBe(false);
    } finally {
      await database.close();
    }
  }, 30_000);

  it("requires the current disclosure acknowledgement before beginning QR login", async () => {
    const database = await createQrControlDatabase({ disclosureAcknowledged: false });
    try {
      await expect(beginQrLogin(
        database,
        "de100000-0000-4000-8000-000000000001",
      )).rejects.toThrow(/disclosure acknowledgement/i);

      const beforeAcknowledgement = await database.query(`
        select count(*)::integer count
        from public.openclaw_qr_challenges
        where organization_id='${DEMO_ORG_ID}' and account_id='${QR_ACCOUNT_ID}'
      `);
      expect(beforeAcknowledgement.rows[0].count).toBe(0);

      const acknowledgementRequest = {
        version: 1,
        organizationId: DEMO_ORG_ID,
        accountId: QR_ACCOUNT_ID,
        disclosureVersion: 1,
      };
      const operationId = "de100000-0000-4000-8000-000000000010";
      const acknowledged = await database.query(
        `select public.openclaw_acknowledge_disclosure_v1($1::jsonb,$2::uuid) result`,
        [JSON.stringify(acknowledgementRequest), operationId],
      );
      expect(acknowledged.rows[0].result).toMatchObject({
        version: 1,
        organizationId: DEMO_ORG_ID,
        accountId: QR_ACCOUNT_ID,
        disclosureAcknowledgedVersion: 1,
        idempotentReplay: false,
      });
      expect(Date.parse(acknowledged.rows[0].result.disclosureAcknowledgedAt)).not.toBeNaN();

      const replay = await database.query(
        `select public.openclaw_acknowledge_disclosure_v1($1::jsonb,$2::uuid) result`,
        [JSON.stringify(acknowledgementRequest), operationId],
      );
      expect(replay.rows[0].result).toEqual({
        ...acknowledged.rows[0].result,
        idempotentReplay: true,
      });
      await expect(database.query(
        `select public.openclaw_acknowledge_disclosure_v1($1::jsonb,$2::uuid) result`,
        [JSON.stringify({ ...acknowledgementRequest, extra: true }), operationId],
      )).rejects.toThrow();

      const audit = await database.query(`
        select count(*)::integer count
        from public.openclaw_audit_events
        where organization_id=$1 and event_type='OPENCLAW_DISCLOSURE_ACKNOWLEDGED'
          and actor_id=$2::uuid and correlation_id=$3::uuid
      `, [DEMO_ORG_ID, QR_ACTOR_ID, operationId]);
      expect(audit.rows[0].count).toBe(1);

      const begun = await beginQrLogin(
        database,
        "de100000-0000-4000-8000-000000000002",
      );
      expect(begun).toMatchObject({ status: "PENDING" });
      expect(Date.parse(begun.expiresAt) - Date.parse(begun.issuedAt)).toBe(120_000);
    } finally {
      await database.close();
    }
  }, 30_000);

  it("denies disclosure acknowledgement without current manage-connections permission", async () => {
    const database = await createQrControlDatabase({ disclosureAcknowledged: false });
    try {
      await database.exec(`
        set session_replication_role='replica';
        update public.organization_memberships
        set status='INACTIVE'
        where organization_id='${DEMO_ORG_ID}' and user_id='${QR_ACTOR_ID}';
        set session_replication_role='origin';
      `);
      await expect(database.query(
        `select public.openclaw_acknowledge_disclosure_v1($1::jsonb,$2::uuid) result`,
        [JSON.stringify({
          version: 1,
          organizationId: DEMO_ORG_ID,
          accountId: QR_ACCOUNT_ID,
          disclosureVersion: 1,
        }), "de150000-0000-4000-8000-000000000001"],
      )).rejects.toThrow(/permission/i);
      const account = await database.query(`
        select disclosure_acknowledged_version,disclosure_acknowledged_at
        from public.openclaw_accounts
        where organization_id='${DEMO_ORG_ID}' and id='${QR_ACCOUNT_ID}'
      `);
      expect(account.rows[0]).toEqual({
        disclosure_acknowledged_version: null,
        disclosure_acknowledged_at: null,
      });
    } finally {
      await database.close();
    }
  }, 30_000);

  it("resumes a pending disconnect under service role after the initiating actor loses permission", async () => {
    const database = await createQrControlDatabase({
      connectionState: "CONNECTED",
      sessionGeneration: 4,
      connectionGeneration: 7,
    });
    const operationId = "de180000-0000-4000-8000-000000000001";
    try {
      const disconnect = await database.query(
        `select public.openclaw_disconnect_account_v1($1::jsonb,$2::uuid) result`,
        [JSON.stringify({
          version: 1,
          organizationId: DEMO_ORG_ID,
          accountId: QR_ACCOUNT_ID,
          expectedConnectionGeneration: 7,
          reasonCode: "OPERATOR_REQUESTED",
        }), operationId],
      );
      const revocation = disconnect.rows[0].result;

      await database.exec(`
        set session_replication_role='replica';
        update public.organization_memberships
        set status='INACTIVE'
        where organization_id='${DEMO_ORG_ID}' and user_id='${QR_ACTOR_ID}';
        set session_replication_role='origin';
        select set_config('request.jwt.claim.sub','',false);
      `);
      const resumed = await database.query(
        `select public.openclaw_service_resume_disconnect_revocation_v1(
           $1::uuid,$2::uuid,$3::uuid
         ) result`,
        [QR_ACTOR_ID, DEMO_ORG_ID, operationId],
      );
      expect(resumed.rows[0].result).toEqual(revocation);
      await expect(database.query(
        `select public.openclaw_service_resume_disconnect_revocation_v1(
           $1::uuid,$2::uuid,$3::uuid
         ) result`,
        ["99999999-9999-4999-8999-999999999998", DEMO_ORG_ID, operationId],
      )).rejects.toThrow(/not found/i);

      const acknowledged = await database.query(
        `select public.openclaw_service_ack_disconnect_revocation_v1($1::uuid,$2::jsonb) result`,
        [QR_ACTOR_ID, JSON.stringify({
          version: 1,
          organizationId: DEMO_ORG_ID,
          accountId: QR_ACCOUNT_ID,
          revocationId: revocation.revocationId,
          minimumValidGeneration: revocation.minimumValidGeneration,
          acknowledgementHash: "e".repeat(64),
        })],
      );
      expect(acknowledged.rows[0].result).toMatchObject({
        acknowledged: true,
        connectionState: "DISCONNECTING",
      });

      const grants = await database.query(`
        select
          has_function_privilege(
            'service_role',
            'public.openclaw_service_resume_disconnect_revocation_v1(uuid,uuid,uuid)',
            'execute'
          ) service_execute,
          has_function_privilege(
            'authenticated',
            'public.openclaw_service_resume_disconnect_revocation_v1(uuid,uuid,uuid)',
            'execute'
          ) browser_execute
      `);
      expect(grants.rows[0]).toEqual({ service_execute: true, browser_execute: false });
    } finally {
      await database.close();
    }
  }, 30_000);

  it("binds every QR poll to the exact browser nonce and auth session hashes", async () => {
    const database = await createQrControlDatabase();
    try {
      const request = qrBeginRequest();
      const qr = await beginQrLogin(
        database,
        "de200000-0000-4000-8000-000000000001",
        request,
      );
      const poll = (overrides = {}) => database.query(
        `select public.openclaw_poll_qr_login_v1($1::jsonb) result`,
        [JSON.stringify({
          version: 1,
          organizationId: DEMO_ORG_ID,
          challengeId: qr.challengeId,
          browserNonceHash: request.browserNonceHash,
          authSessionHash: request.authSessionHash,
          ...overrides,
        })],
      );

      const accepted = await poll();
      expect(accepted.rows[0].result.challenge).toMatchObject({
        challengeId: qr.challengeId,
        challengeStatus: "PENDING",
      });
      const wrongNonce = await poll({ browserNonceHash: "c".repeat(64) });
      expect(wrongNonce.rows[0].result.challenge).toBeNull();
      const wrongSession = await poll({ authSessionHash: "d".repeat(64) });
      expect(wrongSession.rows[0].result.challenge).toBeNull();
    } finally {
      await database.close();
    }
  }, 30_000);

  it("rate-limits only exact QR poll bindings", async () => {
    const database = await createQrControlDatabase();
    try {
      const request = qrBeginRequest();
      const qr = await beginQrLogin(
        database,
        "de200000-0000-4000-8000-000000000011",
        request,
      );
      const poll = (overrides = {}) => database.query(
        `select public.openclaw_poll_qr_login_v1($1::jsonb) result`,
        [JSON.stringify({
          version: 1,
          organizationId: DEMO_ORG_ID,
          challengeId: qr.challengeId,
          browserNonceHash: request.browserNonceHash,
          authSessionHash: request.authSessionHash,
          ...overrides,
        })],
      );

      for (let index = 0; index < 11; index += 1) {
        expect((await poll({ browserNonceHash: "c".repeat(64) })).rows[0].result.challenge)
          .toBeNull();
        expect((await poll({ authSessionHash: "d".repeat(64) })).rows[0].result.challenge)
          .toBeNull();
      }
      for (let index = 0; index < 10; index += 1) {
        expect((await poll()).rows[0].result.challenge).toMatchObject({
          challengeId: qr.challengeId,
          challengeStatus: "PENDING",
        });
      }
      await expect(poll()).rejects.toMatchObject({ code: "P0003" });
      const durable = await database.query(`
        select poll_count,poll_window_started_at,challenge_status,material_version
        from public.openclaw_qr_challenges
        where organization_id=$1 and id=$2
      `, [DEMO_ORG_ID, qr.challengeId]);
      expect(durable.rows[0]).toMatchObject({
        poll_count: 10,
        challenge_status: "PENDING",
        material_version: 0,
      });
      expect(durable.rows[0].poll_window_started_at).not.toBeNull();
    } finally {
      await database.close();
    }
  }, 30_000);

  it("clears replaced QR material and revokes its runtime command during refresh", async () => {
    const database = await createQrControlDatabase();
    try {
      const first = await beginQrLogin(
        database,
        "de250000-0000-4000-8000-000000000001",
      );
      await publishQrMaterial(database, first);
      const refreshed = await beginQrLogin(
        database,
        "de250000-0000-4000-8000-000000000002",
        qrBeginRequest({
          browserNonceHash: "c".repeat(64),
          authSessionHash: "d".repeat(64),
        }),
      );
      expect(refreshed.challengeId).not.toBe(first.challengeId);

      const replaced = await database.query(
        `select challenge.challenge_status,challenge.active_slot,
                challenge.material_version,challenge.ciphertext,
                challenge.cipher_iv,challenge.auth_tag,command.state command_state
         from public.openclaw_qr_challenges challenge
         join public.openclaw_runtime_commands command
           on command.organization_id=challenge.organization_id
          and command.id=challenge.runtime_command_id
         where challenge.organization_id=$1 and challenge.id=$2::uuid`,
        [DEMO_ORG_ID, first.challengeId],
      );
      expect(replaced.rows[0]).toMatchObject({
        challenge_status: "REVOKED",
        active_slot: false,
        material_version: 0,
        ciphertext: null,
        cipher_iv: null,
        auth_tag: null,
        command_state: "REVOKED",
      });
    } finally {
      await database.close();
    }
  }, 30_000);

  it("revokes and clears an active QR when disconnect advances the session generation", async () => {
    const database = await createQrControlDatabase();
    try {
      const request = qrBeginRequest();
      const qr = await beginQrLogin(
        database,
        "de300000-0000-4000-8000-000000000001",
        request,
      );
      await publishQrMaterial(database, qr);
      const disconnect = await database.query(
        `select public.openclaw_disconnect_account_v1($1::jsonb,$2::uuid) result`,
        [
          JSON.stringify({
            version: 1,
            organizationId: DEMO_ORG_ID,
            accountId: QR_ACCOUNT_ID,
            expectedConnectionGeneration: 1,
            reasonCode: "OPERATOR_REQUESTED",
          }),
          "de300000-0000-4000-8000-000000000002",
        ],
      );
      expect(disconnect.rows[0].result).toMatchObject({
        minimumValidGeneration: 2,
        connectionState: "DISCONNECTING",
      });

      const invalidated = await database.query(
        `select challenge.challenge_status,challenge.active_slot,
                challenge.material_version,challenge.ciphertext,
                challenge.cipher_iv,challenge.auth_tag,command.state command_state
         from public.openclaw_qr_challenges challenge
         join public.openclaw_runtime_commands command
           on command.organization_id=challenge.organization_id
          and command.id=challenge.runtime_command_id
         where challenge.organization_id=$1 and challenge.id=$2::uuid`,
        [DEMO_ORG_ID, qr.challengeId],
      );
      expect(invalidated.rows[0]).toMatchObject({
        challenge_status: "REVOKED",
        active_slot: false,
        material_version: 0,
        ciphertext: null,
        cipher_iv: null,
        auth_tag: null,
        command_state: "REVOKED",
      });
      await expect(publishQrMaterial(database, qr)).rejects.toThrow(/not available/i);
      await expect(consumeQrMaterial(
        database,
        qr,
        "de300000-0000-4000-8000-000000000003",
        request,
      )).rejects.toThrow(/not available/i);

      const polled = await database.query(
        `select public.openclaw_poll_qr_login_v1($1::jsonb) result`,
        [JSON.stringify({
          version: 1,
          organizationId: DEMO_ORG_ID,
          challengeId: qr.challengeId,
          browserNonceHash: request.browserNonceHash,
          authSessionHash: request.authSessionHash,
        })],
      );
      expect(polled.rows[0].result.challenge).toBeNull();
    } finally {
      await database.close();
    }
  }, 30_000);

  it("rejects finalization from a consumed QR after a newer refresh generation exists", async () => {
    const database = await createQrControlDatabase();
    try {
      const firstRequest = qrBeginRequest();
      const first = await beginQrLogin(
        database,
        "de400000-0000-4000-8000-000000000001",
        firstRequest,
      );
      await publishQrMaterial(database, first);
      await consumeQrMaterial(
        database,
        first,
        "de400000-0000-4000-8000-000000000002",
        firstRequest,
      );
      const second = await beginQrLogin(
        database,
        "de400000-0000-4000-8000-000000000003",
        qrBeginRequest({
          browserNonceHash: "c".repeat(64),
          authSessionHash: "d".repeat(64),
        }),
      );
      expect(second.challengeId).not.toBe(first.challengeId);

      await expect(database.query(
        `select app_private.openclaw_finalize_account_connection_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [
          JSON.stringify(qrRuntimePrincipal()),
          JSON.stringify({ version: 1, challengeId: first.challengeId }),
        ],
      )).rejects.toThrow(/challenge generation is stale/i);

      const account = await database.query(`
        select connection_state,connection_generation
        from public.openclaw_accounts
        where organization_id='${DEMO_ORG_ID}' and id='${QR_ACCOUNT_ID}'
      `);
      expect(account.rows[0]).toEqual({
        connection_state: "QR_PENDING",
        connection_generation: 2,
      });
      const finalized = await database.query(`
        select count(*)::integer count
        from public.openclaw_account_connections
        where organization_id='${DEMO_ORG_ID}' and account_id='${QR_ACCOUNT_ID}'
          and reason_code='CANONICAL_QR_FINALIZED'
      `);
      expect(finalized.rows[0].count).toBe(0);
    } finally {
      await database.close();
    }
  }, 30_000);

  it("serializes competing disconnects and keeps a stale acknowledgement fail-closed", async () => {
    const database = await createQrControlDatabase({
      connectionState: "CONNECTED",
      sessionGeneration: 4,
      connectionGeneration: 7,
    });
    try {
      const disconnectRequest = {
        version: 1,
        organizationId: DEMO_ORG_ID,
        accountId: QR_ACCOUNT_ID,
        expectedConnectionGeneration: 7,
        reasonCode: "OPERATOR_REQUESTED",
      };
      const outcomes = await Promise.allSettled([
        database.query(
          `select public.openclaw_disconnect_account_v1($1::jsonb,$2::uuid) result`,
          [JSON.stringify(disconnectRequest), "de500000-0000-4000-8000-000000000001"],
        ),
        database.query(
          `select public.openclaw_disconnect_account_v1($1::jsonb,$2::uuid) result`,
          [JSON.stringify(disconnectRequest), "de500000-0000-4000-8000-000000000002"],
        ),
      ]);
      const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const losers = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(String(losers[0].reason)).toMatch(/connection generation mismatch/i);
      const first = winners[0].value.rows[0].result;

      const secondResult = await database.query(
        `select public.openclaw_disconnect_account_v1($1::jsonb,$2::uuid) result`,
        [
          JSON.stringify({ ...disconnectRequest, expectedConnectionGeneration: 8 }),
          "de500000-0000-4000-8000-000000000003",
        ],
      );
      const second = secondResult.rows[0].result;
      expect(second).toMatchObject({
        revokedGeneration: 5,
        minimumValidGeneration: 6,
        connectionState: "DISCONNECTING",
      });
      const superseded = await database.query(
        `select id,state from public.openclaw_runtime_commands
         where organization_id=$1 and id in ($2,$3) order by id`,
        [DEMO_ORG_ID, first.runtimeCommandId, second.runtimeCommandId],
      );
      expect(Object.fromEntries(superseded.rows.map((row) => [row.id, row.state]))).toEqual({
        [first.runtimeCommandId]: "REVOKED",
        [second.runtimeCommandId]: "PENDING",
      });

      await database.query(
        `update public.openclaw_runtime_commands set
           state='STARTED',claim_token_hash=repeat('e',64),claim_generation=1,
           lease_expires_at=statement_timestamp()+interval '60 seconds',
           started_at=statement_timestamp(),
           effect_deadline_at=statement_timestamp()+interval '60 seconds'
         where organization_id=$1 and id=$2`,
        [DEMO_ORG_ID, second.runtimeCommandId],
      );
      await expect(database.query(
        `select public.openclaw_disconnect_account_v1($1::jsonb,$2::uuid) result`,
        [
          JSON.stringify({ ...disconnectRequest, expectedConnectionGeneration: 9 }),
          "de500000-0000-4000-8000-000000000004",
        ],
      )).rejects.toThrow(/started disconnect/i);

      const acknowledge = (revocation, acknowledgementHash) => database.query(
        `select public.openclaw_service_ack_disconnect_revocation_v1(
           $1::uuid,$2::jsonb
         ) result`,
        [
          QR_ACTOR_ID,
          JSON.stringify({
            version: 1,
            organizationId: DEMO_ORG_ID,
            accountId: QR_ACCOUNT_ID,
            revocationId: revocation.revocationId,
            minimumValidGeneration: revocation.minimumValidGeneration,
            acknowledgementHash,
          }),
        ],
      );
      const staleAcknowledgement = await acknowledge(first, "c".repeat(64));
      expect(staleAcknowledgement.rows[0].result).toMatchObject({
        acknowledged: true,
        connectionState: "DISCONNECTING",
      });
      const pending = await database.query(`
        select connection_state,session_generation,connection_generation
        from public.openclaw_accounts
        where organization_id='${DEMO_ORG_ID}' and id='${QR_ACCOUNT_ID}'
      `);
      expect(pending.rows[0]).toEqual({
        connection_state: "DISCONNECTING",
        session_generation: 6,
        connection_generation: 9,
      });

      const currentAcknowledgement = await acknowledge(second, "d".repeat(64));
      expect(currentAcknowledgement.rows[0].result).toMatchObject({
        acknowledged: true,
        connectionState: "DISCONNECTING",
      });
    } finally {
      await database.close();
    }
  }, 30_000);

  it("cuts CELL rebind over atomically only on generation acknowledgement", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      withSqlHarnessSavepoint,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    const accountId = "11111111-1111-4111-8111-111111111111";
    const oldCellId = "22222222-2222-4222-8222-222222222222";
    const newCellId = "22222222-2222-4222-8222-222222222223";
    const commandId = "ce110000-0000-4000-8000-000000000001";
    const rebindId = "ce110000-0000-4000-8000-000000000002";
    const acknowledgementHash = "d".repeat(64);
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await database.exec(`
        set session_replication_role='replica';
        update public.openclaw_runtime_leases set
          status='REVOKED',released_at=statement_timestamp()
        where organization_id='${DEMO_ORG_ID}' and account_id='${accountId}'
          and cell_id='${oldCellId}' and status='ACTIVE';
        insert into public.openclaw_runtime_cells(
          id,organization_id,account_id,cell_generation,state,is_current,
          reviewed_commit_sha,image_digest,config_digest
        ) values (
          '${newCellId}','${DEMO_ORG_ID}','${accountId}',2,'PROVISIONING',false,
          repeat('a',40),'sha256:'||repeat('b',64),repeat('c',64)
        );
        with payload as (
          select jsonb_build_object(
            'version',1,'oldCellId','${oldCellId}','newCellId','${newCellId}',
            'rebindGeneration',1
          ) value
        )
        insert into public.openclaw_runtime_commands(
          id,organization_id,account_id,cell_id,command_key,command_kind,
          source_session_generation,target_session_generation,
          source_connection_generation,target_connection_generation,
          expected_session_generation,expected_connection_generation,
          expected_fencing_token,payload,payload_bytes,payload_hash
        )
        select '${commandId}','${DEMO_ORG_ID}','${accountId}','${newCellId}',
          'rebind:1','CELL_REBIND',1,1,0,0,1,0,12,value,
          app_private.openclaw_jcs_bytes_v1(value),
          encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(value),'sha256'),'hex')
        from payload;
        insert into public.openclaw_cell_rebinds(
          id,organization_id,account_id,old_cell_id,new_cell_id,runtime_command_id,
          rebind_generation,expected_session_generation,old_lease_generation,
          old_fencing_token,new_lease_generation,new_fencing_token,status
        ) values (
          '${rebindId}','${DEMO_ORG_ID}','${accountId}','${oldCellId}','${newCellId}',
          '${commandId}',1,1,1,11,2,12,'PREPARED'
        );
        insert into public.openclaw_runtime_credentials(
          organization_id,account_id,cell_id,credential_generation,
          credential_hash,allowed_scopes
        ) values (
          '${DEMO_ORG_ID}','${accountId}','${newCellId}',2,repeat('e',64),
          array['generation.ack']
        );
        insert into public.openclaw_runtime_leases(
          id,organization_id,account_id,cell_id,lease_generation,fencing_token,
          status,acquired_at,expires_at
        ) values (
          'ce110000-0000-4000-8000-000000000003','${DEMO_ORG_ID}','${accountId}',
          '${newCellId}',2,12,'ACTIVE',statement_timestamp(),
          statement_timestamp()+interval '10 minutes'
        );
        set session_replication_role='origin';
      `);
      await database.exec("begin");

      const oldPrincipal = {
        version: 1,
        principalKind: "CHANNEL",
        organizationId: DEMO_ORG_ID,
        accountId,
        cellId: oldCellId,
        credentialGeneration: 1,
        leaseGeneration: 1,
        fencingToken: 11,
        sessionGeneration: 1,
      };
      const completedQuery = await database.query(
        `select app_private.openclaw_complete_cell_rebind_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(oldPrincipal), JSON.stringify({ version: 1, rebindId })],
      );
      const completed = completedQuery.rows[0].result;
      expect(completed).toMatchObject({
        version: 1,
        rebindId,
        status: "AWAITING_ACK",
        newCellId,
        revocationBody: {
          version: 1,
          organizationId: DEMO_ORG_ID,
          principalKind: "CHANNEL",
          accountId,
          cellId: oldCellId,
          maintenancePrincipalId: null,
          revocationKind: "CELL",
          revokedGeneration: 11,
          minimumValidGeneration: 12,
        },
      });
      const revocationId = completed.revocationId;
      expect(completed.revocationBody.revocationId).toBe(revocationId);

      const loadCutoverState = () => database.query(`
        select revocation.principal_kind,revocation.account_id,revocation.cell_id,
          revocation.revocation_kind,revocation.revoked_generation,
          revocation.minimum_valid_generation,revocation.acknowledgement_hash,
          revocation.acknowledged_at,rebind.status,rebind.acknowledgement_hash rebind_ack_hash,
          rebind.completed_at,
          old_cell.state old_state,old_cell.is_current old_current,
          new_cell.state new_state,new_cell.is_current new_current,
          old_credential.revoked_at old_credential_revoked_at,
          old_credential.revoked_reason old_credential_revoked_reason,
          command.state command_state,
          (select count(*)::integer from public.openclaw_runtime_cells current_cell
           where current_cell.organization_id=rebind.organization_id
             and current_cell.account_id=rebind.account_id and current_cell.is_current) current_count
        from public.openclaw_generation_revocations revocation
        join public.openclaw_cell_rebinds rebind
          on rebind.organization_id=revocation.organization_id
         and rebind.revocation_id=revocation.id
        join public.openclaw_runtime_cells old_cell
          on old_cell.organization_id=rebind.organization_id and old_cell.id=rebind.old_cell_id
        join public.openclaw_runtime_cells new_cell
          on new_cell.organization_id=rebind.organization_id and new_cell.id=rebind.new_cell_id
        join public.openclaw_runtime_commands command
          on command.organization_id=rebind.organization_id and command.id=rebind.runtime_command_id
        join public.openclaw_runtime_credentials old_credential
          on old_credential.organization_id=rebind.organization_id
         and old_credential.account_id=rebind.account_id
         and old_credential.cell_id=rebind.old_cell_id
         and old_credential.credential_generation=1
        where revocation.organization_id='${DEMO_ORG_ID}'
          and revocation.id='${revocationId}'::uuid
      `);
      const beforeAck = await loadCutoverState();
      expect(beforeAck.rows[0]).toMatchObject({
        principal_kind: "CHANNEL",
        account_id: accountId,
        cell_id: oldCellId,
        revocation_kind: "CELL",
        revoked_generation: 11,
        minimum_valid_generation: 12,
        acknowledgement_hash: null,
        acknowledged_at: null,
        status: "AWAITING_ACK",
        rebind_ack_hash: null,
        completed_at: null,
        old_state: "READY",
        old_current: true,
        new_state: "PROVISIONING",
        new_current: false,
        old_credential_revoked_at: null,
        old_credential_revoked_reason: null,
        command_state: "ACKNOWLEDGED",
        current_count: 1,
      });

      const ackRequest = {
        version: 1,
        revocationId,
        minimumValidGeneration: 12,
        acknowledgementHash,
      };
      const acknowledge = async (request = ackRequest) => {
        const result = await database.query(
          `select app_private.openclaw_ack_generation_revocation_v1(
             $1::jsonb,'{}'::jsonb,$2::jsonb
           ) result`,
          [JSON.stringify({
            version: 1,
            principalKind: "CHANNEL",
            organizationId: DEMO_ORG_ID,
            accountId,
            cellId: newCellId,
            credentialGeneration: 2,
            leaseGeneration: 2,
            fencingToken: 12,
            sessionGeneration: 1,
          }), JSON.stringify(request)],
        );
        return result.rows[0].result;
      };
      await expect(withSqlHarnessSavepoint(database, () => database.query(
        `select app_private.openclaw_ack_generation_revocation_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [
          JSON.stringify({
            version: 1,
            principalKind: "CHANNEL",
            organizationId: DEMO_ORG_ID,
            accountId: "11111111-1111-4111-8111-111111111199",
            cellId: newCellId,
            credentialGeneration: 2,
            leaseGeneration: 2,
            fencingToken: 12,
            sessionGeneration: 1,
          }),
          JSON.stringify(ackRequest),
        ],
      ))).rejects.toThrow(/revocation|rebind|not found|binding/i);
      expect((await loadCutoverState()).rows[0]).toEqual(beforeAck.rows[0]);

      const firstAck = await acknowledge();
      const afterAck = await loadCutoverState();
      expect(afterAck.rows[0]).toMatchObject({
        acknowledgement_hash: acknowledgementHash,
        status: "COMPLETED",
        rebind_ack_hash: acknowledgementHash,
        old_state: "FENCED",
        old_current: false,
        new_state: "READY",
        new_current: true,
        old_credential_revoked_reason: "CELL_REBIND",
        command_state: "ACKNOWLEDGED",
        current_count: 1,
      });
      expect(afterAck.rows[0].acknowledged_at).not.toBeNull();
      expect(afterAck.rows[0].completed_at).not.toBeNull();
      expect(afterAck.rows[0].old_credential_revoked_at).not.toBeNull();
      const lostResponseRetry = await acknowledge();
      expect(lostResponseRetry).toEqual(firstAck);
      expect((await loadCutoverState()).rows[0]).toEqual(afterAck.rows[0]);
      await expect(withSqlHarnessSavepoint(database, () => acknowledge({
        ...ackRequest,
        acknowledgementHash: "e".repeat(64),
      }))).rejects.toMatchObject({ code: "40001" });

      const grants = await database.query(`
        select
          has_function_privilege('service_role',
            'public.openclaw_service_complete_cell_rebind_v1(jsonb,jsonb,jsonb)','execute')
            complete_service,
          has_function_privilege('authenticated',
            'public.openclaw_service_complete_cell_rebind_v1(jsonb,jsonb,jsonb)','execute')
            complete_browser,
          has_function_privilege('service_role',
            'public.openclaw_service_ack_generation_revocation_v1(jsonb,jsonb,jsonb)','execute')
            ack_service,
          has_function_privilege('authenticated',
            'public.openclaw_service_ack_generation_revocation_v1(jsonb,jsonb,jsonb)','execute')
            ack_browser,
          has_function_privilege('service_role',
            'app_private.openclaw_ack_generation_revocation_v1(jsonb,jsonb,jsonb)','execute')
            private_service
      `);
      expect(grants.rows[0]).toEqual({
        complete_service: true,
        complete_browser: false,
        ack_service: true,
        ack_browser: false,
        private_service: false,
      });
    } finally {
      await database.exec("rollback").catch(() => {});
      await database.close();
    }
  }, 30_000);

  it("ingests only the canonical inbound tenant envelope and returns the canonical acknowledgement", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    const accountId = "11111111-1111-4111-8111-111111111111";
    const cellId = "22222222-2222-4222-8222-222222222222";
    const rawEnvelope = { callback: "canonical" };
    const normalized = {
      text: "hello",
      replyToProviderMessageId: null,
      mediaManifest: [],
    };
    const event = {
      version: 1,
      eventKind: "MESSAGE",
      providerEventId: "canonical-event-1",
      providerMessageId: "canonical-message-1",
      providerConversationId: "canonical-conversation-1",
      providerSenderId: "canonical-sender-1",
      providerTarget: { kind: "PEER", providerId: "canonical-peer-1" },
      providerEventType: "MESSAGE",
      sourceTimestamp: "2026-08-01T00:00:00.000Z",
      callbackReceivedAt: "2026-08-01T00:00:01.000Z",
      rawEnvelope,
      rawEnvelopeSha256: canonicalSha256(rawEnvelope),
      normalized,
      normalizedSha256: canonicalSha256(normalized),
    };
    const principal = {
      version: 1,
      principalKind: "CHANNEL",
      organizationId: DEMO_ORG_ID,
      accountId,
      cellId,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      sessionGeneration: 1,
      maintenancePrincipalId: null,
      allowedOperations: ["openclaw_ingest_inbound_batch_v1"],
    };
    const request = {
      version: 1,
      organizationId: DEMO_ORG_ID,
      accountId,
      cellId,
      sessionGeneration: 1,
      events: [event],
    };
    try {
      await prepareDisposableConcurrencyFixtures(database);
      const ingested = await database.query(
        `select app_private.openclaw_ingest_inbound_batch_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify(request)],
      );
      expect(ingested.rows[0].result).toMatchObject({
        version: 1,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        accepted: 1,
        deduplicated: 0,
        quarantined: 0,
        results: [{
          index: 0,
          status: "ACCEPTED",
          inboundEventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          decisionKind: "NO_SEND",
          workItemId: null,
        }],
      });
      const stored = await database.query(`
        select raw_envelope_sha256,normalized_sha256
        from public.openclaw_inbound_events
        where organization_id='${DEMO_ORG_ID}' and provider_event_id='canonical-event-1'
      `);
      expect(stored.rows[0]).toEqual({
        raw_envelope_sha256: event.rawEnvelopeSha256,
        normalized_sha256: event.normalizedSha256,
      });
      const spoolResetReplay = await database.query(
        `select app_private.openclaw_ingest_inbound_batch_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [
          JSON.stringify(principal),
          JSON.stringify({
            ...request,
            events: [{ ...event, callbackReceivedAt: "2026-08-01T00:05:01.000Z" }],
          }),
        ],
      );
      expect(spoolResetReplay.rows[0].result).toMatchObject({
        accepted: 0,
        deduplicated: 1,
        quarantined: 0,
        results: [{ index: 0, status: "DUPLICATE" }],
      });

      await expect(database.query(
        `select app_private.openclaw_ingest_inbound_batch_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         )`,
        [
          JSON.stringify(principal),
          JSON.stringify({
            ...request,
            organizationId: "aaaa0000-0000-4000-8000-000000000001",
            events: [{ ...event, providerEventId: "foreign-event-1" }],
          }),
        ],
      )).rejects.toThrow(/binding|tenant|principal/i);

      await expect(database.query(
        `select app_private.openclaw_ingest_inbound_batch_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         )`,
        [
          JSON.stringify(principal),
          JSON.stringify({
            ...request,
            events: [{
              ...event,
              providerEventId: "forged-hash-event-1",
              providerMessageId: "forged-hash-message-1",
              rawEnvelopeSha256: "f".repeat(64),
            }],
          }),
        ],
      )).rejects.toThrow(/hash/i);
    } finally {
      await database.close();
    }
  }, 30_000);

  it("isolates media resolution by quarantine, tenant, and view permission", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    const ownerId = "99999999-9999-4999-8999-999999999999";
    const noViewId = "dddd7200-0000-4000-8000-000000000003";
    const otherOrgId = "dddd0000-0000-4000-8000-000000000002";
    const messageId = "dddd7200-0000-4000-8000-000000000001";
    const mediaId = "dddd7200-0000-4000-8000-000000000002";
    const accountId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "55555555-5555-4555-8555-555555555556";
    const objectKey = `v1/org/${DEMO_ORG_ID}/account/${accountId}/conversation/${conversationId}/message/${messageId}/media/${mediaId}/original`;
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await database.exec(`
        set session_replication_role='replica';
        insert into public.organizations(id,name) values ('${otherOrgId}','Other fixture org');
        insert into auth.users(id) values ('${noViewId}');
        insert into public.organization_memberships(
          id,organization_id,user_id,member_type,status
        ) values
          ('dddd7200-0000-4000-8000-000000000010','${otherOrgId}','${ownerId}','USER','ACTIVE'),
          ('dddd7200-0000-4000-8000-000000000011','${DEMO_ORG_ID}','${noViewId}','USER','ACTIVE');
        insert into public.organization_roles(id,organization_id,is_system,status,name)
        values ('dddd7200-0000-4000-8000-000000000012','${otherOrgId}',false,'ACTIVE','View only');
        insert into public.role_permissions(organization_id,role_id,permission_key,effect)
        values ('${otherOrgId}','dddd7200-0000-4000-8000-000000000012','openclaw_zalo.view','ALLOW');
        insert into public.authorization_scopes(id,organization_id,scope_type)
        values ('dddd7200-0000-4000-8000-000000000013','${otherOrgId}','ORGANIZATION');
        insert into public.role_bindings(id,organization_id,membership_id,role_id)
        values (
          'dddd7200-0000-4000-8000-000000000014','${otherOrgId}',
          'dddd7200-0000-4000-8000-000000000010','dddd7200-0000-4000-8000-000000000012'
        );
        insert into public.role_binding_scopes(organization_id,role_binding_id,scope_id)
        values (
          '${otherOrgId}','dddd7200-0000-4000-8000-000000000014',
          'dddd7200-0000-4000-8000-000000000013'
        );
        insert into public.openclaw_messages(
          id,organization_id,account_id,conversation_id,direction,text_content,payload_hash
        ) values (
          '${messageId}','${DEMO_ORG_ID}','${accountId}','${conversationId}',
          'INBOUND','media resolver fixture',repeat('8',64)
        );
        insert into public.openclaw_message_media(
          id,organization_id,account_id,conversation_id,message_id,media_index,
          media_kind,mime,byte_length,sha256,object_key,byte_state
        ) values (
          '${mediaId}','${DEMO_ORG_ID}','${accountId}','${conversationId}','${messageId}',0,
          'IMAGE','image/png',128,repeat('a',64),'${objectKey}','AVAILABLE'
        );
        set session_replication_role='origin';
      `);
      const resolve = (actorId, organizationId = DEMO_ORG_ID) => database.exec(`
        select set_config('request.jwt.claim.sub','${actorId}',false);
        select public.openclaw_resolve_media_object_v1(
          jsonb_build_object('version',1,'organizationId','${organizationId}','mediaId','${mediaId}')
        ) result;
      `);
      const owner = await resolve(ownerId);
      expect(owner.at(-1).rows[0].result).toMatchObject({
        mediaId,
        organizationId: DEMO_ORG_ID,
        objectKey,
        sha256: "a".repeat(64),
        byteState: "AVAILABLE",
      });
      await expect(resolve(ownerId, otherOrgId)).rejects.toMatchObject({ code: "P0002" });
      await expect(resolve(noViewId)).rejects.toMatchObject({ code: "42501" });
      await database.query(
        `update public.openclaw_message_media set byte_state='QUARANTINED'
         where organization_id=$1 and id=$2`,
        [DEMO_ORG_ID, mediaId],
      );
      await expect(resolve(ownerId)).rejects.toMatchObject({ code: "P0002" });
      const unchanged = await database.query(`
        select object_key,sha256,byte_state from public.openclaw_message_media
        where organization_id=$1 and id=$2
      `, [DEMO_ORG_ID, mediaId]);
      expect(unchanged.rows[0]).toEqual({
        object_key: objectKey,
        sha256: "a".repeat(64),
        byte_state: "QUARANTINED",
      });
    } finally {
      await database.close();
    }
  }, 30_000);

  it("finalizes one signed channel media upload receipt with a ticket-bound AVAILABLE CAS and exact replay", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    const accountId = "11111111-1111-4111-8111-111111111111";
    const cellId = "22222222-2222-4222-8222-222222222222";
    const principal = {
      version: 1, principalKind: "CHANNEL", organizationId: DEMO_ORG_ID,
      accountId, cellId, credentialGeneration: 1, leaseGeneration: 1,
      fencingToken: 1, sessionGeneration: 1,
    };
    const checksum = "c".repeat(64);
    const normalized = {
      text: "media", replyToProviderMessageId: null,
      mediaManifest: [{
        version: 1, index: 0, providerMediaId: "media-finalize-1", kind: "IMAGE",
        mime: "image/png", byteLength: 64, providerChecksum: null,
        fetchRef: "gateway://media-finalize-1", byteState: "PENDING",
      }],
    };
    const event = {
      version: 1, eventKind: "MESSAGE", providerEventId: "media-finalize-event-1",
      providerMessageId: "media-finalize-message-1", providerConversationId: "media-finalize-conversation-1",
      providerSenderId: "media-finalize-sender-1", providerTarget: { kind: "PEER", providerId: "media-finalize-peer-1" },
      providerEventType: "MESSAGE", sourceTimestamp: "2026-08-01T00:00:00.000Z",
      callbackReceivedAt: "2026-08-01T00:00:01.000Z", rawEnvelope: { callback: "media" },
      rawEnvelopeSha256: canonicalSha256({ callback: "media" }), normalized,
      normalizedSha256: canonicalSha256(normalized),
    };
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await database.query(
        `insert into public.openclaw_retention_gateway_configs(
           id,organization_id,signing_key_generation,ticket_key_generation,public_key_hash,is_active,enabled_at
         ) values (
           'dddd7000-0000-4000-8000-000000000060',$1::uuid,1,1,repeat('a',64),true,statement_timestamp()
         ) on conflict (organization_id,signing_key_generation) do nothing`,
        [DEMO_ORG_ID],
      );
      const ingested = await database.query(
        `select app_private.openclaw_ingest_inbound_batch_v1($1::jsonb,'{}'::jsonb,$2::jsonb) result`,
        [JSON.stringify(principal), JSON.stringify({
          version: 1, organizationId: DEMO_ORG_ID, accountId, cellId, sessionGeneration: 1, events: [event],
        })],
      );
      const mediaId = ingested.rows[0].result.results[0].media[0].mediaId;
      const issued = await database.query(
        `select app_private.openclaw_issue_media_ticket_v1($1::jsonb,'{}'::jsonb,$2::jsonb) result`,
        [JSON.stringify(principal), JSON.stringify({
          version: 1,
          mediaId,
          operation: "PUT",
          verifiedSha256: checksum,
          contentType: "image/png",
          contentLength: 64,
        })],
      );
      const ticket = issued.rows[0].result.ticket;
      await database.query(
        `update public.openclaw_media_upload_tickets
         set issued_at=statement_timestamp()-interval '61 seconds',
             expires_at=statement_timestamp()-interval '1 second'
         where organization_id=$1 and ticket_jti=$2`,
        [DEMO_ORG_ID, ticket.jti],
      );
      const receipt = {
        version: 1, receiptKind: "MEDIA_UPLOAD", receiptId: "dddd7000-0000-4000-8000-000000000061",
        organizationId: DEMO_ORG_ID, accountId, cellId, mediaId, objectKey: ticket.objectKey,
        sha256: ticket.sha256, contentType: ticket.contentType, contentLength: ticket.contentLength,
        uploadTicketJti: ticket.jti, credentialGeneration: 1, leaseGeneration: 1, fencingToken: 1,
        sessionGeneration: 1, objectVersionOrEtag: "etag-media-finalize-1",
        storedAt: "2026-08-01T00:00:02.000Z",
        gatewaySigningKeyGeneration: ticket.receiptSigningKeyGeneration,
        signature: "A".repeat(86),
      };
      const request = { version: 1, mediaId, gatewayReceipt: receipt };
      const finalized = await database.query(
        `select app_private.openclaw_finalize_media_upload_v1($1::jsonb,'{}'::jsonb,$2::jsonb) result`,
        [JSON.stringify(principal), JSON.stringify(request)],
      );
      expect(finalized.rows[0].result).toMatchObject({
        version: 1, mediaId, byteState: "AVAILABLE", idempotentReplay: false,
        receiptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const replay = await database.query(
        `select app_private.openclaw_finalize_media_upload_v1($1::jsonb,'{}'::jsonb,$2::jsonb) result`,
        [JSON.stringify(principal), JSON.stringify(request)],
      );
      expect(replay.rows[0].result).toMatchObject({ idempotentReplay: true, receiptHash: finalized.rows[0].result.receiptHash });
      await expect(database.query(
        `select app_private.openclaw_finalize_media_upload_v1($1::jsonb,'{}'::jsonb,$2::jsonb)`,
        [JSON.stringify(principal), JSON.stringify({
          ...request, gatewayReceipt: { ...receipt, objectVersionOrEtag: "forged-etag" },
        })],
      )).rejects.toThrow(/replay mismatch/i);
    } finally {
      await database.close();
    }
  }, 30_000);

  it("returns each outbox lease as the exact canonical OutboxClaim contract", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
    } = await import("../test-openclaw-migrations.mjs");
    const { validateRuntimeResponseBody } = await import(
      "../../supabase/functions/openclaw-runtime/contracts.ts"
    );
    const database = await createDisposableOpenClawDatabase();
    const accountId = "11111111-1111-4111-8111-111111111111";
    const cellId = "22222222-2222-4222-8222-222222222222";
    const outboxId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000090";
    const claimToken = "c".repeat(32);
    const payload = {
      version: 1,
      organizationId: DEMO_ORG_ID,
      accountId,
      target: { kind: "PEER", providerId: "peer-concurrency" },
      channel: "zalouser",
      accountProfile: "concurrency",
      idempotencyKey: "canonical-outbox-claim",
      parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: "canonical" }],
      replyToProviderMessageId: null,
      policyVersionId: "66666666-6666-4666-8666-666666666662",
      automationVersionId: null,
      templateVersionId: null,
      frozenInputs: {
        campaignVersionId: null,
        scheduleVersion: null,
        subscriptionVersion: null,
        subscriptionId: null,
        occurrenceId: null,
        sourceTable: null,
        sourceId: null,
        sourceVersion: null,
        knowledgeVersionIds: [],
        sourceSnapshotHash: null,
        targetVersion: 1,
        targetDirectoryRefreshedAt: "2026-07-31T00:00:00.000Z",
        fieldMappingHash: null,
      },
    };
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await database.query(
        `insert into public.openclaw_outbox(
           id,organization_id,account_id,target_id,source_kind,actor_id,
           client_operation_id,idempotency_key,canonical_payload,
           canonical_payload_bytes,payload_hash
         ) values (
           $1,$2,$3,'55555555-5555-4555-8555-555555555555','MANUAL',
           '99999999-9999-4999-8999-999999999999',
           'bbbbbbbb-bbbb-4bbb-8bbb-000000000091',$4,$5::jsonb,
           app_private.openclaw_jcs_bytes_v1($5::jsonb),
           app_private.openclaw_send_payload_hash_v1($5::jsonb)
         )`,
        [outboxId, DEMO_ORG_ID, accountId, payload.idempotencyKey, JSON.stringify(payload)],
      );
      const claimed = await database.query(
        `select app_private.openclaw_claim_outbox_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [
          JSON.stringify({
            version: 1,
            principalKind: "CHANNEL",
            organizationId: DEMO_ORG_ID,
            accountId,
            cellId,
            credentialGeneration: 1,
            leaseGeneration: 1,
            fencingToken: 1,
            sessionGeneration: 1,
          }),
          JSON.stringify({ version: 1, claimToken, limit: 1, leaseSeconds: 30 }),
        ],
      );

      expect(claimed.rows[0].result).toEqual({
        version: 1,
        items: [{
          version: 1,
          outboxId,
          organizationId: DEMO_ORG_ID,
          accountId,
          claimToken,
          claimGeneration: 1,
          fencingToken: 1,
          sessionGeneration: 1,
          controlVersion: 1,
          takeoverVersion: 0,
          leaseExpiresAt: expect.any(String),
          payloadHash: canonicalSendSha256(payload),
          payload,
        }],
      });
      const denied = await database.query(
        `select app_private.openclaw_preflight_outbox_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify({
          version: 1,
          principalKind: "CHANNEL",
          organizationId: DEMO_ORG_ID,
          accountId,
          cellId,
          credentialGeneration: 1,
          leaseGeneration: 1,
          fencingToken: 1,
          sessionGeneration: 1,
        }), JSON.stringify({ version: 1, outboxId, claimGeneration: 1, claimToken })],
      );
      expect(denied.rows[0].result).toMatchObject({
        version: 1,
        outboxId,
        decision: "CONSENT_MISSING",
        disposition: "SAFE_RETRY",
        transitionApplied: true,
        canonicalPayload: null,
        authorizationMarker: null,
        retryNotBefore: expect.stringMatching(/T/),
      });
      expect(validateRuntimeResponseBody("/v1/outbox/preflight", denied.rows[0].result)).toBe(true);
      const transitioned = await database.query(
        `select state,claim_token_hash,lease_expires_at,retry_not_before
         from public.openclaw_outbox where organization_id=$1 and id=$2`,
        [DEMO_ORG_ID, outboxId],
      );
      expect(transitioned.rows[0]).toMatchObject({
        state: "QUEUED",
        claim_token_hash: null,
        lease_expires_at: null,
        retry_not_before: expect.any(Date),
      });
    } finally {
      await database.close();
    }
  }, 30_000);

  it("materializes and leases every send-work kind as the exact canonical claim contract", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const { validateRuntimeResponseBody } = await import(
      "../../supabase/functions/openclaw-runtime/contracts.ts"
    );
    const database = await createDisposableOpenClawDatabase();
    const principal = {
      version: 1,
      principalKind: "CHANNEL",
      organizationId: DEMO_ORG_ID,
      accountId: "11111111-1111-4111-8111-111111111111",
      cellId: "22222222-2222-4222-8222-222222222222",
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      sessionGeneration: 1,
    };
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "DUPLICATE_SCHEDULE_MATERIALIZER");
      await runDisposableConcurrencyScenario(database, "CRM_FANOUT_IDEMPOTENCY");
      await database.exec(`set session_replication_role='replica'`);
      await database.query(`
        update public.openclaw_automation_versions
        set allowed_crm_fields=array['customerName','amountDue']::text[]
        where organization_id=$1
          and id='66666666-6666-4666-8666-666666666664'::uuid
      `, [DEMO_ORG_ID]);
      await database.exec(`set session_replication_role='origin'`);
      const claimToken = "canonical-work-claim-token-0123456789abcdef";
      const claimed = await database.query(
        `select app_private.openclaw_claim_work_item_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [
          JSON.stringify(principal),
          JSON.stringify({
            version: 1,
            claimToken,
            limit: 10,
            leaseSeconds: 30,
            requestedKinds: ["SCHEDULE_OCCURRENCE", "CRM_EVENT"],
          }),
        ],
      );
      expect(claimed.rows[0].result.items).toHaveLength(2);
      expect(validateRuntimeResponseBody("/v1/work/claim", claimed.rows[0].result)).toBe(true);
      const crmClaim = claimed.rows[0].result.items.find((item) => item.payload.kind === "CRM_EVENT");
      const context = await database.query(
        `select app_private.openclaw_get_work_context_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify({ version: 1, claim: crmClaim })],
      );
      expect(context.rows[0].result.frozenContext.allowedCrmFields)
        .toEqual(["customerName", "amountDue"]);
      expect(validateRuntimeResponseBody("/v1/work/context", context.rows[0].result)).toBe(true);
    } finally {
      await database.close();
    }
  }, 30_000);

  it("completes channel work with a domain-separated exact result and lost-response replay", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const { validateRuntimeResponseBody } = await import(
      "../../supabase/functions/openclaw-runtime/contracts.ts"
    );
    const database = await createDisposableOpenClawDatabase();
    const principal = {
      version: 1,
      principalKind: "CHANNEL",
      organizationId: DEMO_ORG_ID,
      accountId: "11111111-1111-4111-8111-111111111111",
      cellId: "22222222-2222-4222-8222-222222222222",
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      sessionGeneration: 1,
    };
    const claimToken = "canonical-completion-token-0123456789abcdef";
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "DUPLICATE_SCHEDULE_MATERIALIZER");
      const claimed = await database.query(
        `select app_private.openclaw_claim_work_item_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify({
          version: 1,
          claimToken,
          limit: 1,
          leaseSeconds: 30,
          requestedKinds: ["SCHEDULE_OCCURRENCE"],
        })],
      );
      const claim = claimed.rows[0].result.items[0];
      const evidence = {
        version: 1,
        evidenceKind: "WORK_FAILURE",
        reasonCode: "UPSTREAM_TIMEOUT",
        failureFingerprint: "a".repeat(64),
      };
      const request = {
        version: 1,
        workItemId: claim.workItemId,
        organizationId: principal.organizationId,
        accountId: principal.accountId,
        cellId: principal.cellId,
        credentialGeneration: principal.credentialGeneration,
        leaseGeneration: principal.leaseGeneration,
        claimToken,
        claimGeneration: claim.claimGeneration,
        fencingToken: principal.fencingToken,
        outcome: "RETRY",
        evidence,
        evidenceHash: canonicalDomainSha256(
          "ihome-openclaw-send-work-completion-v1",
          evidence,
        ),
        retryAfterSeconds: 7,
      };
      await expect(database.query(
        `select app_private.openclaw_complete_work_item_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         )`,
        [JSON.stringify(principal), JSON.stringify({
          ...request,
          evidenceHash: "f".repeat(64),
        })],
      )).rejects.toThrow();
      const completed = await database.query(
        `select app_private.openclaw_complete_work_item_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify(request)],
      );
      const replayed = await database.query(
        `select app_private.openclaw_complete_work_item_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify(request)],
      );
      expect(replayed.rows[0].result).toEqual(completed.rows[0].result);
      expect(completed.rows[0].result).toMatchObject({
        version: 1,
        workItemId: claim.workItemId,
        claimGeneration: claim.claimGeneration,
        outcome: "SAFE_RETRY",
        canonicalEvidenceHash: request.evidenceHash,
        completedAt: null,
      });
      expect(completed.rows[0].result.retryNotBefore).toMatch(/T/);
      expect(validateRuntimeResponseBody("/v1/work/complete", completed.rows[0].result)).toBe(true);
    } finally {
      await database.close();
    }
  }, 30_000);

  it("persists exact NO_SEND and authoritative HUMAN_DRAFT channel outcomes atomically", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    const principal = {
      version: 1,
      principalKind: "CHANNEL",
      organizationId: DEMO_ORG_ID,
      accountId: QR_ACCOUNT_ID,
      cellId: QR_CELL_ID,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      sessionGeneration: 1,
    };
    const inboundEventId = "ab180000-0000-4000-8000-000000000001";
    const decisionId = "ab180000-0000-4000-8000-000000000002";
    const workId = "ab180000-0000-4000-8000-000000000003";
    const messageId = "ab180000-0000-4000-8000-000000000004";
    const conversationId = "55555555-5555-4555-8555-555555555556";
    const targetId = "55555555-5555-4555-8555-555555555555";
    const sourceHash = "8".repeat(64);
    const claimToken = "canonical-disposition-token-0123456789abcdef";
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "DUPLICATE_SCHEDULE_MATERIALIZER");
      const inboundPayload = {
        kind: "INBOUND_AUTOMATION",
        inboundEventId,
        messageId,
        conversationId,
        targetId,
        targetVersion: 1,
        targetDirectoryRefreshedAt: "2026-08-01T00:00:00.000Z",
        automationVersionId: "ab180000-0000-4000-8000-000000000005",
        templateVersionId: null,
        knowledgeVersionIds: [],
        eligibilityDecisionHash: sourceHash,
      };
      await database.exec(`set session_replication_role='replica'`);
      await database.query(`
        insert into public.openclaw_inbound_events(
          id,organization_id,account_id,cell_id,session_generation,event_kind,
          provider_event_id,provider_message_id,provider_conversation_id,provider_sender_id,
          target_kind,target_provider_id,provider_event_type,source_timestamp,callback_received_at,
          raw_envelope,raw_envelope_sha256,normalized_envelope,normalized_sha256,payload_hash
        ) values (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,1,'MESSAGE',
          'human-draft-event','human-draft-message','concurrency-retention','sender-1',
          'PEER','peer-concurrency','message',statement_timestamp(),statement_timestamp(),
          '{}'::jsonb,repeat('1',64),'{}'::jsonb,repeat('2',64),repeat('3',64)
        )
      `, [inboundEventId, DEMO_ORG_ID, QR_ACCOUNT_ID, QR_CELL_ID]);
      await database.query(`
        insert into public.openclaw_inbound_automation_decisions(
          id,organization_id,account_id,inbound_event_id,decision_kind,eligibility_reason,
          automation_version_id,knowledge_version_ids,frozen_inputs,frozen_inputs_hash
        ) values (
          $2::uuid,$3::uuid,$4::uuid,$1::uuid,'WORK_ELIGIBLE','ALLOWED',
          'ab180000-0000-4000-8000-000000000005'::uuid,'{}'::uuid[],'{}'::jsonb,$5
        )
      `, [inboundEventId, decisionId, DEMO_ORG_ID, QR_ACCOUNT_ID, sourceHash]);
      await database.exec(`set session_replication_role='origin'`);
      await database.query(`
        insert into public.openclaw_send_work_items(
          id,organization_id,account_id,cell_id,work_kind,source_id,source_version,
          source_hash,payload,payload_hash,fencing_token,session_generation
        ) values (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'INBOUND_AUTOMATION',$5::uuid,'1',
          $6,$7::jsonb,$8,1,1
        )
      `, [
        workId, DEMO_ORG_ID, QR_ACCOUNT_ID, QR_CELL_ID, inboundEventId, sourceHash,
        JSON.stringify(inboundPayload), canonicalSha256(inboundPayload),
      ]);

      const claimed = await database.query(
        `select app_private.openclaw_claim_work_item_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify({
          version: 1,
          claimToken,
          limit: 10,
          leaseSeconds: 30,
          requestedKinds: ["INBOUND_AUTOMATION", "SCHEDULE_OCCURRENCE"],
        })],
      );
      const inboundClaim = claimed.rows[0].result.items.find(
        (item) => item.payload.kind === "INBOUND_AUTOMATION",
      );
      const scheduleClaim = claimed.rows[0].result.items.find(
        (item) => item.payload.kind === "SCHEDULE_OCCURRENCE",
      );
      expect(inboundClaim).toBeDefined();
      expect(scheduleClaim).toBeDefined();

      const complete = async (claim, evidence) => database.query(
        `select app_private.openclaw_complete_work_item_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify({
          version: 1,
          workItemId: claim.workItemId,
          organizationId: DEMO_ORG_ID,
          accountId: QR_ACCOUNT_ID,
          cellId: QR_CELL_ID,
          credentialGeneration: 1,
          leaseGeneration: 1,
          claimToken,
          claimGeneration: claim.claimGeneration,
          fencingToken: 1,
          outcome: "COMPLETE",
          evidence,
          evidenceHash: canonicalDomainSha256(
            "ihome-openclaw-send-work-completion-v1",
            evidence,
          ),
          retryAfterSeconds: null,
        })],
      );
      const noSendEvidence = {
        version: 1,
        evidenceKind: "NO_SEND",
        reasonCode: "TAKEOVER_ACTIVE",
      };
      await complete(scheduleClaim, noSendEvidence);

      const draftText = "Lien he [REDACTED_EMAIL].";
      const humanDraftEvidence = {
        version: 1,
        evidenceKind: "HUMAN_DRAFT",
        reasonCode: "DLP_BLOCKED",
        classification: "TENANT_SUPPORT",
        confidenceBasisPoints: 7500,
        findings: ["EMAIL"],
        draftText,
        draftHash: domainTextSha256("ihome-openclaw-human-draft-v1", draftText),
      };
      const humanCompleted = await complete(inboundClaim, humanDraftEvidence);
      const humanReplayed = await complete(inboundClaim, humanDraftEvidence);
      expect(humanReplayed.rows[0].result).toEqual(humanCompleted.rows[0].result);

      const persisted = await database.query(`
        select
          (select count(*)::integer from public.openclaw_send_work_attempts attempt
           where attempt.organization_id=$1 and attempt.work_item_id=$2::uuid
             and attempt.evidence#>>'{clientEvidence,evidenceKind}'='NO_SEND') no_send_count,
          (select count(*)::integer from public.openclaw_ai_drafts draft
           where draft.organization_id=$1 and draft.inbound_event_id=$3::uuid
             and draft.automation_decision_id=$4::uuid
             and draft.draft_text=$5 and draft.dlp_decision='BLOCK') draft_count
      `, [DEMO_ORG_ID, scheduleClaim.workItemId, inboundEventId, decisionId, draftText]);
      expect(persisted.rows[0]).toEqual({ no_send_count: 1, draft_count: 1 });
    } finally {
      await database.close();
    }
  }, 30_000);

  it("atomically creates one outbox from the nested frozen work claim and replays its result", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const { validateRuntimeResponseBody } = await import(
      "../../supabase/functions/openclaw-runtime/contracts.ts"
    );
    const database = await createDisposableOpenClawDatabase();
    const principal = {
      version: 1,
      principalKind: "CHANNEL",
      organizationId: DEMO_ORG_ID,
      accountId: "11111111-1111-4111-8111-111111111111",
      cellId: "22222222-2222-4222-8222-222222222222",
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      sessionGeneration: 1,
    };
    const claimToken = "canonical-create-outbox-token-0123456789abcdef";
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "DUPLICATE_SCHEDULE_MATERIALIZER");
      const claimed = await database.query(
        `select app_private.openclaw_claim_work_item_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify({
          version: 1,
          claimToken,
          limit: 1,
          leaseSeconds: 30,
          requestedKinds: ["SCHEDULE_OCCURRENCE"],
        })],
      );
      const claim = claimed.rows[0].result.items[0];
      const frozen = await database.query(
        `select work.source_hash,target.kind,target.provider_id,automation.policy_version_id
         from public.openclaw_send_work_items work
         join public.openclaw_targets target
           on target.organization_id=work.organization_id
          and target.account_id=work.account_id and target.id=work.target_id
         join public.openclaw_automation_versions automation
           on automation.organization_id=work.organization_id
          and automation.account_id=work.account_id
          and automation.id=(work.payload->>'automationVersionId')::uuid
         where work.organization_id=$1 and work.id=$2`,
        [DEMO_ORG_ID, claim.workItemId],
      );
      const lineage = frozen.rows[0];
      const canonicalPayload = {
        version: 1,
        organizationId: principal.organizationId,
        accountId: principal.accountId,
        target: { kind: lineage.kind, providerId: lineage.provider_id },
        channel: "zalouser",
        accountProfile: "concurrency",
        idempotencyKey: "canonical-work-to-outbox",
        parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: "scheduled canonical" }],
        replyToProviderMessageId: null,
        policyVersionId: lineage.policy_version_id,
        automationVersionId: claim.payload.automationVersionId,
        templateVersionId: claim.payload.templateVersionId,
        frozenInputs: {
          campaignVersionId: claim.payload.campaignVersionId,
          scheduleVersion: claim.payload.scheduleVersion,
          subscriptionVersion: null,
          subscriptionId: null,
          occurrenceId: claim.payload.occurrenceId,
          sourceTable: "openclaw_schedule_snapshots",
          sourceId: claim.payload.scheduleId,
          sourceVersion: String(claim.payload.scheduleVersion),
          knowledgeVersionIds: claim.payload.knowledgeVersionIds,
          sourceSnapshotHash: lineage.source_hash,
          targetVersion: claim.payload.targetVersion,
          targetDirectoryRefreshedAt: claim.payload.targetDirectoryRefreshedAt,
          fieldMappingHash: null,
        },
      };
      const request = {
        version: 1,
        principalKind: "CHANNEL",
        claim,
        canonicalPayload,
        payloadHash: canonicalSendSha256(canonicalPayload),
        sourceSnapshotHash: lineage.source_hash,
      };
      await expect(database.query(
        `select app_private.openclaw_create_outbox_from_work_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         )`,
        [JSON.stringify(principal), JSON.stringify({
          ...request,
          sourceSnapshotHash: "f".repeat(64),
        })],
      )).rejects.toThrow(/source|snapshot|hash|mismatch/i);
      const completed = await database.query(
        `select app_private.openclaw_create_outbox_from_work_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify(request)],
      );
      const replayed = await database.query(
        `select app_private.openclaw_create_outbox_from_work_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify(request)],
      );
      expect(replayed.rows[0].result).toEqual(completed.rows[0].result);
      expect(completed.rows[0].result).toMatchObject({
        version: 1,
        workItemId: claim.workItemId,
        claimGeneration: claim.claimGeneration,
        outcome: "COMPLETED",
        completedAt: expect.stringMatching(/T/),
        retryNotBefore: null,
      });
      expect(validateRuntimeResponseBody(
        "/v1/work/create-outbox",
        completed.rows[0].result,
      )).toBe(true);
      const proof = await database.query(
        `select work.state,
          (select count(*)::integer from public.openclaw_outbox outbox
           where outbox.organization_id=work.organization_id
             and outbox.account_id=work.account_id
             and outbox.idempotency_key='canonical-work-to-outbox') outbox_count,
          (select count(*)::integer from public.openclaw_send_work_attempts attempt
           where attempt.organization_id=work.organization_id
             and attempt.account_id=work.account_id
             and attempt.work_item_id=work.id
             and attempt.claim_generation=$2) attempt_count
         from public.openclaw_send_work_items work
         where work.organization_id=$1 and work.id=$3`,
        [DEMO_ORG_ID, claim.claimGeneration, claim.workItemId],
      );
      expect(proof.rows[0]).toEqual({ state: "COMPLETE", outbox_count: 1, attempt_count: 1 });
    } finally {
      await database.close();
    }
  }, 30_000);

  it("loads one claim-bound frozen work context without re-evaluating its source lineage", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const { validateRuntimeResponseBody } = await import(
      "../../supabase/functions/openclaw-runtime/contracts.ts"
    );
    const database = await createDisposableOpenClawDatabase();
    const principal = {
      version: 1,
      principalKind: "CHANNEL",
      organizationId: DEMO_ORG_ID,
      accountId: "11111111-1111-4111-8111-111111111111",
      cellId: "22222222-2222-4222-8222-222222222222",
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      sessionGeneration: 1,
    };
    const claimToken = "canonical-work-context-token-0123456789abcdef";
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "DUPLICATE_SCHEDULE_MATERIALIZER");
      const claimed = await database.query(
        `select app_private.openclaw_claim_work_item_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify({
          version: 1,
          claimToken,
          limit: 1,
          leaseSeconds: 30,
          requestedKinds: ["SCHEDULE_OCCURRENCE"],
        })],
      );
      const claim = claimed.rows[0].result.items[0];
      const result = await database.query(
        `select app_private.openclaw_get_work_context_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         ) result`,
        [JSON.stringify(principal), JSON.stringify({ version: 1, claim })],
      );
      expect(result.rows[0].result).toMatchObject({
        version: 1,
        workItemId: claim.workItemId,
        claimGeneration: claim.claimGeneration,
        kind: "SCHEDULE_OCCURRENCE",
        currentState: { allowed: true },
        frozenContext: {
          frozenIdentity: claim.payload,
          template: "Concurrency body",
          values: {},
          requiredFields: [],
          sourceSnapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
      expect(result.rows[0].result.frozenContext.canonicalPayload).toMatchObject({
        version: 1,
        organizationId: principal.organizationId,
        accountId: principal.accountId,
        idempotencyKey: `work:${claim.workItemId}:${claim.claimGeneration}`,
        automationVersionId: claim.payload.automationVersionId,
        templateVersionId: claim.payload.templateVersionId,
      });
      expect(validateRuntimeResponseBody("/v1/work/context", result.rows[0].result)).toBe(true);
      await expect(database.query(
        `select app_private.openclaw_get_work_context_v1(
           $1::jsonb,'{}'::jsonb,$2::jsonb
         )`,
        [JSON.stringify(principal), JSON.stringify({
          version: 1,
          claim: { ...claim, claimToken: `${claimToken}-forged` },
        })],
      )).rejects.toThrow(/claim|binding|CAS/i);
    } finally {
      await database.close();
    }
  }, 30_000);

  it("accepts only the nested canonical pre-handoff requeue evidence", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "PRE_HANDOFF_REQUEUE");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("recomputes and persists only canonical nested delivery evidence", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "CANONICAL_OUTBOX_COMPLETION");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("returns each send-work lease as the exact discriminated channel claim", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "WORK_SINGLE_CLAIM");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("returns each maintenance lease as the exact discriminated maintenance claim", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "CANONICAL_MAINTENANCE_CLAIM");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("computes canonical audit Merkle and two-day lineage vectors", async () => {
    const { createDisposableOpenClawDatabase } = await import(
      "../test-openclaw-migrations.mjs"
    );
    const database = await createDisposableOpenClawDatabase();
    try {
      const vectors = await database.query(`
        with input as (
          select array[1,2,3,4,5]::bigint[] sequences,array[
            '71bb08f28b0d3413ec32394fa98bd4b7262810b96369e6ed7018b3b42fd344b5',
            '1f85873b4a1537355b1bee86aa0fa30a679ca34db1b29e96629f3d0339f48d85',
            'f2905810ffdd01ea6d198631066d0b27e966344a60b5837cb4fbbf49c0c2a024',
            'c74d3bfc1a47cb56a185fd72048b03f1210d620b4adb0b22b3ae1c611f455cd2',
            '7c58b76d482050f93e933d8d23632bd5a924cfc82c2315dc3e5bd35a3b85ee26'
          ]::text[] hashes
        )
        select
          app_private.openclaw_audit_merkle_root_v1(sequences[1:1],hashes[1:1]) merkle_1,
          app_private.openclaw_audit_merkle_root_v1(sequences[1:2],hashes[1:2]) merkle_2,
          app_private.openclaw_audit_merkle_root_v1(sequences[1:3],hashes[1:3]) merkle_3,
          app_private.openclaw_audit_merkle_root_v1(sequences[1:5],hashes[1:5]) merkle_5,
          app_private.openclaw_audit_merkle_root_v1(sequences[4:5],hashes[4:5]) merkle_day_2
        from input
      `);
      expect(vectors.rows[0]).toEqual({
        merkle_1: "45490f8ffcc4f08e977c78f79c6a1cc410a5b249eb51e5fe35f9abd919cb5292",
        merkle_2: "18a2100cb3db89594a68b2288a1e225c81e5a9cb668b4570e687822f2e036ad7",
        merkle_3: "680dfed884ac4a942a97610d7964aa9d2ef2714700811ff0bec0ee8f975bcd5d",
        merkle_5: "6c7271a335fa1cef34499a7692e31d056b5cb606ca04afa9d0abe8981fe71942",
        merkle_day_2: "5af61c99184c7eae60fc2b0800b331577fb007280c3ddae926525337c6b4a805",
      });
      const lineage = await database.query(`
        select
          app_private.openclaw_audit_lineage_root_v1(
            '${DEMO_ORG_ID}','2026-07-31',1,3,3,null,
            '680dfed884ac4a942a97610d7964aa9d2ef2714700811ff0bec0ee8f975bcd5d'
          ) day_1,
          app_private.openclaw_audit_lineage_root_v1(
            '${DEMO_ORG_ID}','2026-08-01',4,5,2,
            'd3ba432ceb1b5bd92581bbcf4cc20da0e09d3fb23cf096702b4862b137569d7f',
            '5af61c99184c7eae60fc2b0800b331577fb007280c3ddae926525337c6b4a805'
          ) day_2
      `);
      expect(lineage.rows[0]).toEqual({
        day_1: "d3ba432ceb1b5bd92581bbcf4cc20da0e09d3fb23cf096702b4862b137569d7f",
        day_2: "0ee35eeb142d44682861ddbbefd15f87b9f6b1b6fbab5690999b0d3290dfceb1",
      });
    } finally {
      await database.close();
    }
  }, 30_000);

  it("materializes the exact twelve-field audit anchor payload", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await database.exec(`
        set session_replication_role='replica';
        insert into public.openclaw_audit_signing_configs(
          id,organization_id,signing_key_generation,public_key_hash,is_active,enabled_at
        ) values (
          'dddd7300-0000-4000-8000-000000000001','${DEMO_ORG_ID}',1,
          repeat('a',64),true,statement_timestamp()
        );
        insert into public.openclaw_audit_events(
          id,organization_id,organization_sequence,event_type,workload_principal,
          redacted_evidence,redacted_evidence_bytes,evidence_hash,previous_hash,event_hash,occurred_at
        ) values
          ('dddd7300-0000-4000-8000-000000000011','${DEMO_ORG_ID}',1,'VECTOR','test',
           '{}'::jsonb,convert_to('{}','UTF8'),encode(extensions.digest(convert_to('{}','UTF8'),'sha256'),'hex'),
           repeat('0',64),'71bb08f28b0d3413ec32394fa98bd4b7262810b96369e6ed7018b3b42fd344b5','2026-07-31T00:00:01Z'),
          ('dddd7300-0000-4000-8000-000000000012','${DEMO_ORG_ID}',2,'VECTOR','test',
           '{}'::jsonb,convert_to('{}','UTF8'),encode(extensions.digest(convert_to('{}','UTF8'),'sha256'),'hex'),
           repeat('1',64),'1f85873b4a1537355b1bee86aa0fa30a679ca34db1b29e96629f3d0339f48d85','2026-07-31T00:00:02Z'),
          ('dddd7300-0000-4000-8000-000000000013','${DEMO_ORG_ID}',3,'VECTOR','test',
           '{}'::jsonb,convert_to('{}','UTF8'),encode(extensions.digest(convert_to('{}','UTF8'),'sha256'),'hex'),
           repeat('2',64),'f2905810ffdd01ea6d198631066d0b27e966344a60b5837cb4fbbf49c0c2a024','2026-07-31T00:00:03Z');
        set session_replication_role='origin';
      `);
      const created = await database.query(
        `select app_private.materialize_openclaw_audit_root_v1(31) created`,
      );
      expect(created.rows[0].created).toBe(1);
      const materialized = await database.query(`
        select root.id,root.previous_root_hash,root.merkle_root_hash,root.root_hash,
          root.first_sequence,root.last_sequence,root.event_count,work.payload
        from public.openclaw_audit_roots root
        join public.openclaw_maintenance_work_items work
          on work.organization_id=root.organization_id and work.source_id=root.id
        where root.organization_id=$1 and root.root_date='2026-07-31'
      `, [DEMO_ORG_ID]);
      expect(materialized.rows[0]).toMatchObject({
        previous_root_hash: null,
        merkle_root_hash: "680dfed884ac4a942a97610d7964aa9d2ef2714700811ff0bec0ee8f975bcd5d",
        root_hash: "d3ba432ceb1b5bd92581bbcf4cc20da0e09d3fb23cf096702b4862b137569d7f",
        first_sequence: 1,
        last_sequence: 3,
        event_count: 3,
      });
      expect(Object.keys(materialized.rows[0].payload).sort()).toEqual([
        "anchorKey", "auditRootId", "auditSigningKeyGeneration",
        "auditSigningPublicKeyHash", "eventCount", "firstSequence", "kind",
        "lastSequence", "merkleRootHash", "previousRootHash", "rootDate", "rootHash",
      ].sort());
      expect(materialized.rows[0].payload).toMatchObject({
        kind: "AUDIT_ANCHOR",
        auditRootId: materialized.rows[0].id,
        rootDate: "2026-07-31",
        firstSequence: 1,
        lastSequence: 3,
        eventCount: 3,
        previousRootHash: null,
        merkleRootHash: materialized.rows[0].merkle_root_hash,
        rootHash: materialized.rows[0].root_hash,
        auditSigningKeyGeneration: 1,
        auditSigningPublicKeyHash: "a".repeat(64),
      });
    } finally {
      await database.close();
    }
  }, 30_000);

  it("reclaims an authorized retention delete without the cleared original claim token", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "RETENTION_AUTHORIZED_RECLAIM");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("reclaims audit work while preserving the original Gateway verify lineage", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "AUDIT_VERIFY_RECLAIM");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("rejects an audit receipt whose signature hash differs from the issued ticket", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "FORGED_AUDIT_RECEIPT");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("refreshes expired retention recovery artifacts and accepts a late old receipt", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "RETENTION_RECOVERY_REFRESH");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("refreshes expired audit verify tickets and accepts a late old receipt", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "AUDIT_RECOVERY_REFRESH");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("keeps recovery refresh evidence, lineage, and terminal replay structurally explicit", async () => {
    const { createDisposableOpenClawDatabase } = await import(
      "../test-openclaw-migrations.mjs"
    );
    const database = await createDisposableOpenClawDatabase();
    try {
      const result = await database.query(`
        select
          to_regclass('public.openclaw_retention_delete_ticket_lineage')::text lineage_table,
          pg_get_functiondef(to_regprocedure(
            'app_private.openclaw_authorize_retention_delete_v1(jsonb,jsonb,jsonb)'
          )) retention_refresh,
          pg_get_functiondef(to_regprocedure(
            'app_private.openclaw_issue_media_ticket_v1(jsonb,jsonb,jsonb)'
          )) audit_refresh,
          pg_get_functiondef(to_regprocedure(
            'app_private.openclaw_finalize_retention_delete_v1(jsonb,jsonb,jsonb)'
          )) retention_finalize
      `);
      const row = result.rows[0];
      expect(row.lineage_table).toBe("openclaw_retention_delete_ticket_lineage");
      for (const definition of [row.retention_refresh, row.audit_refresh]) {
        expect(definition).toMatch(/'state'\s*,\s*'RECOVERY_REFRESHED'/);
        expect(definition).toMatch(
          /'status'\s*,\s*410\s*,\s*'code'\s*,\s*'TICKET_EXPIRED_NO_WORK'/,
        );
        expect(definition).toContain("'maintenancePrincipalId'");
        expect(definition).toContain("'credentialGeneration'");
        expect(definition).toContain("'leaseGeneration'");
        expect(definition).toContain("'fencingToken'");
        expect(definition).toContain("'recoveryGeneration'");
        expect(definition).toContain("'frozenClaim'");
        expect(definition).toContain("'claimGeneration'");
      }
      expect(row.retention_finalize.indexOf("if v_ticket.state='FINALIZED' then"))
        .toBeLessThan(row.retention_finalize.indexOf("retention recovery ownership CAS failed"));
    } finally {
      await database.close();
    }
  }, 30_000);

  it("persists maintenance failure readiness until the exact item succeeds", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "MAINTENANCE_FAILURE_READINESS");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("replays recovery failure, honors backoff, and succeeds after a fresh reclaim", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "MAINTENANCE_RECOVERY_FAILURE");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("claims, completes, replays, expires, and reclaims heartbeat commands", async () => {
    const {
      createDisposableOpenClawDatabase,
      prepareDisposableConcurrencyFixtures,
      runDisposableConcurrencyScenario,
    } = await import("../test-openclaw-migrations.mjs");
    const database = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(database);
      await runDisposableConcurrencyScenario(database, "HEARTBEAT_COMMAND_DELIVERY");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("exposes one service-only maintenance completion dispatcher facade", async () => {
    const { createDisposableOpenClawDatabase } = await import(
      "../test-openclaw-migrations.mjs"
    );
    const database = await createDisposableOpenClawDatabase();
    try {
      const result = await database.query(`
        select
          to_regprocedure(
            'public.openclaw_service_complete_maintenance_work_v1(jsonb,jsonb,jsonb)'
          )::text signature,
          case when to_regprocedure(
            'public.openclaw_service_complete_maintenance_work_v1(jsonb,jsonb,jsonb)'
          ) is null then false else has_function_privilege(
            'service_role',
            to_regprocedure(
              'public.openclaw_service_complete_maintenance_work_v1(jsonb,jsonb,jsonb)'
            ),
            'execute'
          ) end service_execute,
          case when to_regprocedure(
            'public.openclaw_service_complete_maintenance_work_v1(jsonb,jsonb,jsonb)'
          ) is null then false else has_function_privilege(
            'authenticated',
            to_regprocedure(
              'public.openclaw_service_complete_maintenance_work_v1(jsonb,jsonb,jsonb)'
            ),
            'execute'
          ) end browser_execute
      `);
      expect(result.rows[0]).toEqual({
        signature: "openclaw_service_complete_maintenance_work_v1(jsonb,jsonb,jsonb)",
        service_execute: true,
        browser_execute: false,
      });
    } finally {
      await database.close();
    }
  }, 30_000);

  it("leaves no OpenClaw or CRM trigger helper executable by PUBLIC", async () => {
    const { createDisposableOpenClawDatabase } = await import(
      "../test-openclaw-migrations.mjs"
    );
    const database = await createDisposableOpenClawDatabase();
    try {
      const result = await database.query(`
        select format('%I.%I(%s)',n.nspname,p.proname,
          pg_get_function_identity_arguments(p.oid)) signature
        from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','app_private')
          and (
            position('openclaw' in p.proname)>0
            or (n.nspname='public' and p.proname='trg_room_status_reconcile')
          )
          and has_function_privilege('public',p.oid,'execute')
        order by signature
      `);
      expect(result.rows).toEqual([]);
    } finally {
      await database.close();
    }
  }, 30_000);

  it("strictly parses the protected schema-drift command", async () => {
    const { parseMigrationHarnessArgs } = await import(
      "../test-openclaw-migrations.mjs"
    );
    const reviewedSha = "a".repeat(40);
    expect(
      parseMigrationHarnessArgs([
        "--schema-drift",
        "--project-ref",
        EXPECTED_PROJECT_REF,
        "--reviewed-sha",
        reviewedSha,
      ]),
    ).toEqual({
      mode: "schema-drift",
      projectRef: EXPECTED_PROJECT_REF,
      reviewedSha,
    });
    expect(() =>
      parseMigrationHarnessArgs([
        "--schema-drift",
        "--project-ref",
        EXPECTED_PROJECT_REF,
        "--project-ref",
        EXPECTED_PROJECT_REF,
        "--reviewed-sha",
        reviewedSha,
      ]),
    ).toThrow(/exactly once/i);
    expect(() =>
      parseMigrationHarnessArgs([
        "--schema-drift",
        "--project-ref",
        EXPECTED_PROJECT_REF,
        "--reviewed-sha",
        reviewedSha,
        "--write",
      ]),
    ).toThrow(/unknown/i);
  });

  it("hashes reviewed migration bytes with the canonical manifest domain", async () => {
    const { computeOpenClawMigrationManifest } = await import(
      "../test-openclaw-migrations.mjs"
    );
    const entries = [
      { file: "20260727010000_one.sql", bytes: Buffer.from("begin;\ncommit;\n") },
      { file: "20260727020000_two.sql", bytes: Buffer.from("begin;\nselect 2;\ncommit;\n") },
    ];
    const result = computeOpenClawMigrationManifest(entries);
    const expectedLines = entries.map(({ file, bytes }) =>
      `${file}:${createHash("sha256").update(bytes).digest("hex")}\n`,
    ).join("");
    const expectedAggregate = createHash("sha256")
      .update("ihome-openclaw-migration-manifest-v1")
      .update(Buffer.from([0]))
      .update(expectedLines)
      .digest("hex");
    expect(result.aggregateSha256).toBe(expectedAggregate);
    expect(result.entries.map((entry) => entry.file)).toEqual(entries.map((entry) => entry.file));
  });

  it("loads every manifest byte from the reviewed Git tree", async () => {
    const {
      OPENCLAW_MIGRATIONS,
      loadReviewedMigrationManifest,
    } = await import("../test-openclaw-migrations.mjs");
    const reviewedSha = "d".repeat(40);
    const runGit = vi.fn(async (_command, args) => {
      if (args[0] === "cat-file" && args[1] === "-e") {
        return { code: 0, stdout: "", stdoutBuffer: Buffer.alloc(0), stderr: "" };
      }
      if (args[0] === "ls-tree") {
        const stdout = OPENCLAW_MIGRATIONS
          .map((file) => `supabase/migrations/${file}`)
          .join("\n");
        return { code: 0, stdout, stdoutBuffer: Buffer.from(stdout), stderr: "" };
      }
      const file = String(args.at(-1)).split("/").at(-1);
      const stdoutBuffer = Buffer.from(`reviewed:${file}\n`);
      return { code: 0, stdout: stdoutBuffer.toString("utf8"), stdoutBuffer, stderr: "" };
    });
    const manifest = await loadReviewedMigrationManifest(reviewedSha, { runGit });
    expect(manifest.entries).toHaveLength(12);
    expect(manifest.entries[0].bytes.toString("utf8")).toBe(
      `reviewed:${OPENCLAW_MIGRATIONS[0]}\n`,
    );
    expect(runGit).toHaveBeenCalledTimes(14);
  });

  it("uses one pinned read-only Management API snapshot and redacts transport errors", async () => {
    const {
      OPENCLAW_MIGRATIONS,
      computeOpenClawMigrationManifest,
      requestRemoteSchemaSnapshot,
    } = await import("../test-openclaw-migrations.mjs");
    const manifest = computeOpenClawMigrationManifest(
      OPENCLAW_MIGRATIONS.map((file) => ({ file, bytes: Buffer.from(`${file}\n`) })),
    );
    const pat = "sbp_schema_drift_synthetic_secret";
    const snapshot = { migrations: [] };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ snapshot }]),
    }));
    await expect(
      requestRemoteSchemaSnapshot({
        projectRef: EXPECTED_PROJECT_REF,
        manifest,
        environment: { SUPABASE_PAT: pat },
        fetchImpl,
      }),
    ).resolves.toEqual(snapshot);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `https://api.supabase.com/v1/projects/${EXPECTED_PROJECT_REF}/database/query`,
    );
    expect(request.headers.Authorization).toBe(`Bearer ${pat}`);
    const query = JSON.parse(request.body).query;
    expect(query.trimStart()).toMatch(/^with\s/i);
    expect(query).not.toContain(";");

    try {
      await requestRemoteSchemaSnapshot({
        projectRef: EXPECTED_PROJECT_REF,
        manifest,
        environment: { SUPABASE_PAT: pat },
        fetchImpl: vi.fn(async () => {
          throw new Error(`transport rejected ${pat}`);
        }),
      });
      throw new Error("expected request failure");
    } catch (error) {
      expect(String(error.message)).toContain("[REDACTED");
      expect(String(error.message)).not.toContain(pat);
    }
  });

  it("verifies two identical read-only snapshots, reviewed types, and exact migration bytes", async () => {
    const {
      OPENCLAW_MIGRATIONS,
      computeOpenClawMigrationManifest,
      runSchemaDrift,
    } = await import("../test-openclaw-migrations.mjs");
    const reviewedSha = "b".repeat(40);
    const manifest = computeOpenClawMigrationManifest(
      OPENCLAW_MIGRATIONS.map((file) => ({ file, bytes: Buffer.from(`${file}\n`) })),
    );
    const snapshot = {
      migrations: manifest.entries.map((entry, index) => ({
        order: index + 1,
        version: entry.version,
        fileName: entry.file,
        migrationName: entry.name,
        recordedName: entry.name,
        statementCount: 1,
        recordedSha256: entry.sha256,
      })),
      unsafeViews: [],
      functions: [
        {
          signature: "app_private.openclaw_example()",
          owner: "openclaw_function_owner",
          securityDefiner: true,
          configuration: "search_path=\"\"",
          grantee: "openclaw_function_owner",
          privilegeType: "EXECUTE",
          isGrantable: false,
        },
      ],
      activationColumns: [
        "feature_enabled",
        "first_contact_enabled",
        "limited_auto_reply_enabled",
        "proactive_enabled",
        "sales_groups_enabled",
      ].map((columnName) => ({
        columnName,
        columnDefault: "false",
        isNullable: "NO",
      })),
      enabledRowCount: 0,
    };
    const requestRemoteSnapshot = vi
      .fn()
      .mockResolvedValueOnce(structuredClone(snapshot))
      .mockResolvedValueOnce(structuredClone(snapshot));
    const reviewedTypes = "// This file is automatically generated. Do not edit it directly.\nexport type Json = string\nexport type Database = {}\n";
    const result = await runSchemaDrift(
      { projectRef: EXPECTED_PROJECT_REF, reviewedSha },
      {
        loadReviewedMigrationManifest: vi.fn(async () => manifest),
        buildExpectedFunctionSnapshot: vi.fn(async () => snapshot.functions),
        requestRemoteSnapshot,
        generateRemoteTypes: vi.fn(async () => reviewedTypes),
        readReviewedTypes: vi.fn(async () => reviewedTypes),
      },
    );
    expect(result.summary).toMatch(/PASS read-only schema drift/i);
    expect(requestRemoteSnapshot).toHaveBeenCalledTimes(2);
  });

  it("fails schema drift closed with a forward-corrective-only instruction", async () => {
    const {
      FORWARD_CORRECTIVE_INSTRUCTION,
      OPENCLAW_MIGRATIONS,
      computeOpenClawMigrationManifest,
      runSchemaDrift,
    } = await import("../test-openclaw-migrations.mjs");
    const manifest = computeOpenClawMigrationManifest(
      OPENCLAW_MIGRATIONS.map((file) => ({ file, bytes: Buffer.from(`${file}\n`) })),
    );
    const unsafeSnapshot = {
      migrations: manifest.entries.map((entry, index) => ({
        order: index + 1,
        version: entry.version,
        fileName: entry.file,
        migrationName: entry.name,
        recordedName: entry.name,
        statementCount: 1,
        recordedSha256: entry.sha256,
      })),
      unsafeViews: ["unsafe_view"],
      functions: [],
      activationColumns: [],
      enabledRowCount: 1,
    };
    await expect(
      runSchemaDrift(
        { projectRef: EXPECTED_PROJECT_REF, reviewedSha: "c".repeat(40) },
        {
          loadReviewedMigrationManifest: vi.fn(async () => manifest),
          buildExpectedFunctionSnapshot: vi.fn(async () => []),
          requestRemoteSnapshot: vi.fn(async () => unsafeSnapshot),
          generateRemoteTypes: vi.fn(async () => "generated"),
          readReviewedTypes: vi.fn(async () => "reviewed"),
        },
      ),
    ).rejects.toThrow(FORWARD_CORRECTIVE_INSTRUCTION);
  });
});
