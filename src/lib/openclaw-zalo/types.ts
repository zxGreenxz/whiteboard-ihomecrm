export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type OpenClawPermissionAction =
  | "view"
  | "send"
  | "manage_connections"
  | "manage_automation"
  | "manage_knowledge"
  | "manage_handoff"
  | "manage_operations"
  | "audit";

export type OpenClawTargetKind = "PEER" | "SALES_GROUP";
export type OpenClawOutboxState =
  | "QUEUED"
  | "LEASED"
  | "DISPATCHING"
  | "SENT"
  | "FAILED"
  | "UNKNOWN"
  | "DEAD_LETTER";
export type OpenClawMode =
  | "DRAFT_ONLY"
  | "MANUAL_SEND"
  | "LIMITED_AUTO_REPLY"
  | "PROACTIVE"
  | "SALES_GROUPS";
export type OpenClawConnectionState =
  | "DISCONNECTED"
  | "QR_PENDING"
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTING"
  | "RECONNECT_REQUIRED";
export type OpenClawSessionRiskState =
  | "HEALTHY"
  | "DEGRADED"
  | "LIMITED"
  | "SUSPECTED_THEFT"
  | "INVALID";
export type KnowledgeSensitivity = "CUSTOMER_SAFE" | "INTERNAL_REVIEW_ONLY" | "RESTRICTED";

export interface OpenClawOrganization {
  organizationId: string;
  name: string;
}

export interface OpenClawAccountSummary {
  accountId: string;
  displayName: string;
  connectionState: OpenClawConnectionState;
  sessionRiskState: OpenClawSessionRiskState;
  configuredMode: OpenClawMode;
  effectiveMode: OpenClawMode;
  connectionGeneration: number;
  sessionGeneration: number;
  disclosureVersion: number;
  /** Null until the operator has acknowledged any version at all. */
  disclosureAcknowledgedVersion: number | null;
  /** Null while the account has no current runtime cell. */
  currentCellId: string | null;
}

export interface OpenClawControlState {
  globalStop: boolean;
  featureEnabled: boolean;
  limitedAutoReplyEnabled: boolean;
  proactiveEnabled: boolean;
  salesGroupsEnabled: boolean;
  controlVersion: number;
}

export interface OpenClawBootstrap {
  version: 1;
  organizationId: string;
  account: OpenClawAccountSummary | null;
  control: OpenClawControlState | null;
  actorId: string;
  /** ACTIVE OWNER membership: legal holds require it in addition to permissions. */
  isActiveOwner: boolean;
}

export interface OpenClawOverview {
  version: 1;
  organizationId: string;
  conversationCount: number;
  unreadCount: number;
  unresolvedUnknownCount: number;
  resolvedUnknownCount: number;
  deadLetterCount: number;
}

export interface OpenClawCursor {
  receivedAt: string;
  id: string;
}

export interface OpenClawConversation {
  conversationId: string;
  targetId: string;
  status: string;
  assignedMembershipId: string | null;
  unreadCount: number;
  lastReceivedAt: string;
  lastMessageId: string | null;
  version: number;
}

export interface OpenClawMessage {
  messageId: string;
  direction: "INBOUND" | "OUTBOUND";
  eventKind: string;
  providerTimestamp: string | null;
  receivedAt: string;
  createdAt: string;
}

export interface OpenClawPage<T> {
  version: 1;
  items: T[];
  limit: number;
}

export type OpenClawUnknownResolutionOutcome =
  | "CONFIRMED_SENT"
  | "CONFIRMED_FAILED"
  | "NEW_INTENT_CREATED";

export interface OpenClawUnknownResolution {
  version: 1;
  resolutionId: string;
  organizationId: string;
  accountId: string;
  outboxId: string;
  resolutionVersion: 1;
  outcome: OpenClawUnknownResolutionOutcome;
  newOutboxId: string | null;
  authoritativeEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0";
  authoritativeEvidenceHash: string;
  reasonCode:
    | "OPERATOR_CONFIRMED_SENT"
    | "OPERATOR_CONFIRMED_FAILED"
    | "OPERATOR_CREATED_NEW_INTENT";
  resolvedBy: string;
  resolvedAt: string;
}

export interface OpenClawUnknownItem {
  outboxId: string;
  accountId: string;
  payloadHash: string;
  terminalAt: string;
  historicalState: "UNKNOWN";
  resolutionVersion: 0 | 1;
  resolution: OpenClawUnknownResolutionSummary | null;
}

export interface OpenClawUnknownResolutionSummary {
  resolutionId: string;
  outcome: OpenClawUnknownResolutionOutcome;
  newOutboxId: string | null;
  authoritativeEvidenceHash: string;
  resolvedAt: string;
}

export interface OpenClawDeadLetter {
  deadLetterId: string;
  accountId: string;
  outboxId: string | null;
  sendWorkItemId: string | null;
  reasonCode: string;
  payloadHash: string;
  createdAt: string;
}

export interface OpenClawHealthEvent {
  healthEventId: string;
  accountId: string | null;
  cellId: string | null;
  severity: string;
  healthKind: string;
  status: string;
  fingerprint: string;
  contentFreeMetrics: Record<string, JsonValue>;
  observedAt: string;
  createdAt: string;
}

export interface OpenClawAuditEvent {
  auditEventId: string;
  organizationSequence: number;
  eventType: string;
  actorId: string | null;
  workloadPrincipal: string | null;
  requestId: string | null;
  correlationId: string | null;
  evidenceHash: string;
  previousHash: string | null;
  eventHash: string;
  occurredAt: string;
}

export interface OpenClawLegalHold {
  holdId: string;
  targetKind: string;
  targetId: string;
  reason: string;
  holdVersion: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
}

export interface OpenClawUnknownNewIntent {
  clientOperationId: string;
  targetId: string;
  sourceDraftId: string;
  expectedDraftVersion: number;
  replyToMessageId: string | null;
}

export type OpenClawUnknownResolutionRequest =
  | {
      version: 1;
      organizationId: string;
      outboxId: string;
      expectedResolutionVersion: 0;
      expectedEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0";
      expectedEvidenceHash: string;
      outcome: "CONFIRMED_SENT";
      reasonCode: "OPERATOR_CONFIRMED_SENT";
      operatorEvidenceHash: string;
      newIntent?: null;
    }
  | {
      version: 1;
      organizationId: string;
      outboxId: string;
      expectedResolutionVersion: 0;
      expectedEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0";
      expectedEvidenceHash: string;
      outcome: "CONFIRMED_FAILED";
      reasonCode: "OPERATOR_CONFIRMED_FAILED";
      operatorEvidenceHash: string;
      newIntent?: null;
    }
  | {
      version: 1;
      organizationId: string;
      outboxId: string;
      expectedResolutionVersion: 0;
      expectedEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0";
      expectedEvidenceHash: string;
      outcome: "NEW_INTENT_CREATED";
      reasonCode: "OPERATOR_CREATED_NEW_INTENT";
      operatorEvidenceHash: string;
      newIntent: OpenClawUnknownNewIntent;
    };

export type SendDecisionReason =
  | "GLOBAL_STOP"
  | "MODE_PAUSED"
  | "ACCOUNT_PAUSED"
  | "CAMPAIGN_CANCELLED"
  | "TAKEOVER_ACTIVE"
  | "SUPPRESSED"
  | "CONSENT_MISSING"
  | "QUIET_HOURS"
  | "RATE_LIMITED"
  | "GROUP_NOT_ALLOWLISTED"
  | "GROUP_DIRECTORY_STALE"
  | "ALLOWED";

export interface OpenClawSendPolicyInput {
  [key: string]: boolean | undefined;
  GLOBAL_STOP?: boolean;
  MODE_PAUSED?: boolean;
  ACCOUNT_PAUSED?: boolean;
  CAMPAIGN_CANCELLED?: boolean;
  TAKEOVER_ACTIVE?: boolean;
  SUPPRESSED?: boolean;
  CONSENT_MISSING?: boolean;
  QUIET_HOURS?: boolean;
  RATE_LIMITED?: boolean;
  GROUP_NOT_ALLOWLISTED?: boolean;
  GROUP_DIRECTORY_STALE?: boolean;
}

export interface OpenClawSendDecision {
  allowed: boolean;
  reason: SendDecisionReason;
}

export interface OpenClawRealtimeEvent {
  id: string;
  organizationId: string;
  accountId: string;
  resource: string;
  occurredAt: string;
  sequence?: number;
}

export interface OpenClawMutationResult {
  version: 1;
  organizationId: string;
  [key: string]: JsonValue;
}

export interface OpenClawQueryScope {
  organizationId: string;
  accountId: string;
}

export interface OpenClawQueryPageRequest extends OpenClawQueryScope {
  version: 1;
  limit?: number;
  cursorLastReceivedAt?: string | null;
  cursorId?: string | null;
  cursorReceivedAt?: string | null;
  conversationId?: string;
}

export interface OpenClawPermissionSnapshot {
  organizationId: string;
  actions: Record<OpenClawPermissionAction, boolean>;
}

export type OpenClawRpcName =
  | "openclaw_list_my_organizations_v1"
  | "openclaw_get_bootstrap_v1"
  | "openclaw_get_overview_v1"
  | "openclaw_list_conversations_v1"
  | "openclaw_list_messages_v1"
  | "openclaw_resolve_media_object_v1"
  | "openclaw_list_unknown_v1"
  | "openclaw_list_unknown_by_account_v1"
  | "openclaw_get_unknown_resolution_v1"
  | "openclaw_get_unknown_authority_v1"
  | "openclaw_list_knowledge_v1"
  | "openclaw_get_knowledge_v1"
  | "openclaw_preview_knowledge_retrieval_v1"
  | "openclaw_list_automations_v1"
  | "openclaw_get_automation_v1"
  | "openclaw_dry_run_automation_v1"
  | "openclaw_list_sales_groups_v1"
  | "openclaw_list_schedules_v1"
  | "openclaw_list_dead_letters_v1"
  | "openclaw_list_dead_letters_by_account_v1"
  | "openclaw_list_audit_events_v1"
  | "openclaw_list_health_events_v1"
  | "openclaw_list_health_events_by_account_v1"
  | "openclaw_list_legal_holds_v1"
  | "openclaw_poll_qr_login_v1"
  | "openclaw_acknowledge_risk_v1"
  | "openclaw_begin_qr_login_v1"
  | "openclaw_consume_qr_challenge_v1"
  | "openclaw_disconnect_account_v1"
  | "openclaw_create_send_intent_v1"
  | "openclaw_takeover_conversation_v1"
  | "openclaw_release_takeover_v1"
  | "openclaw_assign_conversation_v1"
  | "openclaw_mark_conversation_read_v1"
  | "openclaw_create_knowledge_draft_v1"
  | "openclaw_update_knowledge_draft_v1"
  | "openclaw_validate_knowledge_v1"
  | "openclaw_publish_knowledge_v1"
  | "openclaw_archive_knowledge_v1"
  | "openclaw_create_automation_draft_v1"
  | "openclaw_save_automation_step_v1"
  | "openclaw_publish_automation_v1"
  | "openclaw_pause_automation_v1"
  | "openclaw_upsert_group_allowlist_v1"
  | "openclaw_upsert_schedule_v1"
  | "openclaw_pause_schedule_v1"
  | "openclaw_cancel_schedule_v1"
  | "openclaw_request_directory_sync_v1"
  | "openclaw_set_control_state_v1"
  | "openclaw_create_legal_hold_v1"
  | "openclaw_release_legal_hold_v1"
  | "openclaw_replay_dead_letter_v1"
  | "openclaw_resolve_unknown_v1";
