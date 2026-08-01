import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validateRuntimeRequestBody } from "../../supabase/functions/openclaw-runtime/contracts";

const generatorPath = resolve("scripts/generate-openclaw-golden-vectors.mjs");
const vectorsPath = resolve("contracts/openclaw-zalo/golden-vectors.json");

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function domainHash(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalHash(value) {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function textDomainHash(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function generate(generator, output) {
  execFileSync(process.execPath, [generator], { stdio: "pipe" });
  return readFileSync(output, "utf8");
}

describe("OpenClaw Task 15/16 golden-vector generator", () => {
  it("derives embedded evidence and receipt hashes from their canonical domains", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "openclaw-golden-vectors-"));
    const temporaryGenerator = join(
      temporaryRoot,
      "scripts",
      "generate-openclaw-golden-vectors.mjs",
    );
    const temporaryOutput = join(
      temporaryRoot,
      "contracts",
      "openclaw-zalo",
      "golden-vectors.json",
    );

    mkdirSync(join(temporaryRoot, "scripts"), { recursive: true });
    mkdirSync(join(temporaryRoot, "contracts", "openclaw-zalo"), { recursive: true });
    copyFileSync(generatorPath, temporaryGenerator);

    let second;
    const checkedIn = readFileSync(vectorsPath, "utf8");
    try {
      const first = generate(temporaryGenerator, temporaryOutput);
      second = generate(temporaryGenerator, temporaryOutput);
      expect(second).toBe(first);
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }

    const document = JSON.parse(second);
    const vector = (name) => {
      const match = document.vectors.find((candidate) => candidate.name === name);
      expect(match, name).toBeDefined();
      return match;
    };

    const completion = vector("runtime-outbox-completion");
    expect(completion.value.deliveryEvidenceHash).toBe(domainHash(
      "ihome-openclaw-delivery-evidence-v1\0",
      completion.value.deliveryEvidence,
    ));

    const requeue = vector("runtime-pre-handoff-requeue");
    expect(requeue.value.preHandoffEvidenceHash).toBe(domainHash(
      "ihome-openclaw-pre-handoff-evidence-v1\0",
      requeue.value.preHandoffEvidence,
    ));

    const workCompletions = [
      vector("send-work-completion-request"),
      vector("send-work-completion-human-draft"),
      vector("send-work-completion-work-failure"),
    ];
    for (const workCompletion of workCompletions) {
      expect(validateRuntimeRequestBody(
        "/v1/work/complete",
        workCompletion.value,
      ), workCompletion.name).toBe(true);
      expect(workCompletion.value.evidenceHash).toBe(domainHash(
        "ihome-openclaw-send-work-completion-v1\0",
        workCompletion.value.evidence,
      ));
    }
    expect(workCompletions[0].value.evidence).toEqual({
      version: 1,
      evidenceKind: "NO_SEND",
      reasonCode: "TAKEOVER_ACTIVE",
    });
    expect(workCompletions[1].value.evidence).toEqual({
      version: 1,
      evidenceKind: "HUMAN_DRAFT",
      reasonCode: "DLP_BLOCKED",
      classification: "TENANT_SUPPORT",
      confidenceBasisPoints: 7500,
      findings: ["EMAIL"],
      draftText: "Lien he [REDACTED_EMAIL].",
      draftHash: textDomainHash(
        "ihome-openclaw-human-draft-v1\0",
        "Lien he [REDACTED_EMAIL].",
      ),
    });
    expect(workCompletions[2].value).toMatchObject({
      outcome: "RETRY",
      retryAfterSeconds: 7,
      evidence: {
        version: 1,
        evidenceKind: "WORK_FAILURE",
        reasonCode: "UPSTREAM_TIMEOUT",
        failureFingerprint: "0123456789abcdef".repeat(4),
      },
    });
    expect(vector("maintenance-completion-result").value.canonicalEvidenceHash)
      .toBe(workCompletions[0].value.evidenceHash);

    const retentionReceipt = vector("retention-receipt");
    expect(retentionReceipt.domain).toBe("ihome-openclaw-retention-receipt-v1\0");
    expect(vector("maintenance-specialized-result").value.receiptHash).toBe(
      domainHash("ihome-openclaw-retention-receipt-v1\0", retentionReceipt.value),
    );

    const auditReceipt = vector("audit-anchor-receipt");
    expect(auditReceipt.domain).toBe("ihome-openclaw-audit-receipt-v1\0");
    expect(auditReceipt.value.receiptId).not.toBe(
      auditReceipt.value.verifyTicketJti,
    );

    const mediaReceipt = vector("media-upload-receipt");
    expect(mediaReceipt.domain).toBe("ihome-openclaw-media-upload-receipt-v1\0");
    expect(mediaReceipt.value).toHaveProperty("storedAt", "2026-07-31T00:00:10.000Z");
    expect(mediaReceipt.value).not.toHaveProperty("completedAt");
    expect(mediaReceipt.value.receiptId).not.toBe(
      mediaReceipt.value.uploadTicketJti,
    );
    expect(mediaReceipt.value.objectKey).toMatch(
      /\/conversation\/[0-9a-f-]+\/message\/[0-9a-f-]+\/media\//,
    );

    const inboundMessage = vector("inbound-message").value;
    const inboundEvent = inboundMessage.events[0];
    expect(inboundEvent).toEqual({
      version: 1,
      eventKind: "MESSAGE",
      providerEventId: "evt-001",
      providerMessageId: "msg-001",
      providerConversationId: "conversation-zalo-001",
      providerSenderId: "zalo-peer-001",
      providerTarget: { kind: "PEER", providerId: "zalo-peer-001" },
      providerEventType: "message.text",
      sourceTimestamp: "2026-07-31T00:00:00.000Z",
      callbackReceivedAt: "2026-07-31T00:00:01.000Z",
      rawEnvelope: { event: "message.text", text: "xin chao" },
      rawEnvelopeSha256: expect.any(String),
      normalized: {
        text: "xin chao",
        replyToProviderMessageId: null,
        mediaManifest: [],
      },
      normalizedSha256: expect.any(String),
    });
    expect(inboundEvent.rawEnvelopeSha256).toBe(
      canonicalHash(inboundEvent.rawEnvelope),
    );
    expect(inboundEvent.normalizedSha256).toBe(
      canonicalHash(inboundEvent.normalized),
    );

    const inboundMediaEvent = vector("inbound-message-media").value.events[0];
    expect(inboundMediaEvent.normalized.mediaManifest).toHaveLength(2);
    expect(inboundMediaEvent.normalized.mediaManifest.map((entry) => entry.index))
      .toEqual([0, 1]);
    expect(inboundMediaEvent.rawEnvelopeSha256).toBe(
      canonicalHash(inboundMediaEvent.rawEnvelope),
    );
    expect(inboundMediaEvent.normalizedSha256).toBe(
      canonicalHash(inboundMediaEvent.normalized),
    );
    expect(retentionReceipt.value.deleteAuthorizationJti).toBe(
      retentionReceipt.value.proofJti,
    );

    const inboundResult = vector("inbound-result").value;
    expect(inboundResult).toMatchObject({
      requestId: expect.any(String),
      accepted: 1,
      deduplicated: 0,
      quarantined: 0,
    });
    expect(inboundResult.results[0]).toEqual({
      index: 0,
      status: "ACCEPTED",
      inboundEventId: expect.any(String),
      messageId: expect.any(String),
      decisionId: expect.any(String),
      decisionKind: "NO_SEND",
      noSendReason: "NO_AUTOMATION_MATCH",
      workItemId: null,
      media: [],
    });

    const auditAck = vector("audit-anchor-ack-request").value;
    expect(auditAck.verifyTicketJti).toBe(auditAck.gatewayReceipt.verifyTicketJti);
    expect(auditAck.verifyTicketJti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(auditAck.gatewayReceipt.verifyTicketJti).toMatch(/^[A-Za-z0-9_-]{16,128}$/);

    const retentionFinalization = vector("retention-delete-finalization-request").value;
    expect(retentionFinalization.ticketId).not.toBe(
      retentionFinalization.gatewayReceipt.receiptId,
    );

    for (const entry of document.vectors) {
      expect(entry.sha256, entry.name).toBe(domainHash(entry.domain, entry.value));
    }
    expect(document.negativeVectors.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "inbound-media-manifest-index-starts-at-one",
        "inbound-media-manifest-index-duplicated",
        "inbound-media-manifest-index-out-of-range",
        "inbound-media-empty-provider-media-id",
        "inbound-media-empty-fetch-ref",
        "inbound-media-empty-provider-event-id",
        "inbound-media-empty-provider-message-id",
        "inbound-media-empty-reply-to-provider-message-id",
      ]),
    );
    expect(second).toBe(checkedIn);
  });
});
