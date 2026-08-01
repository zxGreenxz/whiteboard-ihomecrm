import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  validateRuntimeRequestBody,
  validateRuntimeResponseBody,
} from "../../../supabase/functions/openclaw-runtime/contracts";

function schema(name: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve("contracts/openclaw-zalo", name), "utf8"));
}

function golden(name: string): Record<string, any> {
  const vectors = schema("golden-vectors.json").vectors as Record<string, any>[];
  const match = vectors.find((entry) => entry.name === name);
  if (!match) throw new Error(`missing golden vector ${name}`);
  return match.value;
}

describe("Task 14-18 canonical external contracts", () => {
  it("uses only the complete fork-to-bridge inbound envelope", () => {
    const inbound = schema("inbound.schema.json");
    expect(inbound.$defs.inboundBatch.required).toEqual([
      "version",
      "organizationId",
      "accountId",
      "cellId",
      "sessionGeneration",
      "events",
    ]);
    expect(inbound.$defs.providerEvent.required).toEqual([
      "version",
      "eventKind",
      "providerEventId",
      "providerMessageId",
      "providerConversationId",
      "providerSenderId",
      "providerTarget",
      "providerEventType",
      "sourceTimestamp",
      "callbackReceivedAt",
      "rawEnvelope",
      "rawEnvelopeSha256",
      "normalized",
      "normalizedSha256",
    ]);
    expect(Object.keys(inbound.$defs.providerEvent.properties)).not.toContain("payload");
    expect(Object.keys(inbound.$defs.providerEvent.properties)).not.toContain("payloadHash");
    expect(inbound.$defs.providerEvent.additionalProperties).toBe(false);
  });

  it("makes every Task 15 runtime parser accept the checked external golden contract", () => {
    expect(validateRuntimeRequestBody(
      "/v1/outbox/complete",
      golden("runtime-outbox-completion"),
    )).toBe(true);
    expect(validateRuntimeRequestBody(
      "/v1/outbox/requeue",
      golden("runtime-pre-handoff-requeue"),
    )).toBe(true);
    for (const name of [
      "send-work-completion-request",
      "send-work-completion-human-draft",
      "send-work-completion-work-failure",
    ]) {
      expect(validateRuntimeRequestBody(
        "/v1/work/complete",
        golden(name),
      ), name).toBe(true);
    }
    for (const name of [
      "retention-quarantine-request",
      "retention-delete-finalization-request",
      "audit-anchor-ack-request",
    ]) {
      expect(validateRuntimeRequestBody(
        "/v1/maintenance/work/complete",
        golden(name),
      ), name).toBe(true);
    }
    expect(validateRuntimeRequestBody(
      "/v1/maintenance/retention/delete-ticket",
      golden("retention-delete-authorization-request"),
    )).toBe(true);

    expect(validateRuntimeResponseBody(
      "/v1/outbox/claim",
      { version: 1, items: [golden("runtime-outbox-claim")] },
    )).toBe(true);
    expect(validateRuntimeResponseBody(
      "/v1/inbound/batch",
      golden("inbound-result"),
    )).toBe(true);
    for (const name of [
      "maintenance-inbound-send-claim",
      "maintenance-schedule-send-claim",
      "maintenance-send-claim",
    ]) {
      expect(validateRuntimeResponseBody(
        "/v1/work/claim",
        { version: 1, items: [golden(name)] },
      ), name).toBe(true);
    }
    expect(validateRuntimeResponseBody(
      "/v1/maintenance/work/claim",
      {
        version: 1,
        items: [golden("maintenance-claim")],
        unresolvedFailures: { retentionDelete: 0, auditAnchor: 0 },
      },
    )).toBe(true);
    expect(validateRuntimeResponseBody(
      "/v1/work/complete",
      golden("maintenance-completion-result"),
    )).toBe(true);
    expect(validateRuntimeResponseBody(
      "/v1/maintenance/work/complete",
      golden("maintenance-specialized-result"),
    )).toBe(true);
  });
});
