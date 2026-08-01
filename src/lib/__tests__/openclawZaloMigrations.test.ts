import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateRuntimeResponseBody } from
  "../../../supabase/functions/openclaw-runtime/contracts";

const root = process.cwd();
const migrationDirectory = join(root, "supabase", "migrations");
const contractDirectory = join(root, "contracts", "openclaw-zalo");

const migrationManifest = [
  "20260727010000_openclaw_catalog_foundation.sql",
  "20260727015000_openclaw_security_principals.sql",
  "20260727020000_openclaw_inbox_schema.sql",
  "20260727025000_openclaw_inbound_automation.sql",
  "20260727030000_openclaw_policy_automation_knowledge.sql",
  "20260727040000_openclaw_delivery_audit_ops.sql",
  "20260727050000_openclaw_access_policies.sql",
  "20260727060000_openclaw_rpc_surface.sql",
  "20260727070000_openclaw_crm_event_sources.sql",
  "20260727080000_openclaw_realtime_allowlist.sql",
  "20260727090000_openclaw_maintenance_jobs.sql",
  "20260727095000_openclaw_activation_guards.sql",
] as const;

const contractManifest = [
  "control.schema.json",
  "runtime.schema.json",
  "inbound.schema.json",
  "maintenance.schema.json",
  "media.schema.json",
  "receipts.schema.json",
  "policy.schema.json",
  "state-machine.schema.json",
  "audit.schema.json",
] as const;

function read(path: string) {
  return readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function schemaValid(
  value: unknown,
  schema: Record<string, unknown>,
  root: Record<string, unknown> = schema,
): boolean {
  if (typeof schema.$ref === "string") {
    const [externalRef, fragment = ""] = schema.$ref.split("#", 2);
    const referenceRoot = externalRef
      ? JSON.parse(
          read(join(contractDirectory, externalRef.split("/").at(-1)!)),
        ) as Record<string, unknown>
      : root;
    const segments = fragment.replace(/^\//, "").split("/").filter(Boolean);
    let resolved: unknown = referenceRoot;
    for (const segment of segments) {
      resolved = (resolved as Record<string, unknown>)?.[
        segment.split("~1").join("/").split("~0").join("~")
      ];
    }
    if (!resolved || !schemaValid(
      value,
      resolved as Record<string, unknown>,
      referenceRoot,
    )) return false;
  }
  if (Array.isArray(schema.oneOf)) {
    if (schema.oneOf.filter((candidate) =>
      schemaValid(value, candidate as Record<string, unknown>, root),
    ).length !== 1) return false;
  }
  if (Array.isArray(schema.allOf) &&
      !schema.allOf.every((candidate) =>
        schemaValid(value, candidate as Record<string, unknown>, root))) {
    return false;
  }
  if (schema.if && schemaValid(value, schema.if as Record<string, unknown>, root)) {
    if (schema.then && !schemaValid(value, schema.then as Record<string, unknown>, root)) {
      return false;
    }
  } else if (schema.else &&
      !schemaValid(value, schema.else as Record<string, unknown>, root)) {
    return false;
  }
  if (schema.not && schemaValid(value, schema.not as Record<string, unknown>, root)) {
    return false;
  }
  if ("const" in schema && !Object.is(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(value, entry))) {
    return false;
  }

  const acceptedTypes = Array.isArray(schema.type)
    ? schema.type
    : schema.type ? [schema.type] : [];
  if (acceptedTypes.length > 0) {
    const actualType = value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : Number.isInteger(value)
          ? "integer"
          : typeof value;
    if (!acceptedTypes.includes(actualType) &&
        !(actualType === "integer" && acceptedTypes.includes("number"))) {
      return false;
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" &&
        [...value].length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" &&
        [...value].length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      return false;
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) return false;
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.uniqueItems &&
        new Set(value.map((entry) => canonicalJson(entry))).size !== value.length) return false;
    if (Array.isArray(schema.prefixItems)) {
      const prefixLength = schema.prefixItems.length;
      for (let index = 0; index < Math.min(value.length, prefixLength); index += 1) {
        if (!schemaValid(
          value[index],
          schema.prefixItems[index] as Record<string, unknown>,
          root,
        )) return false;
      }
      if (value.length > prefixLength) {
        if (schema.items === false) return false;
        if (schema.items && typeof schema.items === "object" &&
            !value.slice(prefixLength).every((entry) =>
              schemaValid(entry, schema.items as Record<string, unknown>, root))) return false;
      }
    } else if (schema.items && typeof schema.items === "object" &&
        !value.every((entry) =>
          schemaValid(entry, schema.items as Record<string, unknown>, root))) return false;
    if (schema.contains && typeof schema.contains === "object") {
      const matchCount = value.filter((entry) =>
        schemaValid(entry, schema.contains as Record<string, unknown>, root)).length;
      const minimum = typeof schema.minContains === "number" ? schema.minContains : 1;
      const maximum = typeof schema.maxContains === "number"
        ? schema.maxContains
        : Number.POSITIVE_INFINITY;
      if (matchCount < minimum || matchCount > maximum) return false;
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (Array.isArray(schema.required) &&
        !schema.required.every((key) => typeof key === "string" && key in object)) return false;
    if (typeof schema.minProperties === "number" &&
        Object.keys(object).length < schema.minProperties) return false;
    if (typeof schema.maxProperties === "number" &&
        Object.keys(object).length > schema.maxProperties) return false;
    if (schema.additionalProperties === false &&
        Object.keys(object).some((key) => !(key in properties))) return false;
    for (const [key, child] of Object.entries(object)) {
      if (properties[key] && !schemaValid(child, properties[key], root)) return false;
      if (!(key in properties) && typeof schema.additionalProperties === "object" &&
          !schemaValid(
            child,
            schema.additionalProperties as Record<string, unknown>,
            root,
          )) return false;
    }
  }
  return true;
}

describe("OpenClaw Zalo complete migration manifest", () => {
  it("loads exactly the twelve reviewed additive migrations in canonical order", () => {
    expect(migrationManifest).toHaveLength(12);
    for (const file of migrationManifest) {
      const sql = read(join(migrationDirectory, file));
      expect(sql).toMatch(/^begin;\n/i);
      expect(sql).toMatch(/\ncommit;\n?$/i);
      expect(sql).not.toMatch(/\b(drop\s+schema|truncate\s+table)\b/i);
    }
  });

  it("keeps definer functions fixed-path and browser roles deny-by-default", () => {
    const sql = migrationManifest
      .map((file) => read(join(migrationDirectory, file)))
      .join("\n");
    const definerBlocks = sql.match(
      /create(?:\s+or\s+replace)?\s+function[\s\S]*?\$function\$;/gi,
    ) ?? [];

    for (const block of definerBlocks.filter((value) =>
      /security\s+definer/i.test(value),
    )) {
      expect(block).toMatch(/set\s+search_path\s*=\s*''/i);
    }
    const openClawTables = Array.from(
      sql.matchAll(/create\s+table\s+public\.(openclaw_[a-z0-9_]+)/gi),
      (match) => match[1],
    );
    const revokedTables = new Set(
      Array.from(
        sql.matchAll(
          /revoke\s+all\s+on\s+(?!function\b|sequence\b|schema\b)([\s\S]*?)\s+from\s+public,\s*anon,\s*authenticated,\s*service_role\s*;/gi,
        ),
      ).flatMap((statement) =>
        Array.from(
          statement[1].matchAll(/public\.(openclaw_[a-z0-9_]+)/gi),
          (tableMatch) => tableMatch[1],
        ),
      ),
    );
    expect(openClawTables.length).toBeGreaterThan(50);
    for (const table of new Set(openClawTables)) {
      expect(revokedTables, `missing closed ACL for ${table}`).toContain(table);
    }
    expect(sql).not.toMatch(/\bgrant\s+(?:insert|update|delete|all)\b[^;]*\bto\s+(?:anon|authenticated)\b/i);
  });

  it("uses tenant-composite references and a closed realtime allowlist", () => {
    const sql = migrationManifest
      .map((file) => read(join(migrationDirectory, file)))
      .join("\n");
    const tenantReferences = Array.from(sql.matchAll(
      /foreign\s+key\s*\(([^)]+)\)\s*references\s+public\.(openclaw_[a-z0-9_]+)\s*\(([^)]+)\)/gi,
    ));
    expect(tenantReferences.length).toBeGreaterThan(50);
    for (const [, sourceColumns, targetTable, targetColumns] of tenantReferences) {
      const normalize = (columns: string) => columns
        .split(",")
        .map((column) => column.trim().replace(/^"|"$/g, "").toLowerCase());
      expect(normalize(sourceColumns)[0], `unsafe source FK to ${targetTable}`).toBe(
        "organization_id",
      );
      expect(normalize(targetColumns)[0], `unsafe target FK to ${targetTable}`).toBe(
        "organization_id",
      );
    }
    expect(sql).toContain("Unsafe OpenClaw relation is already present in supabase_realtime");
    expect(sql).toMatch(/published\.tablename<>all\s*\(array\[/i);
    expect(sql).toMatch(/pg_publication_tables[\s\S]*?attnames/i);
    expect(sql).not.toContain("pg_publication_columns");
    expect(sql).not.toMatch(/\b(chat-zalo|useZaloChat|zalo_[a-z0-9_]+|worker\/)\b/i);
  });

  it("leaves every automation and outbound activation switch fail-closed", () => {
    const sql = migrationManifest
      .map((file) => read(join(migrationDirectory, file)))
      .join("\n");
    for (const flag of [
      "feature_enabled",
      "limited_auto_reply_enabled",
      "proactive_enabled",
      "sales_groups_enabled",
      "first_contact_enabled",
    ]) {
      expect(sql).toMatch(new RegExp(`${flag}\\s+boolean\\s+not\\s+null\\s+default\\s+false`, "i"));
    }
    expect(sql).toContain("openclaw_rollout_runs_activation_guard");
    expect(sql).toContain("openclaw_outbound_authorizations_activation_guard");
  });
});

describe("OpenClaw shared JSON contracts", () => {
  it("publishes a closed draft-2020-12 schema for each contract domain", () => {
    for (const file of contractManifest) {
      const schema = JSON.parse(read(join(contractDirectory, file))) as Record<string, unknown>;
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id).toBe(`https://ihome.invalid/openclaw-zalo/${file}`);
      expect(schema).toHaveProperty("$defs");
      expect(schema).toHaveProperty("oneOf");
      expect(schema.unevaluatedProperties).toBe(false);
    }
    const maintenance = JSON.parse(
      read(join(contractDirectory, "maintenance.schema.json")),
    ) as { $defs: Record<string, unknown> };
    expect(Object.keys(maintenance.$defs)).toEqual(expect.arrayContaining([
      "sendWorkCompletionRequest",
      "retentionQuarantineCompletionRequest",
      "retentionDeleteAuthorizationRequest",
      "retentionDeleteFinalizationRequest",
      "auditAnchorAcknowledgementRequest",
      "specializedMaintenanceResult",
      "auditRecoveryWorkClaim",
      "retentionRecoveryWorkClaim",
      "auditRecoveryCompletionRequest",
      "retentionRecoveryCompletionRequest",
      "auditRecoveryRefreshRequest",
      "retentionRecoveryRefreshRequest",
      "auditRecoveryRefreshResult",
      "retentionRecoveryRefreshResult",
    ]));
    const media = JSON.parse(
      read(join(contractDirectory, "media.schema.json")),
    ) as { $defs: Record<string, unknown> };
    expect(Object.keys(media.$defs)).toEqual(expect.arrayContaining([
      "browserGetTicket",
      "runtimeTicket",
      "maintenanceDeleteTicket",
      "maintenanceAuditTicket",
      "retentionRecoveryTicket",
      "auditRecoveryTicket",
    ]));
    const receipts = JSON.parse(
      read(join(contractDirectory, "receipts.schema.json")),
    ) as { $defs: Record<string, unknown> };
    expect(receipts.$defs).toHaveProperty("retentionRecoveryAuthorization");
  });

  it("keeps cross-runtime golden vectors canonical and domain-separated", () => {
    const vectors = JSON.parse(
      read(join(contractDirectory, "golden-vectors.json")),
    ) as {
      version: number;
      vectors: Array<{
        name: string;
        schema: string;
        domain: string;
        value: unknown;
        canonicalJson: string;
        sha256: string;
      }>;
    };
    expect(vectors.version).toBe(1);
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(35);
    expect(vectors.vectors.map((vector) => vector.name)).toEqual(
      expect.arrayContaining([
        "control-envelope",
        "control-runtime-principal",
        "control-maintenance-principal",
        "canonical-send-unicode",
        "runtime-outbox-claim",
        "runtime-authorization-marker",
        "runtime-outbox-completion",
        "runtime-pre-handoff-requeue",
        "runtime-unknown-resolution",
        "runtime-unknown-resolution-result",
        "inbound-message",
        "inbound-result",
        "qr-challenge",
        "maintenance-send-claim",
        "maintenance-inbound-send-claim",
        "maintenance-schedule-send-claim",
        "maintenance-claim",
        "maintenance-completion-result",
        "send-work-completion-request",
        "retention-quarantine-request",
        "retention-delete-authorization-request",
        "retention-delete-finalization-request",
        "audit-anchor-ack-request",
        "maintenance-specialized-result",
        "media-browser-get-ticket",
        "media-runtime-put-ticket",
        "media-runtime-get-ticket",
        "media-maintenance-delete-ticket",
        "media-maintenance-anchor-ticket",
        "media-maintenance-anchor-verify-ticket",
        "media-retention-recovery-ticket",
        "media-audit-recovery-ticket",
        "retention-authorization",
        "retention-recovery-authorization",
        "retention-receipt",
        "audit-anchor-receipt",
        "maintenance-audit-recovery-claim",
        "maintenance-retention-recovery-claim",
        "audit-recovery-completion-request",
        "retention-recovery-completion-request",
        "audit-recovery-refresh-request",
        "retention-recovery-refresh-request",
        "audit-recovery-refresh-result",
        "retention-recovery-refresh-result",
        "policy-allow",
        "rollout-state",
        "rollout-owner-checkpoint",
        "rollout-observation",
        "smoke-cleanup",
        "audit-root",
        "audit-signature-evidence",
      ]),
    );
    expect(new Set(vectors.vectors.map((vector) => vector.schema))).toEqual(
      new Set(contractManifest),
    );

    for (const vector of vectors.vectors) {
      const schema = JSON.parse(
        read(join(contractDirectory, vector.schema)),
      ) as Record<string, unknown>;
      const canonical = canonicalJson(vector.value);
      expect(vector.canonicalJson, vector.name).toBe(canonical);
      expect(schemaValid(vector.value, schema), vector.name).toBe(true);
      expect(vector.domain.at(-1), vector.name).toBe("\u0000");
      expect(vector.domain.slice(0, -1), vector.name).toMatch(
        /^ihome-openclaw-[a-z0-9-]+-v1$/,
      );
      expect(vector.sha256, vector.name).toBe(
        createHash("sha256").update(vector.domain).update(canonical).digest("hex"),
      );
    }
  });

  it("freezes Unicode code points, ordered parts, and every send lineage input", () => {
    const vectors = JSON.parse(
      read(join(contractDirectory, "golden-vectors.json")),
    ) as {
      vectors: Array<{ name: string; domain: string; value: Record<string, unknown> }>;
    };
    const vector = vectors.vectors.find((entry) => entry.name === "canonical-send-unicode");
    expect(vector).toBeDefined();
    const value = structuredClone(vector!.value);
    const parts = value.parts as Array<Record<string, unknown>>;
    expect(parts[0].text).toBe("Xin chào 👋 é");
    expect((parts[0].text as string).normalize("NFC")).not.toBe(parts[0].text);

    const original = createHash("sha256")
      .update(vector!.domain)
      .update(canonicalJson(value))
      .digest("hex");
    const mutations = [
      { ...value, idempotencyKey: "idem-002" },
      { ...value, accountProfile: "sales-secondary" },
      { ...value, replyToProviderMessageId: "reply-001" },
      { ...value, target: { kind: "SALES_GROUP", providerId: "group-001" } },
      { ...value, parts: [...parts].reverse() },
      {
        ...value,
        frozenInputs: {
          ...(value.frozenInputs as Record<string, unknown>),
          subscriptionVersion: 2,
        },
      },
      {
        ...value,
        frozenInputs: {
          ...(value.frozenInputs as Record<string, unknown>),
          occurrenceId: "99999999-9999-4999-8999-999999999999",
        },
      },
      {
        ...value,
        frozenInputs: {
          ...(value.frozenInputs as Record<string, unknown>),
          sourceSnapshotHash: "f".repeat(64),
        },
      },
    ];
    for (const mutation of mutations) {
      expect(
        createHash("sha256")
          .update(vector!.domain)
          .update(canonicalJson(mutation))
          .digest("hex"),
      ).not.toBe(original);
    }
  });

  it("rejects invalid discriminants, receipt pairings, and oversized text", () => {
    const vectors = JSON.parse(
      read(join(contractDirectory, "golden-vectors.json")),
    ) as {
      vectors: Array<{ name: string; schema: string; value: Record<string, unknown> }>;
      negativeVectors?: Array<{ name: string; schema: string; value: unknown }>;
    };
    const schemas = Object.fromEntries(
      contractManifest.map((file) => [
        file,
        JSON.parse(read(join(contractDirectory, file))) as Record<string, unknown>,
      ]),
    );
    const vector = (name: string) => {
      const found = vectors.vectors.find((entry) => entry.name === name);
      expect(found, name).toBeDefined();
      return structuredClone(found!);
    };
    const invalid: Array<{ name: string; schema: string; value: unknown }> = [];
    invalid.push(...(vectors.negativeVectors ?? []));

    const acceptedCounterMismatch = vector("inbound-result");
    acceptedCounterMismatch.value.accepted = 0;
    invalid.push({ ...acceptedCounterMismatch, name: "accepted-counter-with-accepted-result" });

    const duplicateCounterWithoutResult = vector("inbound-result");
    duplicateCounterWithoutResult.value.deduplicated = 1;
    invalid.push({ ...duplicateCounterWithoutResult, name: "duplicate-counter-without-result" });

    const noSendWithWorkItem = vector("inbound-result");
    (noSendWithWorkItem.value.results as Array<Record<string, unknown>>)[0].workItemId =
      "99999999-9999-4999-8999-999999999999";
    invalid.push({ ...noSendWithWorkItem, name: "no-send-with-work-item" });

    const workEligibleWithoutWorkItem = vector("inbound-result");
    Object.assign(
      (workEligibleWithoutWorkItem.value.results as Array<Record<string, unknown>>)[0],
      { decisionKind: "WORK_ELIGIBLE", noSendReason: null, workItemId: null },
    );
    invalid.push({ ...workEligibleWithoutWorkItem, name: "eligible-without-work-item" });

    const manifestStartsAtOne = vector("inbound-result");
    (manifestStartsAtOne.value.results as Array<Record<string, unknown>>)[0].media = [
      { manifestIndex: 1, mediaId: "99999999-9999-4999-8999-999999999991" },
    ];
    invalid.push({ ...manifestStartsAtOne, name: "manifest-index-does-not-match-position" });

    const duplicateManifestIndex = vector("inbound-result");
    (duplicateManifestIndex.value.results as Array<Record<string, unknown>>)[0].media = [
      { manifestIndex: 0, mediaId: "99999999-9999-4999-8999-999999999991" },
      { manifestIndex: 0, mediaId: "99999999-9999-4999-8999-999999999992" },
    ];
    invalid.push({ ...duplicateManifestIndex, name: "duplicate-manifest-index" });

    const completeWithFailureEvidence = vector("send-work-completion-work-failure");
    completeWithFailureEvidence.value.outcome = "COMPLETE";
    completeWithFailureEvidence.value.retryAfterSeconds = null;
    invalid.push({
      ...completeWithFailureEvidence,
      name: "complete-with-work-failure-evidence",
    });

    const retryWithNoSendEvidence = vector("send-work-completion-request");
    retryWithNoSendEvidence.value.outcome = "RETRY";
    retryWithNoSendEvidence.value.retryAfterSeconds = 7;
    invalid.push({ ...retryWithNoSendEvidence, name: "retry-with-no-send-evidence" });

    const oversized = vector("canonical-send-unicode");
    ((oversized.value.parts as Array<Record<string, unknown>>)[0]).text = "x".repeat(2001);
    invalid.push({ ...oversized, name: "text-over-2000-code-points" });

    const wrongPartOrder = vector("canonical-send-unicode");
    ((wrongPartOrder.value.parts as Array<Record<string, unknown>>)[0]).partIndex = 1;
    invalid.push({ ...wrongPartOrder, name: "part-index-does-not-match-array-position" });

    const sentWithUnknownReason = vector("runtime-outbox-completion");
    sentWithUnknownReason.value.reasonCode = "ACK_LOST_AFTER_HANDOFF";
    (sentWithUnknownReason.value.deliveryEvidence as Record<string, unknown>).reasonCode =
      "ACK_LOST_AFTER_HANDOFF";
    invalid.push({ ...sentWithUnknownReason, name: "sent-with-unknown-reason" });

    const failedWithProviderIds = vector("runtime-outbox-completion");
    failedWithProviderIds.value.outcome = "FAILED";
    failedWithProviderIds.value.reasonCode = "PROVIDER_REJECTED_BEFORE_ACCEPT";
    Object.assign(failedWithProviderIds.value.deliveryEvidence as Record<string, unknown>, {
      outcome: "FAILED",
      reasonCode: "PROVIDER_REJECTED_BEFORE_ACCEPT",
      possibleHandoffPrefixLength: 0,
    });
    invalid.push({ ...failedWithProviderIds, name: "failed-with-provider-message-ids" });

    const mismatchedUnknown = vector("runtime-unknown-resolution");
    mismatchedUnknown.value.reasonCode = "OPERATOR_CONFIRMED_SENT";
    invalid.push({ ...mismatchedUnknown, name: "unknown-outcome-reason-mismatch" });

    const missingNewIntent = vector("runtime-unknown-resolution");
    missingNewIntent.value.outcome = "NEW_INTENT_CREATED";
    missingNewIntent.value.reasonCode = "OPERATOR_CREATED_NEW_INTENT";
    invalid.push({ ...missingNewIntent, name: "unknown-new-intent-missing-payload" });

    const extraneousNewIntent = vector("runtime-unknown-resolution");
    extraneousNewIntent.value.newIntent = {
      clientOperationId: "11111111-1111-4111-8111-111111111111",
      targetId: "55555555-5555-4555-8555-555555555555",
      sourceDraftId: "66666666-6666-4666-8666-666666666666",
      expectedDraftVersion: 1,
      replyToMessageId: null,
    };
    invalid.push({ ...extraneousNewIntent, name: "unknown-confirmed-with-new-intent" });

    const incompleteCrm = vector("maintenance-send-claim");
    delete (incompleteCrm.value.payload as Record<string, unknown>).subscriptionId;
    invalid.push({ ...incompleteCrm, name: "crm-work-missing-subscription" });

    const arbitraryDeleteReceipt = vector("retention-delete-finalization-request");
    arbitraryDeleteReceipt.value.gatewayReceipt = { arbitrary: true };
    invalid.push({ ...arbitraryDeleteReceipt, name: "arbitrary-delete-receipt" });

    const deletedWithoutEtag = vector("retention-receipt");
    deletedWithoutEtag.value.r2VersionOrEtag = null;
    invalid.push({ ...deletedWithoutEtag, name: "deleted-without-etag" });

    const missingWithEtag = vector("retention-receipt");
    missingWithEtag.value.objectStatus = "NOT_FOUND";
    invalid.push({ ...missingWithEtag, name: "not-found-with-etag" });

    const wrongSigningDomain = vector("retention-receipt");
    wrongSigningDomain.value = {
      version: 1,
      signingDomain: "ihome-openclaw-audit-receipt-v1\u0000",
      canonicalReceiptHash: "0".repeat(64),
      receipt: wrongSigningDomain.value,
    };
    invalid.push({ ...wrongSigningDomain, name: "receipt-domain-kind-mismatch" });

    for (const candidate of invalid) {
      expect(
        schemaValid(candidate.value, schemas[candidate.schema]),
        candidate.name,
      ).toBe(false);
    }
    expect(schemas["runtime.schema.json"].$defs).toHaveProperty("unknownResolution");
  });

  it("uses the runtime response validator for inbound-result semantics", () => {
    const document = JSON.parse(
      read(join(contractDirectory, "golden-vectors.json")),
    ) as { vectors: Array<{ name: string; value: Record<string, unknown> }> };
    const inbound = structuredClone(
      document.vectors.find((entry) => entry.name === "inbound-result")!.value,
    );
    expect(validateRuntimeResponseBody("/v1/inbound/batch", inbound)).toBe(true);

    const wrongCount = structuredClone(inbound);
    wrongCount.accepted = 2;
    expect(validateRuntimeResponseBody("/v1/inbound/batch", wrongCount)).toBe(false);

    const wrongResultPosition = structuredClone(inbound);
    (wrongResultPosition.results as Array<Record<string, unknown>>)[0].index = 1;
    expect(validateRuntimeResponseBody("/v1/inbound/batch", wrongResultPosition)).toBe(false);

    const wrongManifestPosition = structuredClone(inbound);
    (wrongManifestPosition.results as Array<Record<string, unknown>>)[0].media = [
      { manifestIndex: 1, mediaId: "99999999-9999-4999-8999-999999999991" },
    ];
    expect(validateRuntimeResponseBody("/v1/inbound/batch", wrongManifestPosition)).toBe(false);
  });
});
