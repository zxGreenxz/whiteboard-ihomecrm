import { createCellAgentClient } from "../ai/cell-agent-client.js";
import { AiCircuitBreaker } from "../health/circuit-breaker.js";
import {
  parseOpenClawSendWorkClaimV1,
  snapshotCanonicalSendPayload,
  type OpenClawSendWorkClaimV1,
} from "../runtime-api/schemas.js";
import { canonicalJson } from "../spool/checksum.js";
import { runCrmEvent } from "./crm-event-runner.js";
import { runInboundAutomation, type InboundFrozenContext } from "./inbound-automation-runner.js";
import { retryWorkRequest } from "./inbound-automation-runner.js";
import { runScheduleOccurrence } from "./schedule-runner.js";
import { TEMPLATE_FIELD_ALLOWLIST, type TemplateField } from "./template-renderer.js";

interface RuntimeApi {
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

interface CellRpc {
  invoke(method: string, params: unknown): Promise<unknown>;
}

type CurrentState = { allowed: true } | { allowed: false; reasonCode: string };

type TemplateFrozenContext = {
  frozenIdentity: OpenClawSendWorkClaimV1["payload"];
  template: string;
  values: Partial<Record<TemplateField, string>>;
  requiredFields: TemplateField[];
  canonicalPayload: ReturnType<typeof snapshotCanonicalSendPayload>;
  sourceSnapshotHash: string;
};

type CrmFrozenContext = TemplateFrozenContext & {
  allowedCrmFields: TemplateField[];
};

type ParsedWorkContext =
  | {
      kind: "INBOUND_AUTOMATION";
      currentState: CurrentState;
      frozenContext: InboundFrozenContext;
    }
  | {
      kind: "SCHEDULE_OCCURRENCE";
      currentState: CurrentState;
      frozenContext: TemplateFrozenContext;
    }
  | {
      kind: "CRM_EVENT";
      currentState: CurrentState;
      frozenContext: CrmFrozenContext;
    };

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const result = object(value, name);
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unexpected fields`);
  }
  return result;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function sha256(value: unknown, name: string): string {
  const result = nonEmptyString(value, name);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new TypeError(`${name} must be a SHA-256`);
  return result;
}

function currentState(value: unknown): CurrentState {
  const candidate = object(value, "work current state");
  if (candidate.allowed === true) {
    exact(candidate, ["allowed"], "work current state");
    return { allowed: true };
  }
  exact(candidate, ["allowed", "reasonCode"], "work current state");
  if (candidate.allowed !== false) throw new TypeError("work current state is invalid");
  return { allowed: false, reasonCode: nonEmptyString(candidate.reasonCode, "reasonCode") };
}

function templateFields(value: unknown, name: string): Partial<Record<TemplateField, string>> {
  const source = object(value, name);
  const allowed = new Set<string>(TEMPLATE_FIELD_ALLOWLIST);
  const result: Partial<Record<TemplateField, string>> = {};
  for (const [key, fieldValue] of Object.entries(source)) {
    if (!allowed.has(key) || typeof fieldValue !== "string") {
      throw new TypeError(`${name} contains an invalid field`);
    }
    result[key as TemplateField] = fieldValue;
  }
  return result;
}

function requiredTemplateFields(value: unknown): TemplateField[] {
  if (!Array.isArray(value)) throw new TypeError("requiredFields must be an array");
  const allowed = new Set<string>(TEMPLATE_FIELD_ALLOWLIST);
  if (
    value.some((entry) => typeof entry !== "string" || !allowed.has(entry)) ||
    new Set(value).size !== value.length
  ) throw new TypeError("requiredFields are invalid");
  return [...value] as TemplateField[];
}

function allowedCrmFields(value: unknown): TemplateField[] {
  if (!Array.isArray(value)) throw new TypeError("allowedCrmFields must be an array");
  const allowed = new Set<string>(TEMPLATE_FIELD_ALLOWLIST);
  if (
    value.some((entry) => typeof entry !== "string" || !allowed.has(entry)) ||
    new Set(value).size !== value.length
  ) throw new TypeError("allowedCrmFields are invalid");
  return [...value] as TemplateField[];
}

function claimBoundCanonicalPayload(
  value: unknown,
  claim: OpenClawSendWorkClaimV1,
  sourceSnapshotHash: string,
) {
  const payload = snapshotCanonicalSendPayload(value);
  if (
    payload.organizationId !== claim.organizationId || payload.accountId !== claim.accountId ||
    payload.frozenInputs.sourceSnapshotHash !== sourceSnapshotHash
  ) throw new TypeError("canonical work context is not bound to claim");
  return payload;
}

function parseWorkContext(value: unknown, claimValue: OpenClawSendWorkClaimV1): ParsedWorkContext {
  const claim = parseOpenClawSendWorkClaimV1(claimValue);
  const response = exact(value, [
    "version", "workItemId", "claimGeneration", "kind", "currentState", "frozenContext",
  ], "work context response");
  if (
    response.version !== 1 || response.workItemId !== claim.workItemId ||
    response.claimGeneration !== claim.claimGeneration || response.kind !== claim.payload.kind
  ) throw new TypeError("work context response is not bound to the claim");
  const state = currentState(response.currentState);

  if (claim.payload.kind === "INBOUND_AUTOMATION") {
    const frozen = exact(response.frozenContext, [
      "customerText", "knowledgeChunks", "canonicalPayload", "sourceSnapshotHash",
    ], "inbound frozen context");
    if (typeof frozen.customerText !== "string" || !Array.isArray(frozen.knowledgeChunks)) {
      throw new TypeError("inbound frozen context is invalid");
    }
    const allowedVersions = new Set(claim.payload.knowledgeVersionIds);
    const chunkIds = new Set<string>();
    const knowledgeChunks = frozen.knowledgeChunks.map((value, index) => {
      const chunk = exact(
        value,
        ["chunkId", "versionId", "sensitivity", "text"],
        `knowledgeChunks[${index}]`,
      );
      const chunkId = nonEmptyString(chunk.chunkId, `knowledgeChunks[${index}].chunkId`);
      const knowledgeVersionId = nonEmptyString(
        chunk.versionId,
        `knowledgeChunks[${index}].versionId`,
      );
      if (
        chunkIds.has(chunkId) || !allowedVersions.has(knowledgeVersionId) ||
        !["CUSTOMER_SAFE", "INTERNAL_REVIEW_ONLY", "RESTRICTED"].includes(
          String(chunk.sensitivity),
        ) || typeof chunk.text !== "string"
      ) throw new TypeError("knowledge chunk lineage is invalid");
      chunkIds.add(chunkId);
      return {
        chunkId,
        knowledgeVersionId,
        sensitivity: chunk.sensitivity as "CUSTOMER_SAFE" | "INTERNAL_REVIEW_ONLY" | "RESTRICTED",
        text: chunk.text,
      };
    });
    const sourceSnapshotHash = sha256(frozen.sourceSnapshotHash, "sourceSnapshotHash");
    if (sourceSnapshotHash !== claim.payload.eligibilityDecisionHash) {
      throw new TypeError("inbound source snapshot hash is invalid");
    }
    const canonicalPayload = claimBoundCanonicalPayload(
      frozen.canonicalPayload,
      claim,
      sourceSnapshotHash,
    );
    return {
      kind: "INBOUND_AUTOMATION",
      currentState: state,
      frozenContext: {
        customerText: frozen.customerText,
        knowledgeChunks,
        canonicalPayload,
        sourceSnapshotHash,
      },
    };
  }

  const frozenKeys = [
    "frozenIdentity", "template", "values", "requiredFields", "canonicalPayload",
    "sourceSnapshotHash",
  ];
  if (claim.payload.kind === "CRM_EVENT") frozenKeys.push("allowedCrmFields");
  const frozen = exact(response.frozenContext, frozenKeys, "template frozen context");
  if (canonicalJson(frozen.frozenIdentity) !== canonicalJson(claim.payload)) {
    throw new TypeError("frozen work identity is invalid");
  }
  const sourceSnapshotHash = sha256(frozen.sourceSnapshotHash, "sourceSnapshotHash");
  const canonicalPayload = claimBoundCanonicalPayload(
    frozen.canonicalPayload,
    claim,
    sourceSnapshotHash,
  );
  const templateContext: TemplateFrozenContext = {
    frozenIdentity: claim.payload,
    template: nonEmptyString(frozen.template, "template"),
    values: templateFields(frozen.values, "values"),
    requiredFields: requiredTemplateFields(frozen.requiredFields),
    canonicalPayload,
    sourceSnapshotHash,
  };
  if (claim.payload.kind === "CRM_EVENT") return {
    kind: "CRM_EVENT",
    currentState: state,
    frozenContext: {
      ...templateContext,
      allowedCrmFields: allowedCrmFields(frozen.allowedCrmFields),
    },
  };
  return {
    kind: "SCHEDULE_OCCURRENCE",
    currentState: state,
    frozenContext: templateContext,
  };
}

/** Production handlers backed only by the claim-bound Runtime API and private cell RPC. */
export function createProductionWorkHandlers(options: {
  runtime: RuntimeApi;
  cellRpc: CellRpc;
  allowedGeneratedUrlHosts?: readonly string[];
  knownSecretValues?: readonly string[];
  now?: () => number;
  circuitBreaker?: AiCircuitBreaker;
}) {
  const now = options.now ?? Date.now;
  const circuitBreaker = options.circuitBreaker ??
    new AiCircuitBreaker({ failureThreshold: 3, resetAfterMs: 60_000 });
  const agent = createCellAgentClient({
    rpc: async (method, params) => await options.cellRpc.invoke(method, params),
    circuitBreaker,
    now,
  });
  const contextFor = async (claim: OpenClawSendWorkClaimV1) => parseWorkContext(
    await options.runtime.post("/v1/work/context", { version: 1, claim }),
    claim,
  );
  const createOutbox = async (request: Parameters<typeof options.runtime.post>[1]) =>
    await options.runtime.post("/v1/work/create-outbox", request);
  const completeWork = async (request: Parameters<typeof options.runtime.post>[1]) =>
    await options.runtime.post("/v1/work/complete", request);
  const runWithFailureCompletion = async (
    claim: OpenClawSendWorkClaimV1,
    operation: () => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      return await operation();
    } catch (error) {
      return await completeWork(retryWorkRequest(claim, error));
    }
  };

  return Object.freeze({
    aiAutomaticSendAllowed() {
      const snapshot = circuitBreaker.snapshot(now());
      return snapshot.state === "CLOSED" ||
        (snapshot.state === "OPEN" && snapshot.nextProbeAtMs !== null &&
          now() >= snapshot.nextProbeAtMs);
    },
    async runInbound(claim: OpenClawSendWorkClaimV1) {
      return await runWithFailureCompletion(claim, async () => {
        const contextPromise = contextFor(claim);
        return await runInboundAutomation(claim, {
        recheckCurrentState: async () => (await contextPromise).currentState,
        loadFrozenContext: async () => {
          const context = await contextPromise;
          if (context.kind !== "INBOUND_AUTOMATION") throw new TypeError("work context kind changed");
          return context.frozenContext;
        },
        agent,
        createOutbox,
        completeWork,
        allowedUrlHosts: options.allowedGeneratedUrlHosts ?? [],
        knownSecretValues: options.knownSecretValues ?? [],
        });
      });
    },
    async runSchedule(claim: OpenClawSendWorkClaimV1) {
      return await runWithFailureCompletion(claim, async () => {
        const contextPromise = contextFor(claim);
        return await runScheduleOccurrence(claim, {
        recheckCurrentState: async () => (await contextPromise).currentState,
        loadFrozenSchedule: async () => {
          const context = await contextPromise;
          if (context.kind !== "SCHEDULE_OCCURRENCE") throw new TypeError("work context kind changed");
          return context.frozenContext;
        },
        createOutbox,
        completeWork,
        allowedUrlHosts: options.allowedGeneratedUrlHosts ?? [],
        });
      });
    },
    async runCrm(claim: OpenClawSendWorkClaimV1) {
      return await runWithFailureCompletion(claim, async () => {
        const contextPromise = contextFor(claim);
        return await runCrmEvent(claim, {
        recheckCurrentState: async () => (await contextPromise).currentState,
        loadFrozenCrmEvent: async () => {
          const context = await contextPromise;
          if (context.kind !== "CRM_EVENT") throw new TypeError("work context kind changed");
          return context.frozenContext;
        },
        createOutbox,
        completeWork,
        allowedUrlHosts: options.allowedGeneratedUrlHosts ?? [],
        });
      });
    },
  });
}
