import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const packageRoot = "/home/node/.openclaw/npm/projects/zalouser/node_modules/@openclaw/zalouser";
const variant = process.env.IHOME_BEHAVIOR_VARIANT;
if (variant !== "fork" && variant !== "stock") throw new Error("invalid behavior probe variant");
if (variant === "fork") process.env.IHOME_BEHAVIOR_PROBE = "1";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolutionContext =
      specifier === "openclaw" || specifier.startsWith("openclaw/")
        ? { ...context, parentURL: "file:///app/openclaw.mjs" }
        : context;
    return nextResolve(specifier, resolutionContext);
  },
});

const manifest = JSON.parse(readFileSync(`${packageRoot}/package.json`, "utf8"));
if (manifest.name !== "@openclaw/zalouser" || manifest.version !== "2026.7.1") {
  throw new Error("installed ZaloUser package identity mismatch");
}

const gatewayMethods = [];
const noop = () => undefined;
const apiTarget = {
  registrationMode: "full",
  runtime: {},
  config: {},
  logger: { debug: noop, info: noop, warn: noop, error: noop },
  registerChannel: noop,
  registerTool: noop,
  registerGatewayMethod(method, handler, options) {
    gatewayMethods.push({ method, handler, options });
  },
};
const entry = (await import(pathToFileURL(`${packageRoot}/dist/index.js`).href)).default;
if (!entry || typeof entry.register !== "function") throw new Error("installed plugin register export is missing");
await entry.register(new Proxy(apiTarget, {
  get(target, property) {
    return property in target ? target[property] : noop;
  },
}));

const registeredMethods = gatewayMethods.map(({ method }) => method).sort();
const cases = [];
let activeCase = "";
let events = [];
let providerCalls = [];
const observe = (actor, operation, detail = {}) => {
  events.push({ seq: events.length, actor, operation, ...detail });
};
const outcomeError = (error) => ({
  kind: "error",
  code: error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : "ERROR",
});
const runCase = async (id, operation) => {
  activeCase = id;
  events = [];
  providerCalls = [];
  let outcome;
  try {
    const value = await operation();
    outcome = { kind: "return", value: value === undefined ? null : value };
  } catch (error) {
    outcome = outcomeError(error);
  }
  cases.push({ id, outcome, events });
};

const canonicalJson = (value) => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite canonical number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("unsupported canonical value");
  const keys = Object.keys(value).sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};
const payloadHash = (payload) => createHash("sha256")
  .update("ihome-openclaw-send-v1\0", "utf8")
  .update(canonicalJson(payload), "utf8")
  .digest("hex");
const textPart = (partIndex, text = "probe") => Object.freeze({
  version: 1,
  partIndex,
  kind: "TEXT",
  text,
});
const mediaBytes = Buffer.from("offline-probe-image", "utf8");
const mediaPart = Object.freeze({
  version: 1,
  partIndex: 0,
  kind: "MEDIA",
  objectKey: "organization-a/account-a/outbox-media/part-0",
  sha256: createHash("sha256").update(mediaBytes).digest("hex"),
  mime: "image/png",
  bytes: mediaBytes.length,
});
const payloadFor = (parts, target = { kind: "SALES_GROUP", providerId: "group-a" }) => Object.freeze({
  version: 1,
  organizationId: "organization-a",
  accountId: "account-a",
  target: Object.freeze(target),
  channel: "zalouser",
  accountProfile: "profile-a",
  idempotencyKey: `outbox-${activeCase || "probe"}:1`,
  parts: Object.freeze(parts),
  replyToProviderMessageId: null,
  policyVersionId: "policy-v1",
  automationVersionId: null,
  templateVersionId: null,
  frozenInputs: Object.freeze({
    campaignVersionId: null,
    scheduleVersion: null,
    subscriptionVersion: null,
    occurrenceId: null,
    subscriptionId: null,
    sourceTable: null,
    sourceId: null,
    sourceVersion: null,
    knowledgeVersionIds: Object.freeze([]),
    sourceSnapshotHash: null,
    targetVersion: 1,
    targetDirectoryRefreshedAt: "2026-07-29T10:00:00.000Z",
    fieldMappingHash: null,
  }),
});
const requestFor = (parts, target) => {
  const payload = payloadFor(parts, target);
  return Object.freeze({
    version: 1,
    payload,
    authorization: Object.freeze({
      version: 1,
      claimToken: "claim-token-secret",
      authorizationMarker: Object.freeze({
        version: 1,
        outboxId: "outbox-a",
        claimGeneration: 1,
        payloadHash: payloadHash(payload),
        fencingToken: 9,
        sessionGeneration: 7,
        controlVersion: 3,
        takeoverVersion: 2,
        markerNonce: "marker-nonce-a",
        expiresAt: "2026-07-29T10:00:15.000Z",
      }),
    }),
  });
};

if (variant === "stock") {
  await runCase("outbound-text-authorized", async () => {
    const registration = gatewayMethods.find(({ method }) => method === "zalouser.bridge.send");
    if (!registration) throw Object.assign(new Error("private method is not registered"), {
      code: "METHOD_NOT_REGISTERED",
    });
    throw Object.assign(new Error("stock unexpectedly registered the private method"), {
      code: "STOCK_PRIVATE_METHOD_PRESENT",
    });
  });
} else {
  const {
    installInstalledBehaviorContractRuntimeV1,
    invokeInstalledBehaviorTypingV1,
  } = await import(pathToFileURL(`${packageRoot}/dist/behavior-contract-api.js`).href);
  if (typeof installInstalledBehaviorContractRuntimeV1 !== "function") {
    throw new Error("installed authentic behavior contract entrypoint is missing");
  }
  const binding = Object.freeze({
    organizationId: "organization-a",
    accountId: "account-a",
    cellId: "cell-a",
    sessionGeneration: 7,
    fencingToken: 9,
    controlVersion: 3,
    takeoverVersion: 2,
  });
  let nonce = 0;
  const fixtureApi = Object.freeze({
    getContext: () => ({ imei: "probe-imei", userAgent: "probe-agent", language: "vi" }),
    getCookie: () => ({ toJSON: () => ({ cookies: [{ name: "probe", value: "offline" }] }) }),
    async sendMessage(message, threadId, type) {
      const callIndex = providerCalls.length;
      const detail = typeof message === "string"
        ? { callIndex, messageKind: "text", text: message, threadId, type }
        : {
          callIndex,
          messageKind: "media",
          attachmentBytes: message.attachments?.[0]?.data?.length ?? 0,
          attachmentSha256: createHash("sha256").update(message.attachments?.[0]?.data ?? Buffer.alloc(0)).digest("hex"),
          threadId,
          type,
        };
      providerCalls.push(detail);
      observe("provider", "send-message", detail);
      if (activeCase === "outbound-partial-handoff-unknown" && callIndex === 1) {
        throw Object.assign(new Error("connection closed after write"), { code: "ECONNRESET" });
      }
      return { msgId: `provider-${callIndex}` };
    },
    async uploadAttachment() {
      return [{ fileType: "others", fileUrl: "https://offline.invalid/file.bin" }];
    },
    async sendVoice() {
      return { msgId: "voice-probe" };
    },
    async sendTypingEvent(threadId, type) {
      observe("provider", "typing", { threadId, type });
      return { status: 0 };
    },
  });
  const installation = installInstalledBehaviorContractRuntimeV1({
    binding,
    bridgeBaseUrl: "http://bridge.internal",
    bridgeSecret: Buffer.alloc(32, 0x46),
    gatewayClientId: "gateway-a",
    now: () => Date.parse("2026-07-29T10:00:00.000Z"),
    nonce: () => `behavior-${nonce += 1}`,
    providerFixture: { accountProfile: "profile-a", api: fixtureApi },
    bridgeFetch: async (_url, init) => {
      const envelope = JSON.parse(String(init.body));
      observe("bridge", envelope.operation);
      if (envelope.operation === "inbound.ready") {
        return new Response(JSON.stringify({ version: 1, status: "READY" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (envelope.operation === "inbound.commit") {
        const acknowledgement = activeCase === "inbound-duplicate"
          ? { version: 1, status: "duplicate" }
          : activeCase === "inbound-corrupt"
            ? { version: 1, status: "committed", durability: { journalMode: "DELETE", synchronous: "NORMAL" } }
            : { version: 1, status: "committed", durability: { journalMode: "WAL", synchronous: "FULL" } };
        return new Response(JSON.stringify(acknowledgement), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (envelope.operation === "media.materialize") {
        return new Response(JSON.stringify({
          version: 1,
          objectKey: mediaPart.objectKey,
          sha256: mediaPart.sha256,
          mime: mediaPart.mime,
          bytes: mediaBytes.length,
          contentBase64: mediaBytes.toString("base64"),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (envelope.operation === "outbox.authorize-send") {
        const status = activeCase === "outbound-authorization-denied" ? "DENIED" : "AUTHORIZED";
        return new Response(JSON.stringify({ version: 1, status }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (envelope.operation === "control.authorize") {
        const status = activeCase === "control-denied" ? "DENIED" : "AUTHORIZED";
        return new Response(JSON.stringify({ version: 1, status }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected bridge operation ${envelope.operation}`);
    },
  });
  try {
    const inbound = Object.freeze({
      providerEventId: "event-a",
      providerMessageId: "message-a",
      eventKind: "MESSAGE",
      providerConversationId: "conversation-a",
      providerSenderId: "sender-a",
      providerTarget: Object.freeze({ kind: "PEER", providerId: "peer-a" }),
      providerEventType: "message",
      sourceTimestamp: "2026-07-29T10:00:00.000Z",
      callbackReceivedAt: "2026-07-29T10:00:00.001Z",
      rawEnvelope: Object.freeze({ id: "event-a" }),
      normalized: Object.freeze({ text: "probe", replyToProviderMessageId: null, media: Object.freeze([]) }),
    });
    await runCase("inbound-committed", async () => {
      await installation.readyInbound("account-a");
      return await installation.commitInboundAndDispatch("account-a", inbound, async () => {
        observe("plugin", "dispatch-inbound");
      });
    });
    await runCase("inbound-duplicate", async () => await installation.commitInboundAndDispatch("account-a", inbound, async () => {
      observe("plugin", "dispatch-inbound");
    }));
    await runCase("inbound-corrupt", async () => await installation.commitInboundAndDispatch("account-a", inbound, async () => {
      observe("plugin", "dispatch-inbound");
    }));

    const registration = gatewayMethods.find(({ method }) => method === "zalouser.bridge.send");
    if (!registration) throw new Error("fork private bridge method is not registered");
    const invokePrivate = async (request) => {
      let response;
      await registration.handler({
        client: { id: "gateway-a" },
        params: request,
        respond(ok, value, error) {
          response = { ok, value: value ?? null, error: error ?? null };
        },
      });
      return response;
    };
    await runCase("outbound-group-text-authorized", async () =>
      await invokePrivate(requestFor([textPart(0)], { kind: "SALES_GROUP", providerId: "group-a" })));
    await runCase("outbound-peer-media-authorized", async () =>
      await invokePrivate(requestFor([mediaPart], { kind: "PEER", providerId: "peer-a" })));
    await runCase("outbound-link-rejected", async () => await invokePrivate(requestFor([
      Object.freeze({ version: 1, partIndex: 0, kind: "LINK", url: "https://invalid.example", caption: null }),
    ])));
    await runCase("outbound-reaction-rejected", async () => await invokePrivate(requestFor([
      Object.freeze({ version: 1, partIndex: 0, kind: "REACTION", msgId: "msg-a", cliMsgId: "cli-a", emoji: "thumbsup", remove: false }),
    ])));
    await runCase("outbound-authorization-denied", async () =>
      await invokePrivate(requestFor([textPart(0)], { kind: "PEER", providerId: "peer-a" })));
    await runCase("outbound-partial-handoff-unknown", async () =>
      await invokePrivate(requestFor([textPart(0, "first"), textPart(1, "second")], { kind: "PEER", providerId: "peer-a" })));
    await runCase("control-authorized", async () =>
      await invokeInstalledBehaviorTypingV1("thread-a", { profile: "profile-a", isGroup: false }));
    await runCase("control-denied", async () =>
      await invokeInstalledBehaviorTypingV1("thread-a", { profile: "profile-a", isGroup: false }));
  } finally {
    installation.close();
  }
}

process.stdout.write(`${JSON.stringify({
  schema: 3,
  contract: "ihome.zalouser.business.v1",
  implementation: variant,
  package: { name: manifest.name, version: manifest.version },
  registered_methods: registeredMethods,
  cases,
})}\n`);
