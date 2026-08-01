const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Every browser control write maps to exactly one public RPC facade. There is no
 * generic SQL, admin, or pass-through path, so an attacker cannot name an
 * arbitrary routine through this endpoint.
 */
export const CONTROL_OPERATION_RPCS = Object.freeze({
  ACKNOWLEDGE_RISK: "openclaw_acknowledge_risk_v1",
  ACKNOWLEDGE_DISCLOSURE: "openclaw_acknowledge_disclosure_v1",
  DISCONNECT_ACCOUNT: "openclaw_disconnect_account_v1",
  CREATE_SEND_INTENT: "openclaw_create_send_intent_v1",
  TAKEOVER_CONVERSATION: "openclaw_takeover_conversation_v1",
  RELEASE_TAKEOVER: "openclaw_release_takeover_v1",
  ASSIGN_CONVERSATION: "openclaw_assign_conversation_v1",
  MARK_CONVERSATION_READ: "openclaw_mark_conversation_read_v1",
  RESOLVE_UNKNOWN: "openclaw_resolve_unknown_v1",
  SET_CONTROL_STATE: "openclaw_set_control_state_v1",
  CREATE_KNOWLEDGE_DRAFT: "openclaw_create_knowledge_draft_v1",
  UPDATE_KNOWLEDGE_DRAFT: "openclaw_update_knowledge_draft_v1",
  VALIDATE_KNOWLEDGE: "openclaw_validate_knowledge_v1",
  PUBLISH_KNOWLEDGE: "openclaw_publish_knowledge_v1",
  ARCHIVE_KNOWLEDGE: "openclaw_archive_knowledge_v1",
  CREATE_AUTOMATION_DRAFT: "openclaw_create_automation_draft_v1",
  SAVE_AUTOMATION_STEP: "openclaw_save_automation_step_v1",
  PUBLISH_AUTOMATION: "openclaw_publish_automation_v1",
  PAUSE_AUTOMATION: "openclaw_pause_automation_v1",
  UPSERT_GROUP_ALLOWLIST: "openclaw_upsert_group_allowlist_v1",
  UPSERT_SCHEDULE: "openclaw_upsert_schedule_v1",
  PAUSE_SCHEDULE: "openclaw_pause_schedule_v1",
  CANCEL_SCHEDULE: "openclaw_cancel_schedule_v1",
  REQUEST_DIRECTORY_SYNC: "openclaw_request_directory_sync_v1",
  CREATE_LEGAL_HOLD: "openclaw_create_legal_hold_v1",
  RELEASE_LEGAL_HOLD: "openclaw_release_legal_hold_v1",
  REPLAY_DEAD_LETTER: "openclaw_replay_dead_letter_v1",
} as const);

/** Reads take no client operation id and never mutate state. */
export const CONTROL_READ_OPERATION_RPCS = Object.freeze({
  GET_BOOTSTRAP: "openclaw_get_bootstrap_v1",
  GET_OVERVIEW: "openclaw_get_overview_v1",
  LIST_CONVERSATIONS: "openclaw_list_conversations_v1",
  LIST_MESSAGES: "openclaw_list_messages_v1",
  LIST_UNKNOWN: "openclaw_list_unknown_v1",
  LIST_KNOWLEDGE: "openclaw_list_knowledge_v1",
  GET_KNOWLEDGE: "openclaw_get_knowledge_v1",
  PREVIEW_KNOWLEDGE_RETRIEVAL: "openclaw_preview_knowledge_retrieval_v1",
  LIST_AUTOMATIONS: "openclaw_list_automations_v1",
  GET_AUTOMATION: "openclaw_get_automation_v1",
  DRY_RUN_AUTOMATION: "openclaw_dry_run_automation_v1",
  LIST_SALES_GROUPS: "openclaw_list_sales_groups_v1",
  LIST_SCHEDULES: "openclaw_list_schedules_v1",
  LIST_DEAD_LETTERS: "openclaw_list_dead_letters_v1",
  LIST_AUDIT_EVENTS: "openclaw_list_audit_events_v1",
  LIST_HEALTH_EVENTS: "openclaw_list_health_events_v1",
  LIST_LEGAL_HOLDS: "openclaw_list_legal_holds_v1",
} as const);

export type ControlWriteOperation = keyof typeof CONTROL_OPERATION_RPCS;
export type ControlReadOperation = keyof typeof CONTROL_READ_OPERATION_RPCS;

export interface ControlWriteRequest {
  version: 1;
  operation: ControlWriteOperation;
  clientOperationId: string;
  payload: Record<string, unknown>;
}

export interface ControlReadRequest {
  version: 1;
  operation: ControlReadOperation;
  payload: Record<string, unknown>;
}

export type ControlRequest = ControlWriteRequest | ControlReadRequest;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
}

function validDisclosureAcknowledgementPayload(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, [
    "version", "organizationId", "accountId", "disclosureVersion",
  ]) && value.version === 1 &&
    typeof value.organizationId === "string" && UUID_PATTERN.test(value.organizationId) &&
    typeof value.accountId === "string" && UUID_PATTERN.test(value.accountId) &&
    Number.isSafeInteger(value.disclosureVersion) && Number(value.disclosureVersion) >= 1;
}

/**
 * Mirrors the `safeParse` shape `readStrictJson` expects without pulling a
 * bundler-hostile `npm:` specifier into the shared Edge modules.
 */
export const controlRequestSchema = {
  safeParse(
    value: unknown,
  ): { success: true; data: ControlRequest } | { success: false; error: string } {
    if (!isPlainObject(value)) return { success: false, error: "request must be an object" };
    if (value.version !== 1) return { success: false, error: "version must be 1" };
    if (typeof value.operation !== "string") {
      return { success: false, error: "operation must be a string" };
    }
    if (!isPlainObject(value.payload)) {
      return { success: false, error: "payload must be an object" };
    }

    const isWrite = Object.prototype.hasOwnProperty.call(
      CONTROL_OPERATION_RPCS,
      value.operation,
    );
    const isRead = Object.prototype.hasOwnProperty.call(
      CONTROL_READ_OPERATION_RPCS,
      value.operation,
    );
    if (!isWrite && !isRead) return { success: false, error: "operation is not allowed" };

    if (isWrite) {
      if (!hasExactKeys(value, ["version", "operation", "clientOperationId", "payload"])) {
        return { success: false, error: "write request has unexpected keys" };
      }
      if (
        typeof value.clientOperationId !== "string" ||
        !UUID_PATTERN.test(value.clientOperationId)
      ) {
        return { success: false, error: "clientOperationId must be a UUID" };
      }
      if (
        value.operation === "ACKNOWLEDGE_DISCLOSURE" &&
        !validDisclosureAcknowledgementPayload(value.payload)
      ) {
        return { success: false, error: "disclosure acknowledgement payload is invalid" };
      }
      return {
        success: true,
        data: {
          version: 1,
          operation: value.operation as ControlWriteOperation,
          clientOperationId: value.clientOperationId,
          payload: value.payload,
        },
      };
    }

    if (!hasExactKeys(value, ["version", "operation", "payload"])) {
      return { success: false, error: "read request has unexpected keys" };
    }
    return {
      success: true,
      data: {
        version: 1,
        operation: value.operation as ControlReadOperation,
        payload: value.payload,
      },
    };
  },
};

export function isControlWriteRequest(
  request: ControlRequest,
): request is ControlWriteRequest {
  return "clientOperationId" in request;
}
