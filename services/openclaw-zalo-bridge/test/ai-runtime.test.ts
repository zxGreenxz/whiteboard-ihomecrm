import { describe, expect, it, vi } from "vitest";

import {
  AiCircuitOpenError,
  customerDraftSessionKey,
  createCellAgentClient,
  promptCanaryForRequest,
} from "../src/ai/cell-agent-client.js";
import { AiCircuitBreaker } from "../src/health/circuit-breaker.js";
import {
  buildRetrievalContext,
  MAX_RETRIEVAL_CODE_POINTS,
  MAX_RETRIEVAL_UTF8_BYTES,
} from "../src/ai/retrieval-context.js";

describe("private toolless cell agent boundary", () => {
  it("calls the fixed customer-drafting agent with an exact internal no-delivery request", async () => {
    const finalAssistantRawText = JSON.stringify({
      version: 1,
      classification: "CUSTOMER_SUPPORT",
      disposition: "AUTO_REPLY",
      draftText: "We open at 8.",
      confidence: 0.96,
      knowledgeChunkIds: ["safe-1"],
    });
    const rpc = vi.fn(async () => ({
      runId: "run-1",
      status: "ok",
      summary: "completed",
      result: {
        payloads: [{ text: finalAssistantRawText }],
        meta: {
          durationMs: 42,
          finalAssistantRawText,
          agentMeta: {
            sessionId: "internal-session-1",
            provider: "openai",
            model: "gpt-5",
          },
          aborted: false,
        },
        didSendViaMessagingTool: false,
        didDeliverSourceReplyViaMessageTool: false,
        didSendDeterministicApprovalPrompt: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        messagingToolSourceReplyPayloads: [],
        acceptedSessionSpawns: [],
        successfulCronAdds: 0,
      },
    }));
    const client = createCellAgentClient({
      rpc,
      circuitBreaker: new AiCircuitBreaker({ failureThreshold: 2, resetAfterMs: 30_000 }),
      now: () => 1_785_062_400_000,
    });

    const requestId = "dddd5000-0000-4000-8000-000000000001";
    const result = await client.classifyAndDraft({
      requestId,
      customerText: "When do you open?",
      context: [{ chunkId: "safe-1", text: "Opening hours are 8-20." }],
      purpose: "CUSTOMER_FACING",
    });

    expect(result.disposition).toBe("AUTO_REPLY");
    expect(rpc).toHaveBeenCalledTimes(1);
    const [method, params] = rpc.mock.calls[0]!;
    expect(method).toBe("agent");
    expect(params).toEqual({
      message: expect.any(String),
      extraSystemPrompt: expect.any(String),
      agentId: "zalo-customer-drafting",
      promptMode: "minimal",
      bootstrapContextMode: "lightweight",
      disableMessageTool: true,
      deliver: false,
      suppressPromptPersistence: true,
      sessionEffects: "internal",
      sessionKey: customerDraftSessionKey(requestId),
      idempotencyKey: "dddd5000-0000-4000-8000-000000000001",
      timeout: 30,
    });
    expect(JSON.parse((params as { message: string }).message)).toEqual({
      version: 1,
      requestId,
      purpose: "CUSTOMER_FACING",
      untrustedInput: {
        customerText: "When do you open?",
        context: [{ chunkId: "safe-1", text: "Opening hours are 8-20." }],
      },
    });
    expect(JSON.parse((params as { extraSystemPrompt: string }).extraSystemPrompt)).toMatchObject({
      version: 1,
      policyVersion: "CUSTOMER_DRAFT_POLICY_V1",
      promptCanary: promptCanaryForRequest(requestId),
      instructions: expect.arrayContaining([
        expect.stringContaining("untrusted"),
        expect.stringContaining("JSON object"),
        expect.stringContaining("CUSTOMER_SAFE"),
      ]),
      responseSchema: {
        type: "object",
        additionalProperties: false,
        required: [
          "version", "classification", "disposition", "draftText", "confidence",
          "knowledgeChunkIds",
        ],
        properties: {
          version: { const: 1 },
          classification: { enum: ["CUSTOMER_SUPPORT", "SALES_INTENT", "SPAM", "OTHER"] },
          disposition: { enum: ["AUTO_REPLY", "HUMAN_DRAFT", "NO_SEND"] },
          draftText: { type: "string", maxLength: 4000 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          knowledgeChunkIds: {
            type: "array",
            maxItems: 100,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    });
    const serializedMessage = String((params as { message: string }).message).toLowerCase();
    for (const forbidden of ["instructions", "responseschema", "auto_reply", "system prompt"]) {
      expect(serializedMessage, forbidden).not.toContain(forbidden);
    }
    const serialized = JSON.stringify(params).toLowerCase();
    for (const forbidden of [
      "shell", "browser", "filesystem", "sql", "http tool", "send message",
      "provider", "model\"", "to\"", "channel\"", "target\"", "fallback",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    expect(params).not.toHaveProperty("modelRun");
  });

  it("rejects accepted metadata instead of treating it as final model output", async () => {
    const rpc = vi.fn(async () => ({ runId: "run-1", status: "accepted" }));
    const client = createCellAgentClient({
      rpc,
      circuitBreaker: new AiCircuitBreaker({ failureThreshold: 2, resetAfterMs: 30_000 }),
    });

    await expect(client.classifyAndDraft({
      requestId: "request-accepted-1",
      customerText: "hello",
      context: [],
      purpose: "CUSTOMER_FACING",
    })).rejects.toMatchObject({ code: "AI_SCHEMA_INVALID" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[0]).toBe("agent");
  });

  it.each([
    ["payload-only output", { payloads: [{ text: JSON.stringify({
      version: 1,
      classification: "OTHER",
      disposition: "NO_SEND",
      draftText: "",
      confidence: 0.5,
      knowledgeChunkIds: [],
    }) }], didSendViaMessagingTool: false }],
    ["missing agent identity", {
      payloads: [{ text: JSON.stringify({
        version: 1,
        classification: "OTHER",
        disposition: "NO_SEND",
        draftText: "",
        confidence: 0.5,
        knowledgeChunkIds: [],
      }) }],
      meta: { finalAssistantRawText: JSON.stringify({
        version: 1,
        classification: "OTHER",
        disposition: "NO_SEND",
        draftText: "",
        confidence: 0.5,
        knowledgeChunkIds: [],
      }) },
      didSendViaMessagingTool: false,
    }],
    ["missing messaging-tool evidence", (() => {
      const text = JSON.stringify({
        version: 1,
        classification: "OTHER",
        disposition: "NO_SEND",
        draftText: "",
        confidence: 0.5,
        knowledgeChunkIds: [],
      });
      return {
        payloads: [{ text }],
        meta: {
          finalAssistantRawText: text,
          agentMeta: { provider: "openai", model: "gpt-5" },
        },
      };
    })()],
  ])("rejects host result with %s", async (_label, result) => {
    const client = createCellAgentClient({
      rpc: vi.fn(async () => ({ runId: "run-incomplete", status: "ok", result })),
      circuitBreaker: new AiCircuitBreaker({ failureThreshold: 2, resetAfterMs: 30_000 }),
    });

    await expect(client.classifyAndDraft({
      requestId: `request-${_label}`,
      customerText: "hello",
      context: [],
      purpose: "CUSTOMER_FACING",
    })).rejects.toMatchObject({ code: "AI_SCHEMA_INVALID" });
  });

  it("fails closed on extra or malformed model fields", async () => {
    const rpc = vi.fn(async () => ({
      runId: "run-1",
      status: "ok",
      result: {
        payloads: [{
          text: JSON.stringify({
            version: 1,
            classification: "CUSTOMER_SUPPORT",
            disposition: "AUTO_REPLY",
            draftText: "hello",
            confidence: 2,
            knowledgeChunkIds: [],
            directSend: true,
          }),
        }],
      },
    }));
    const client = createCellAgentClient({
      rpc,
      circuitBreaker: new AiCircuitBreaker({ failureThreshold: 1, resetAfterMs: 30_000 }),
      now: () => 100,
    });
    await expect(client.classifyAndDraft({
      requestId: "request-1",
      customerText: "hello",
      context: [],
      purpose: "CUSTOMER_FACING",
    })).rejects.toMatchObject({ code: "AI_SCHEMA_INVALID" });
    await expect(client.classifyAndDraft({
      requestId: "request-2",
      customerText: "hello",
      context: [],
      purpose: "CUSTOMER_FACING",
    })).rejects.toBeInstanceOf(AiCircuitOpenError);
  });

  it.each([
    ["messaging-tool delivery", { didSendViaMessagingTool: true }],
    ["source-reply delivery", { didDeliverSourceReplyViaMessageTool: true }],
    ["approval prompt", { didSendDeterministicApprovalPrompt: true }],
    ["messaging text", { messagingToolSentTexts: ["sent"] }],
    ["messaging media", { messagingToolSentMediaUrls: ["https://example.com/a"] }],
    ["messaging target", { messagingToolSentTargets: [{ channel: "zalo" }] }],
    ["source reply payload", { messagingToolSourceReplyPayloads: [{ text: "sent" }] }],
    ["session spawn", { acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:x" }] }],
    ["cron mutation", { successfulCronAdds: 1 }],
    ["heartbeat tool response", { heartbeatToolResponse: { status: "ok" } }],
    ["aborted run", { meta: { aborted: true } }],
    ["yielded run", { meta: { yielded: true } }],
    ["terminal error", { meta: { error: { kind: "incomplete_turn", message: "failed" } } }],
  ])("rejects a host result reporting %s", async (_label, unsafeResult) => {
    const finalAssistantRawText = JSON.stringify({
      version: 1,
      classification: "OTHER",
      disposition: "NO_SEND",
      draftText: "",
      confidence: 0.5,
      knowledgeChunkIds: [],
    });
    const baseResult = {
      payloads: [{ text: finalAssistantRawText }],
      meta: {
        durationMs: 1,
        finalAssistantRawText,
        agentMeta: { sessionId: "session-1", provider: "openai", model: "gpt-5" },
      },
      didSendViaMessagingTool: false,
      didDeliverSourceReplyViaMessageTool: false,
      didSendDeterministicApprovalPrompt: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      messagingToolSourceReplyPayloads: [],
      acceptedSessionSpawns: [],
      successfulCronAdds: 0,
    };
    const result = {
      ...baseResult,
      ...unsafeResult,
      meta: { ...baseResult.meta, ...((unsafeResult as { meta?: object }).meta ?? {}) },
    };
    const client = createCellAgentClient({
      rpc: vi.fn(async () => ({ runId: "run-unsafe", status: "ok", result })),
      circuitBreaker: new AiCircuitBreaker({ failureThreshold: 2, resetAfterMs: 30_000 }),
    });

    await expect(client.classifyAndDraft({
      requestId: `request-${String(_label).replaceAll(" ", "-")}`,
      customerText: "hello",
      context: [],
      purpose: "CUSTOMER_FACING",
    })).rejects.toMatchObject({ code: "AI_SCHEMA_INVALID" });
  });

  it("rejects payload text that differs from the host's final assistant raw text", async () => {
    const payloadText = JSON.stringify({
      version: 1,
      classification: "OTHER",
      disposition: "NO_SEND",
      draftText: "payload",
      confidence: 0.5,
      knowledgeChunkIds: [],
    });
    const client = createCellAgentClient({
      rpc: vi.fn(async () => ({
        runId: "run-mismatch",
        status: "ok",
        result: {
          payloads: [{ text: payloadText }],
          meta: {
            durationMs: 1,
            finalAssistantRawText: payloadText.replace("payload", "raw"),
            agentMeta: { sessionId: "session-1", provider: "openai", model: "gpt-5" },
          },
        },
      })),
      circuitBreaker: new AiCircuitBreaker({ failureThreshold: 2, resetAfterMs: 30_000 }),
    });

    await expect(client.classifyAndDraft({
      requestId: "request-mismatch-1",
      customerText: "hello",
      context: [],
      purpose: "CUSTOMER_FACING",
    })).rejects.toMatchObject({ code: "AI_SCHEMA_INVALID" });
  });

  it("opens only the AI circuit and leaves non-AI/manual readiness available", async () => {
    const breaker = new AiCircuitBreaker({ failureThreshold: 1, resetAfterMs: 30_000 });
    const client = createCellAgentClient({
      rpc: vi.fn(async () => { throw new Error("quota exceeded"); }),
      circuitBreaker: breaker,
      now: () => 100,
    });
    await expect(client.classifyAndDraft({
      requestId: "request-1",
      customerText: "hello",
      context: [],
      purpose: "CUSTOMER_FACING",
    })).rejects.toThrow();
    expect(breaker.snapshot(100)).toMatchObject({ state: "OPEN", aiAutomaticSendAllowed: false });
    expect(breaker.snapshot(100).manualNonAiSendAllowed).toBe(true);
  });

  it("opens the AI circuit when the bounded agent run times out", async () => {
    const breaker = new AiCircuitBreaker({ failureThreshold: 1, resetAfterMs: 30_000 });
    const client = createCellAgentClient({
      rpc: vi.fn(async () => { throw Object.assign(new Error("timed out"), { code: "CELL_RPC_TIMEOUT" }); }),
      circuitBreaker: breaker,
      now: () => 100,
    });

    await expect(client.classifyAndDraft({
      requestId: "request-timeout-1",
      customerText: "hello",
      context: [],
      purpose: "CUSTOMER_FACING",
    })).rejects.toMatchObject({ code: "AI_RPC_FAILED" });
    expect(breaker.snapshot(100)).toMatchObject({ state: "OPEN", aiAutomaticSendAllowed: false });
  });

  it("starts the reset interval when the failing RPC completes", async () => {
    let clock = 0;
    const breaker = new AiCircuitBreaker({ failureThreshold: 1, resetAfterMs: 60_000 });
    const client = createCellAgentClient({
      rpc: vi.fn(async () => {
        clock = 30_000;
        throw Object.assign(new Error("timed out"), { code: "CELL_RPC_TIMEOUT" });
      }),
      circuitBreaker: breaker,
      now: () => clock,
    });

    await expect(client.classifyAndDraft({
      requestId: "request-elapsed-timeout-1",
      customerText: "hello",
      context: [],
      purpose: "CUSTOMER_FACING",
    })).rejects.toMatchObject({ code: "AI_RPC_FAILED" });

    expect(breaker.snapshot(clock)).toMatchObject({
      state: "OPEN",
      openedAtMs: 30_000,
      nextProbeAtMs: 90_000,
    });
    expect(breaker.canAttempt(60_000)).toBe(false);
  });
});

describe("retrieval sensitivity boundary", () => {
  it("includes only CUSTOMER_SAFE chunks in customer-facing generation", () => {
    expect(buildRetrievalContext({
      purpose: "CUSTOMER_FACING",
      frozenKnowledgeVersionIds: ["v1"],
      chunks: [
        { chunkId: "safe", knowledgeVersionId: "v1", sensitivity: "CUSTOMER_SAFE", text: "safe" },
        { chunkId: "internal", knowledgeVersionId: "v1", sensitivity: "INTERNAL_REVIEW_ONLY", text: "internal" },
        { chunkId: "restricted", knowledgeVersionId: "v1", sensitivity: "RESTRICTED", text: "restricted" },
        { chunkId: "stale", knowledgeVersionId: "v2", sensitivity: "CUSTOMER_SAFE", text: "stale" },
      ],
    })).toEqual([{ chunkId: "safe", text: "safe" }]);
  });

  it("bounds total retrieval text by code points and UTF-8 bytes", () => {
    const context = buildRetrievalContext({
      purpose: "CUSTOMER_FACING",
      frozenKnowledgeVersionIds: ["v1"],
      chunks: Array.from({ length: 20 }, (_, index) => ({
        chunkId: `safe-${index}`,
        knowledgeVersionId: "v1",
        sensitivity: "CUSTOMER_SAFE" as const,
        text: "\u0111".repeat(5_000),
      })),
    });
    const joined = context.map((chunk) => chunk.text).join("");

    expect(Array.from(joined).length).toBeLessThanOrEqual(MAX_RETRIEVAL_CODE_POINTS);
    expect(Buffer.byteLength(joined, "utf8")).toBeLessThanOrEqual(MAX_RETRIEVAL_UTF8_BYTES);
  });
});
