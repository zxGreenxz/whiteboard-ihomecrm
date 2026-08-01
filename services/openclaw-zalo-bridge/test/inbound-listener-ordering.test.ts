import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createInboundController } from "../src/bridge/inbound-controller.js";
import { payloadChecksum } from "../src/spool/checksum.js";
import { SqliteSpool } from "../src/spool/sqlite-spool.js";
import type { CellWorkloadBinding } from "../src/runtime-api/workload-auth.js";
import {
  commitAndDispatchInbound,
  installInboundBridgeCommitter,
} from "../../openclaw-zalo-cell/vendor/zalouser-bridge/src/bridge/inbound-listener.js";

const binding: CellWorkloadBinding = {
  organizationId: "dddd0000-0000-4000-8000-000000000001",
  accountId: "dddd1000-0000-4000-8000-000000000001",
  cellId: "dddd2000-0000-4000-8000-000000000001",
  sessionGeneration: 5,
  fencingToken: 7,
};

function envelope(overrides: Record<string, unknown> = {}) {
  const rawEnvelope = { content: "hello" };
  const normalized = {
    text: "hello",
    replyToProviderMessageId: null,
    mediaManifest: [],
  };
  return {
    version: 1,
    organizationId: binding.organizationId,
    accountId: binding.accountId,
    cellId: binding.cellId,
    sessionGeneration: binding.sessionGeneration,
    providerEventId: "provider-event-1",
    providerMessageId: "provider-message-1",
    eventKind: "MESSAGE",
    providerConversationId: "conversation-1",
    providerSenderId: "sender-1",
    providerTarget: { kind: "PEER", providerId: "sender-1" },
    providerEventType: "webchat",
    sourceTimestamp: "2026-08-01T00:00:00.000Z",
    callbackReceivedAt: "2026-08-01T00:00:01.000Z",
    rawEnvelope,
    rawEnvelopeSha256: payloadChecksum(rawEnvelope),
    normalized,
    normalizedSha256: payloadChecksum(normalized),
    ...overrides,
  };
}

let directory: string;
let spool: SqliteSpool;
let reviewedVendorRoot: string | undefined;
const vendorBridgeCleanups: Array<() => void> = [];

const vendorRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../openclaw-zalo-cell/vendor/zalouser-bridge",
);

beforeAll(() => {
  reviewedVendorRoot = mkdtempSync(join(tmpdir(), "openclaw-reviewed-zalouser-"));
  cpSync(resolve(vendorRoot, "upstream/package"), reviewedVendorRoot, { recursive: true });
  const patches = readFileSync(resolve(vendorRoot, "patches/series"), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const patch of patches) {
    execFileSync(
      "git",
      ["apply", "--whitespace=nowarn", resolve(vendorRoot, "patches", patch)],
      { cwd: reviewedVendorRoot, stdio: "pipe" },
    );
  }
});

afterAll(() => {
  if (reviewedVendorRoot) rmSync(reviewedVendorRoot, { recursive: true, force: true });
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openclaw-inbound-controller-"));
  spool = new SqliteSpool(join(directory, "spool.db"));
});

afterEach(() => {
  for (const cleanup of vendorBridgeCleanups.splice(0).reverse()) cleanup();
  spool.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("durable inbound controller", () => {
  it("uses the bridge local clock for max-age instead of the provider callback timestamp", () => {
    spool.close();
    const now = Date.parse("2026-08-01T00:00:10.000Z");
    spool = new SqliteSpool(join(directory, "local-clock.db"), { now: () => now });
    const controller = createInboundController({ spool, binding });

    expect(controller.commit(envelope({
      callbackReceivedAt: "2000-01-01T00:00:00.000Z",
    }), binding).status).toBe("committed");
    expect(controller.ready()).toBe(true);
  });

  it("acknowledges only a committed WAL/FULL row and exact replay", () => {
    const controller = createInboundController({ spool, binding });

    expect(controller.commit(envelope(), binding)).toEqual({
      version: 1,
      status: "committed",
      durability: { journalMode: "WAL", synchronous: "FULL" },
    });
    expect(spool.countByState("SPOOLED")).toBe(1);
    expect(controller.commit(envelope(), binding)).toEqual({ version: 1, status: "duplicate" });
    expect(spool.countByState("SPOOLED")).toBe(1);
  });

  it("fails closed on hash/session mismatch and reports stable-id collision", () => {
    const controller = createInboundController({ spool, binding });

    expect(() => controller.commit(envelope({ normalizedSha256: "0".repeat(64) }), binding))
      .toThrow(/hash/i);
    expect(() => controller.commit(envelope(), { ...binding, sessionGeneration: 6 }))
      .toThrow(/session/i);
    expect(spool.countByState("SPOOLED")).toBe(0);

    controller.commit(envelope(), binding);
    expect(controller.commit(envelope({ providerMessageId: "provider-message-2" }), binding))
      .toEqual({ version: 1, status: "collision" });
    expect(spool.countByState("QUARANTINED")).toBe(1);
  });

  it("normalizes explicit SHA-256 checksums and never treats MD5 as SHA-256", () => {
    const controller = createInboundController({ spool, binding });
    const sha256 = "A".repeat(64);
    const explicitSha = {
      text: "hello",
      replyToProviderMessageId: null,
      mediaManifest: [{
        version: 1,
        index: 0,
        providerMediaId: "provider-media-1",
        kind: "IMAGE",
        mime: "image/png",
        byteLength: 24,
        providerChecksum: `sha256:${sha256}`,
        fetchRef: "https://cdn.zalo.me/1",
        byteState: "PENDING",
      }],
    };
    controller.commit(envelope({
      normalized: explicitSha,
      normalizedSha256: payloadChecksum(explicitSha),
    }), binding);

    const md5 = {
      ...explicitSha,
      mediaManifest: [{
        ...explicitSha.mediaManifest[0],
        providerMediaId: "provider-media-2",
        providerChecksum: "md5:0123456789ABCDEF0123456789ABCDEF",
      }],
    };
    controller.commit(envelope({
      providerEventId: "provider-event-2",
      providerMessageId: "provider-message-2",
      normalized: md5,
      normalizedSha256: payloadChecksum(md5),
    }), binding);

    expect(spool.pending().map((event) => (
      event.mediaManifest[0] as { providerChecksum: string | null }
    ).providerChecksum)).toEqual(["a".repeat(64), null]);
  });
});

function parseReviewedSource(path: string): ts.SourceFile {
  if (!reviewedVendorRoot) throw new Error("reviewed vendor source was not prepared");
  return ts.createSourceFile(
    path,
    readFileSync(resolve(reviewedVendorRoot, path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function findFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!found) throw new Error(`function ${name} was not found in ${sourceFile.fileName}`);
  return found;
}

function findVariableArrow(
  sourceFile: ts.SourceFile,
  functionName: string,
  variableName: string,
): ts.ArrowFunction {
  const owner = findFunction(sourceFile, functionName);
  let found: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      found = node.initializer;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(owner);
  if (!found) throw new Error(`${functionName}.${variableName} was not found`);
  return found;
}

function findObjectPropertyArrow(
  sourceFile: ts.SourceFile,
  functionName: string,
  propertyName: string,
): ts.ArrowFunction {
  const owner = findFunction(sourceFile, functionName);
  let found: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sourceFile) === propertyName &&
      ts.isArrowFunction(node.initializer)
    ) {
      found = node.initializer;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(owner);
  if (!found) throw new Error(`${functionName}.${propertyName} was not found`);
  return found;
}

function compileReviewed<T extends (...arguments_: never[]) => unknown>(
  sourceFile: ts.SourceFile,
  expression: ts.Node,
  functionNames: readonly string[],
  dependencyNames: readonly string[],
): (dependencies: Record<string, unknown>) => T {
  const dependencies = dependencyNames
    .map((name) => `const ${name} = injected.${name};`)
    .join("\n");
  const functions = functionNames
    .map((name) => findFunction(sourceFile, name).getText(sourceFile))
    .join("\n");
  const transpiled = ts.transpileModule(
    `export function make(injected: any) {\n${dependencies}\n${functions}\nreturn (${expression.getText(sourceFile)});\n}`,
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    },
  );
  if ((transpiled.diagnostics?.length ?? 0) > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(transpiled.diagnostics ?? [], {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => reviewedVendorRoot,
      getNewLine: () => "\n",
    }));
  }
  const module = { exports: {} as { make?: (values: Record<string, unknown>) => T } };
  new Function("module", "exports", transpiled.outputText)(module, module.exports);
  if (!module.exports.make) throw new Error("reviewed callback compiler did not export make");
  return module.exports.make;
}

function vendorInput(overrides: Record<string, unknown> = {}) {
  return {
    providerEventId: "provider-event-1",
    providerMessageId: "provider-message-1",
    eventKind: "MESSAGE",
    providerConversationId: "conversation-1",
    providerSenderId: "sender-1",
    providerTarget: { kind: "PEER", providerId: "sender-1" },
    providerEventType: "webchat",
    sourceTimestamp: "2026-08-01T00:00:00.000Z",
    callbackReceivedAt: "2026-08-01T00:00:01.000Z",
    rawEnvelope: { content: "hello" },
    normalized: { text: "hello", replyToProviderMessageId: null, media: [] },
    ...overrides,
  };
}

function installControllerCommitter(events: string[] = []): () => void {
  const controller = createInboundController({ spool, binding });
  const uninstall = installInboundBridgeCommitter({
    binding: {
      organizationId: binding.organizationId,
      cellId: binding.cellId,
      sessionGeneration: binding.sessionGeneration,
    },
    ready: async () => undefined,
    committer: async (committedEnvelope: unknown) => {
      events.push("commit");
      const acknowledgement = controller.commit(committedEnvelope as never, binding);
      events.push(`ack:${acknowledgement.status}`);
      return acknowledgement;
    },
    commitTimeoutMs: 6_000,
    readinessTimeoutMs: 2_000,
  });
  vendorBridgeCleanups.push(uninstall);
  return uninstall;
}

function createReviewedVendorCallbacks(options: {
  events: string[];
  failures: Error[];
  input: ReturnType<typeof vendorInput> | null;
}) {
  const monitor = parseReviewedSource("src/monitor.ts");
  const zaloJs = parseReviewedSource("src/zalo-js.ts");
  const makeMonitorCallback = compileReviewed<(message: unknown) => Promise<void>>(
    monitor,
    findObjectPropertyArrow(monitor, "monitorZalouserProvider", "onMessage"),
    [],
    [
      "stopped", "commitAndDispatchInbound", "account", "logVerbose", "core", "runtime",
      "statusSink", "resolveInboundQueueKey", "inboundQueue", "abortSignal", "processMessage",
      "config", "historyLimit", "groupHistories",
    ],
  );
  const monitorCallback = makeMonitorCallback({
    stopped: false,
    commitAndDispatchInbound,
    account: { accountId: binding.accountId },
    logVerbose: () => options.events.push("dispatch"),
    core: {},
    runtime: { error: (error: unknown) => options.failures.push(new Error(String(error))) },
    statusSink: () => undefined,
    resolveInboundQueueKey: () => "direct:sender-1",
    inboundQueue: {
      enqueue: async (_key: string, task: () => Promise<void>) => await task(),
    },
    abortSignal: { aborted: false },
    processMessage: async () => {
      options.events.push("process");
    },
    config: {},
    historyLimit: 0,
    groupHistories: new Map(),
  });
  const makeProviderCallback = compileReviewed<(incoming: { isSelf: boolean }) => void>(
    zaloJs,
    findVariableArrow(zaloJs, "startZaloListener", "onMessage"),
    [],
    ["captureProviderCallbackReceivedAt", "toInboundMessage", "ownUserId", "params", "failListener"],
  );
  return makeProviderCallback({
    captureProviderCallbackReceivedAt: () => "2026-08-01T00:00:01.000Z",
    toInboundMessage: () => options.input === null ? null : { bridge: options.input },
    ownUserId: "own-user-1",
    params: { onMessage: monitorCallback },
    failListener: (error: Error) => options.failures.push(error),
  });
}

describe("reviewed vendored provider callbacks", () => {
  it("commits before dispatching the patched provider and monitor callbacks", async () => {
    const events: string[] = [];
    const failures: Error[] = [];
    installControllerCommitter(events);
    const callback = createReviewedVendorCallbacks({
      events,
      failures,
      input: vendorInput(),
    });

    expect(callback({ isSelf: false })).toBeUndefined();
    await vi.waitFor(() => expect(events).toContain("process"));

    expect(events).toEqual(["commit", "ack:committed", "dispatch", "process"]);
    expect(failures).toEqual([]);
  });

  it("fails closed before dispatch when the Bridge commit throws", async () => {
    const events: string[] = [];
    const failures: Error[] = [];
    const failure = Object.assign(new Error("WAL write failed"), { code: "ENOSPC" });
    const uninstall = installInboundBridgeCommitter({
      binding: {
        organizationId: binding.organizationId,
        cellId: binding.cellId,
        sessionGeneration: binding.sessionGeneration,
      },
      ready: async () => undefined,
      committer: async () => {
        events.push("commit");
        throw failure;
      },
      commitTimeoutMs: 6_000,
      readinessTimeoutMs: 2_000,
    });
    vendorBridgeCleanups.push(uninstall);
    const callback = createReviewedVendorCallbacks({
      events,
      failures,
      input: vendorInput(),
    });

    callback({ isSelf: false });
    await vi.waitFor(() => expect(failures).toEqual([failure]));

    expect(events).toEqual(["commit"]);
    expect(spool.countByState("SPOOLED")).toBe(0);
  });

  it("keeps exact duplicates, collisions, and inert provider outcomes out of dispatch", async () => {
    const events: string[] = [];
    const failures: Error[] = [];
    installControllerCommitter(events);
    const first = createReviewedVendorCallbacks({
      events,
      failures,
      input: vendorInput(),
    });
    first({ isSelf: false });
    await vi.waitFor(() => expect(events).toContain("process"));

    events.length = 0;
    first({ isSelf: false });
    await vi.waitFor(() => expect(events).toContain("ack:duplicate"));
    expect(events).toEqual(["commit", "ack:duplicate"]);

    events.length = 0;
    const collision = createReviewedVendorCallbacks({
      events,
      failures,
      input: vendorInput({ providerMessageId: "provider-message-conflict" }),
    });
    collision({ isSelf: false });
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toMatchObject({ code: "INBOUND_ID_COLLISION" });
    expect(events).toEqual(["commit", "ack:collision"]);
    expect(spool.countByState("QUARANTINED")).toBe(1);

    events.length = 0;
    first({ isSelf: true });
    const inert = createReviewedVendorCallbacks({ events, failures, input: null });
    inert({ isSelf: false });
    await Promise.resolve();
    expect(events).toEqual([]);
  });

  it("executes reviewed pairing and built-in reply guards before direct provider I/O", async () => {
    const monitor = parseReviewedSource("src/monitor.ts");
    const counters = { builtInReply: 0, directProvider: 0, pairing: 0 };
    const makePairingReply = compileReviewed<(text: string) => Promise<void>>(
      monitor,
      findObjectPropertyArrow(monitor, "processMessage", "sendPairingReply"),
      ["privateRpcRequired"],
      ["sendMessageZalouser", "chatId", "account", "statusSink"],
    );
    const pairingReply = makePairingReply({
      sendMessageZalouser: async () => { counters.pairing += 1; counters.directProvider += 1; },
      chatId: "sender-1",
      account: { profile: "profile-a" },
      statusSink: () => undefined,
    });
    await expect(pairingReply("pairing code")).rejects.toMatchObject({ code: "PRIVATE_RPC_REQUIRED" });

    const deliverFunction = findFunction(monitor, "deliverZalouserReply");
    const makeBuiltInReply = compileReviewed<(params: unknown) => Promise<unknown>>(
      monitor,
      deliverFunction,
      ["privateRpcRequired", "deliverZalouserReply"],
      ["resolveSendableOutboundReplyParts", "deliverTextOrMediaReply", "sendMessageZalouser"],
    );
    const builtInReply = makeBuiltInReply({
      resolveSendableOutboundReplyParts: () => { counters.builtInReply += 1; return {}; },
      deliverTextOrMediaReply: async () => { counters.builtInReply += 1; },
      sendMessageZalouser: async () => { counters.directProvider += 1; },
    });
    await expect(builtInReply({})).rejects.toMatchObject({ code: "PRIVATE_RPC_REQUIRED" });
    expect(counters).toEqual({ builtInReply: 0, directProvider: 0, pairing: 0 });
  });
});
