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
