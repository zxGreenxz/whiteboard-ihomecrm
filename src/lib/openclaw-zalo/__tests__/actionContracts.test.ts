import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  automationDetailContract,
  automationDryRunContract,
  automationListContract,
  automationMutationContracts,
  deadLetterReplayMutationContract,
  deadLettersByAccountContract,
  directorySyncMutationContract,
  groupAllowlistMutationContract,
  healthEventsByAccountContract,
  knowledgeDetailContract,
  knowledgeListContract,
  knowledgeMutationContracts,
  knowledgePreviewContract,
  legalHoldMutationContracts,
  mediaResolveContract,
  OPENCLAW_ACTION_CONTRACTS,
  qrPollContract,
  salesGroupListContract,
  scheduleListContract,
  scheduleMutationContracts,
  unknownByAccountContract,
  unknownResolutionGetContract,
} from "@/lib/openclaw-zalo/action-contracts";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";
const ID_2 = "44444444-4444-4444-8444-444444444444";
const HASH = "a".repeat(64);
const NOW = "2026-08-02T00:00:00Z";

type Contract = { rpcName: string; requestSchema: z.ZodTypeAny; resultSchema: z.ZodTypeAny };

describe("OpenClaw action contracts", () => {
  it("covers every production read/write action needed by Tasks 23-25", () => {
    expect(OPENCLAW_ACTION_CONTRACTS.map(contract => contract.rpcName)).toEqual([
      "openclaw_list_knowledge_v1",
      "openclaw_get_knowledge_v1",
      "openclaw_preview_knowledge_retrieval_v1",
      "openclaw_list_automations_v1",
      "openclaw_get_automation_v1",
      "openclaw_dry_run_automation_v1",
      "openclaw_list_sales_groups_v1",
      "openclaw_list_schedules_v1",
      "openclaw_poll_qr_login_v1",
      "openclaw_resolve_media_object_v1",
      "openclaw_list_unknown_by_account_v1",
      "openclaw_list_dead_letters_by_account_v1",
      "openclaw_list_health_events_by_account_v1",
      "openclaw_get_unknown_resolution_v1",
      "openclaw_create_knowledge_draft_v1",
      "openclaw_update_knowledge_draft_v1",
      "openclaw_validate_knowledge_v1",
      "openclaw_publish_knowledge_v1",
      "openclaw_archive_knowledge_v1",
      "openclaw_create_automation_draft_v1",
      "openclaw_save_automation_step_v1",
      "openclaw_publish_automation_v1",
      "openclaw_pause_automation_v1",
      "openclaw_upsert_group_allowlist_v1",
      "openclaw_upsert_schedule_v1",
      "openclaw_pause_schedule_v1",
      "openclaw_cancel_schedule_v1",
      "openclaw_request_directory_sync_v1",
      "openclaw_create_legal_hold_v1",
      "openclaw_release_legal_hold_v1",
      "openclaw_replay_dead_letter_v1",
    ]);
  });

  it("rejects extra request fields for every action", () => {
    const cases: Array<{ contract: Contract; request: Record<string, unknown> }> = [
      { contract: knowledgeListContract, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, limit: 50 } },
      { contract: knowledgeDetailContract, request: { version: 1, organizationId: ORG, sourceId: ID } },
      { contract: knowledgePreviewContract, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, query: "lease", limit: 5 } },
      { contract: automationListContract, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, limit: 50 } },
      { contract: automationDetailContract, request: { version: 1, organizationId: ORG, automationId: ID } },
      { contract: automationDryRunContract, request: { version: 1, organizationId: ORG, automationVersionId: ID, sampleInputs: {} } },
      { contract: salesGroupListContract, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, limit: 50 } },
      { contract: scheduleListContract, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, limit: 50 } },
      { contract: qrPollContract, request: { version: 1, organizationId: ORG, challengeId: ID, browserNonceHash: HASH, authSessionHash: HASH } },
      { contract: mediaResolveContract, request: { version: 1, organizationId: ORG, mediaId: ID } },
      { contract: unknownByAccountContract, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, limit: 50 } },
      { contract: deadLettersByAccountContract, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, limit: 50 } },
      { contract: healthEventsByAccountContract, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, limit: 50 } },
      { contract: unknownResolutionGetContract, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, outboxId: ID } },
      { contract: knowledgeMutationContracts.create, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, title: "FAQ", sourceKind: "FAQ", sensitivity: "CUSTOMER_SAFE", content: "content" } },
      { contract: knowledgeMutationContracts.update, request: { version: 1, organizationId: ORG, sourceId: ID, expectedSourceVersion: 1, content: "content" } },
      { contract: knowledgeMutationContracts.validate, request: { version: 1, organizationId: ORG, sourceId: ID, knowledgeVersionId: ID_2 } },
      { contract: knowledgeMutationContracts.publish, request: { version: 1, organizationId: ORG, sourceId: ID, knowledgeVersionId: ID_2 } },
      { contract: knowledgeMutationContracts.archive, request: { version: 1, organizationId: ORG, sourceId: ID, knowledgeVersionId: ID_2 } },
      { contract: automationMutationContracts.create, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, name: "Inbound", automationKind: "INBOUND_REPLY", mode: "DRAFT_ONLY", templateBody: "Hello", policyVersionId: ID, knowledgeVersionIds: [], configuration: {} } },
      { contract: automationMutationContracts.saveStep, request: { version: 1, organizationId: ORG, automationId: ID, expectedAutomationVersion: 1, configurationPatch: {} } },
      { contract: automationMutationContracts.publish, request: { version: 1, organizationId: ORG, automationId: ID, expectedAutomationVersion: 1 } },
      { contract: automationMutationContracts.pause, request: { version: 1, organizationId: ORG, automationId: ID, expectedAutomationVersion: 1 } },
      { contract: groupAllowlistMutationContract, request: { version: 1, organizationId: ORG, targetId: ID, expectedAllowlistVersion: 0, isAllowed: true, evidenceHash: HASH } },
      { contract: scheduleMutationContracts.upsert, request: { version: 1, organizationId: ORG, accountId: ACCOUNT, automationVersionId: ID, targetId: ID_2, campaignVersionId: null, timezone: "Asia/Bangkok", localRecurrenceRule: "FREQ=DAILY" } },
      { contract: scheduleMutationContracts.pause, request: { version: 1, organizationId: ORG, scheduleId: ID, expectedScheduleVersion: 1 } },
      { contract: scheduleMutationContracts.cancel, request: { version: 1, organizationId: ORG, scheduleId: ID, expectedScheduleVersion: 1 } },
      { contract: directorySyncMutationContract, request: { version: 1, organizationId: ORG, accountId: ACCOUNT } },
      { contract: legalHoldMutationContracts.create, request: { version: 1, organizationId: ORG, targetKind: "MEDIA", targetId: ID, reason: "case", expiresAt: null } },
      { contract: legalHoldMutationContracts.release, request: { version: 1, organizationId: ORG, holdId: ID, expectedHoldVersion: 1, releaseReason: "closed" } },
      { contract: deadLetterReplayMutationContract, request: { version: 1, organizationId: ORG, deadLetterId: ID } },
    ];

    for (const { contract, request } of cases) {
      expect(contract.requestSchema.parse(request)).toEqual(request);
      expect(() => contract.requestSchema.parse({ ...request, unexpected: true }), contract.rpcName).toThrow();
    }
    expect(() => unknownByAccountContract.requestSchema.parse({
      version: 1,
      organizationId: ORG,
      accountId: ACCOUNT,
      cursorTerminalAt: NOW,
    })).toThrow(/cursor fields/i);
  });

  it("strictly validates representative responses for every read surface", () => {
    const cases: Array<{ contract: Contract; result: Record<string, unknown> }> = [
      { contract: knowledgeListContract, result: { version: 1, limit: 1, items: [{ sourceId: ID, accountId: ACCOUNT, title: "FAQ", sourceKind: "FAQ", sensitivity: "CUSTOMER_SAFE", lifecycleState: "PUBLISHED", currentVersion: 1, createdAt: NOW, updatedAt: NOW }] } },
      { contract: knowledgeDetailContract, result: { version: 1, knowledge: null } },
      { contract: knowledgePreviewContract, result: { version: 1, limit: 1, items: [{ chunkId: ID, sourceId: ID_2, knowledgeVersionId: ACCOUNT, chunkIndex: 0, chunkText: "answer", chunkHash: HASH }] } },
      { contract: automationListContract, result: { version: 1, limit: 1, items: [{ automationId: ID, name: "Inbound", automationKind: "INBOUND_REPLY", lifecycleState: "DRAFT", currentVersion: 1, updatedAt: NOW }] } },
      { contract: automationDetailContract, result: { version: 1, automation: null } },
      { contract: automationDryRunContract, result: { version: 1, eligible: true, dryRunHash: HASH, sendCreated: false, reason: "DRY_RUN_ONLY" } },
      { contract: salesGroupListContract, result: { version: 1, limit: 1, items: [{ targetId: ID, groupId: ID_2, displayName: "Sales", memberCount: 3, directoryVersion: 1, directoryRefreshedAt: NOW, targetVersion: 1, isActive: true, isAllowed: null, allowlistVersion: null, directoryExpiresAt: null }] } },
      { contract: scheduleListContract, result: { version: 1, limit: 1, items: [{ scheduleId: ID, automationVersionId: ID_2, targetId: null, campaignId: null, scheduleVersion: 1, status: "PAUSED", timezone: "Asia/Bangkok", localRecurrenceRule: "FREQ=DAILY", nextRunAt: null, missedOccurrencePolicy: "SKIPPED_MISSED", updatedAt: NOW }] } },
      { contract: qrPollContract, result: { version: 1, challenge: null } },
      { contract: mediaResolveContract, result: { version: 1, mediaId: ID, organizationId: ORG, accountId: ACCOUNT, conversationId: ID_2, messageId: ID, mime: "image/png", byteLength: 10, sha256: HASH, objectKey: "media/key", byteState: "AVAILABLE", sessionGeneration: 1 } },
      { contract: unknownByAccountContract, result: { version: 1, limit: 1, items: [] } },
      { contract: deadLettersByAccountContract, result: { version: 1, limit: 1, items: [] } },
      { contract: healthEventsByAccountContract, result: { version: 1, limit: 1, items: [] } },
      { contract: unknownResolutionGetContract, result: { version: 1, resolutionId: ID, organizationId: ORG, accountId: ACCOUNT, outboxId: ID_2, resolutionVersion: 1, outcome: "CONFIRMED_FAILED", newOutboxId: null, authoritativeEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0", authoritativeEvidenceHash: HASH, reasonCode: "OPERATOR_CONFIRMED_FAILED", resolvedBy: ACCOUNT, resolvedAt: NOW } },
    ];

    for (const { contract, result } of cases) {
      expect(contract.resultSchema.parse(result)).toEqual(result);
      expect(() => contract.resultSchema.parse({ ...result, unexpected: true }), contract.rpcName).toThrow();
    }
  });
});
