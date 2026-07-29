import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildZaloUserInboundEnvelopeV1,
  commitAndDispatchInbound,
  installInboundBridgeCommitter,
  type ZaloUserInboundInputV1,
} from "../src/bridge/inbound-listener.js";

const vendorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];
const bridgeCleanups: Array<() => void> = [];

const COMMITTED_ACK = Object.freeze({
  durability: Object.freeze({ journalMode: "WAL", synchronous: "FULL" }),
  status: "committed",
  version: 1,
});

const BRIDGE_INPUT: ZaloUserInboundInputV1 = Object.freeze({
  callbackReceivedAt: "2026-07-27T00:00:01.000Z",
  eventKind: "MESSAGE",
  normalized: Object.freeze({
    media: Object.freeze([]),
    replyToProviderMessageId: null,
    text: "hello",
  }),
  providerConversationId: "conversation-1",
  providerEventId: "event-1",
  providerEventType: "webchat",
  providerMessageId: "message-1",
  providerSenderId: "sender-1",
  providerTarget: Object.freeze({ kind: "PEER", providerId: "peer-1" }),
  rawEnvelope: Object.freeze({ source: "patched-monitor-test" }),
  sourceTimestamp: "2026-07-27T00:00:00.000Z",
});

afterEach(() => {
  for (const cleanup of bridgeCleanups.splice(0).reverse()) cleanup();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function installBridge(committer: (envelope: unknown) => Promise<unknown>): () => void {
  const uninstall = installInboundBridgeCommitter({
    binding: {
      cellId: "cell-a",
      organizationId: "organization-a",
      sessionGeneration: 7,
    },
    committer,
    ready: async () => undefined,
    commitTimeoutMs: 6_000,
    readinessTimeoutMs: 2_000,
  });
  bridgeCleanups.push(uninstall);
  return () => {
    const index = bridgeCleanups.lastIndexOf(uninstall);
    if (index >= 0) bridgeCleanups.splice(index, 1);
    uninstall();
  };
}

function preparePatchedSource(): string {
  const root = mkdtempSync(resolve(tmpdir(), "ihome-inbound-patched-source-"));
  temporaryRoots.push(root);
  cpSync(resolve(vendorRoot, "upstream/package"), root, { recursive: true });
  execFileSync(
    "git",
    ["apply", "--whitespace=nowarn", resolve(vendorRoot, "patches/0001-durable-inbound-bridge-listener.patch")],
    { cwd: root, stdio: "pipe" },
  );
  return root;
}

function findFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!found) throw new Error(`function ${name} was not found`);
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
  if (!found) throw new Error(`${functionName}.${variableName} arrow was not found`);
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
  if (!found) throw new Error(`${functionName}.${propertyName} callback was not found`);
  return found;
}

function compileCallback(
  sourceFile: ts.SourceFile,
  arrow: ts.ArrowFunction,
  dependencyNames: readonly string[],
): (dependencies: Record<string, unknown>) => (argument: unknown) => unknown {
  const declarations = dependencyNames
    .map((name) => `const ${name} = dependencies.${name};`)
    .join("\n");
  const source = `export function make(dependencies: any) {\n${declarations}\nreturn (${arrow.getText(sourceFile)});\n}`;
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const diagnostics = transpiled.diagnostics ?? [];
  if (diagnostics.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => vendorRoot,
      getNewLine: () => "\n",
    }));
  }
  const module = { exports: {} as Record<string, unknown> };
  const evaluate = new Function("module", "exports", transpiled.outputText);
  evaluate(module, module.exports);
  return module.exports.make as (dependencies: Record<string, unknown>) => (argument: unknown) => unknown;
}

function compileFunctionSet(
  sourceFile: ts.SourceFile,
  entryName: string,
  candidateFunctionNames: readonly string[],
  dependencyNames: readonly string[],
): (dependencies: Record<string, unknown>) => (...arguments_: unknown[]) => unknown {
  const declarations = dependencyNames
    .map((name) => `const ${name} = dependencies.${name};`)
    .join("\n");
  const functions = sourceFile.statements
    .filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        Boolean(statement.name && candidateFunctionNames.includes(statement.name.text)),
    )
    .map((statement) => statement.getText(sourceFile))
    .join("\n");
  if (!candidateFunctionNames.includes(entryName) || !functions.includes(`function ${entryName}`)) {
    throw new Error(`function ${entryName} was not included`);
  }
  const source = `export function make(dependencies: any) {\n${declarations}\n${functions}\nreturn ${entryName};\n}`;
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const diagnostics = transpiled.diagnostics ?? [];
  if (diagnostics.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => vendorRoot,
      getNewLine: () => "\n",
    }));
  }
  const module = { exports: {} as Record<string, unknown> };
  const evaluate = new Function("module", "exports", transpiled.outputText);
  evaluate(module, module.exports);
  return module.exports.make as (
    dependencies: Record<string, unknown>,
  ) => (...arguments_: unknown[]) => unknown;
}

function parse(root: string, path: string): ts.SourceFile {
  const source = readFileSync(resolve(root, path), "utf8");
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe("executable patched inbound source", () => {
  it("runs the real provider producer through the strict overlay with exact provider evidence", () => {
    const root = preparePatchedSource();
    const zaloJs = parse(root, "src/zalo-js.ts");
    const makeToInboundMessage = compileFunctionSet(
      zaloJs,
      "toInboundMessage",
      [
        "classifyInboundEventKind",
        "classifyInboundMediaKind",
        "extractInboundMediaInputs",
        "firstProviderValue",
        "nullableProviderString",
        "providerScalarString",
        "snapshotProviderEnvelope",
        "toInboundMessage",
      ],
      [
        "ThreadType",
        "buildEventMessage",
        "extractMentionIds",
        "normalizeMessageContent",
        "resolveGroupNameFromMessageData",
        "resolveInboundTimestamp",
        "stripLeadingAtMentionForCommand",
        "stripOwnMentionsForCommandBody",
        "toNonNegativeInteger",
        "toNumberId",
        "toStringValue",
      ],
    );
    const scalarString = (value: unknown): string => {
      if (typeof value === "string") return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
      return "";
    };
    const toInboundMessage = makeToInboundMessage({
      ThreadType: { Group: "group" },
      buildEventMessage: () => undefined,
      extractMentionIds: () => [],
      normalizeMessageContent: (value: unknown) =>
        typeof value === "string"
          ? value
          : scalarString((value as Record<string, unknown> | null)?.title),
      resolveGroupNameFromMessageData: () => "Sales",
      resolveInboundTimestamp: () => Date.parse("2026-07-27T00:00:00.000Z"),
      stripLeadingAtMentionForCommand: (value: string) => value,
      stripOwnMentionsForCommandBody: (value: string) => value,
      toNonNegativeInteger: (value: unknown) => {
        const number = typeof value === "number" ? value : Number(value);
        return Number.isSafeInteger(number) && number >= 0 ? number : null;
      },
      toNumberId: scalarString,
      toStringValue: scalarString,
    });
    const exactQuotedId = "900719925474099312345678901";
    const serializedQuotedId = "9.00719925474099312345678901e+26";
    const providerBigNumber = Object.freeze({
      toFixed: () => exactQuotedId,
      toJSON: () => serializedQuotedId,
    });
    class ProviderMessage {
      readonly isSelf = false;
      readonly type = "group";
      readonly data = {
        actionId: "provider-action-1",
        content: {
          hdSize: "2048",
          m4aUrl: "https://provider.invalid/audio.m4a",
          stickerId: "sticker-1",
          title: "provider media",
        },
        dName: "Sale One",
        idTo: "sales-group-1",
        msgId: "message-1",
        msgType: "chat.sticker",
        quote: { globalMsgId: providerBigNumber },
        ts: 1,
        uidFrom: "sender-1",
      };
    }

    const produced = toInboundMessage(
      new ProviderMessage(),
      "own-user-1",
      "2026-07-27T00:00:01.000Z",
    ) as { bridge: ZaloUserInboundInputV1 };
    const envelope = buildZaloUserInboundEnvelopeV1(
      { cellId: "cell-a", organizationId: "organization-a", sessionGeneration: 7 },
      "account-a",
      produced.bridge,
    );

    expect(envelope).toMatchObject({
      eventKind: "MESSAGE",
      providerEventId: "provider-action-1",
      providerMessageId: "message-1",
      normalized: {
        replyToProviderMessageId: exactQuotedId,
        mediaManifest: [{
          byteLength: 2048,
          fetchRef: "https://provider.invalid/audio.m4a",
          kind: "STICKER",
          providerMediaId: "sticker-1",
        }],
      },
    });
    expect(Object.getPrototypeOf(envelope.rawEnvelope)).toBe(Object.prototype);
    expect(envelope.rawEnvelope).toMatchObject({
      data: { quote: { globalMsgId: serializedQuotedId } },
      type: "group",
    });
  });

  it("executes the patched event-kind matrix and every declared provider media URL", () => {
    const root = preparePatchedSource();
    const zaloJs = parse(root, "src/zalo-js.ts");
    const classify = compileFunctionSet(
      zaloJs,
      "classifyInboundEventKind",
      ["classifyInboundEventKind"],
      [],
    )({}) as (value: string) => string;
    expect([
      "chat.reaction",
      "message.delivered",
      "chat.seen",
      "typing",
      "member.join",
      "chat.photo",
      "provider.unknown",
    ].map(classify)).toEqual([
      "REACTION",
      "DELIVERY_RECEIPT",
      "SEEN",
      "TYPING",
      "MEMBERSHIP",
      "MESSAGE",
      "OTHER",
    ]);

    const extractMedia = compileFunctionSet(
      zaloJs,
      "extractInboundMediaInputs",
      [
        "classifyInboundMediaKind",
        "extractInboundMediaInputs",
        "firstProviderValue",
        "nullableProviderString",
        "providerScalarString",
      ],
      ["toNonNegativeInteger", "toStringValue"],
    )({
      toNonNegativeInteger: () => null,
      toStringValue: (value: unknown) => typeof value === "string" ? value : "",
    }) as (content: unknown, eventType: string) => Array<{
      fetchRef: string | null;
      providerMediaId: string | null;
    }>;
    for (const field of [
      "videoUrl",
      "voiceUrl",
      "m4aUrl",
      "rawUrl",
      "hdUrl",
      "normalUrl",
      "oriUrl",
      "thumbUrl",
    ]) {
      const expected = `https://provider.invalid/${field}`;
      expect(extractMedia({ [field]: expected }, "chat.file"), field).toMatchObject([
        { fetchRef: expected },
      ]);
    }

    expect(extractMedia({
      attachments: [{
        fileId: "file-1",
        fileUrl: "https://provider.invalid/file-1",
      }],
    }, "chat.file")).toMatchObject([{
      fetchRef: "https://provider.invalid/file-1",
      providerMediaId: "file-1",
    }]);
  });

  it("executes the actual monitor callback through strict bridge acknowledgement gating", async () => {
    const root = preparePatchedSource();
    const monitor = parse(root, "src/monitor.ts");
    const arrow = findObjectPropertyArrow(monitor, "monitorZalouserProvider", "onMessage");
    const makeCallback = compileCallback(monitor, arrow, [
      "stopped",
      "commitAndDispatchInbound",
      "account",
      "logVerbose",
      "core",
      "runtime",
      "statusSink",
      "resolveInboundQueueKey",
      "inboundQueue",
      "abortSignal",
      "processMessage",
      "config",
      "historyLimit",
      "groupHistories",
    ]);
    let resolveCommit!: (value: unknown) => void;
    const commit = new Promise<unknown>((resolveCommitPromise) => {
      resolveCommit = resolveCommitPromise;
    });
    const events: string[] = [];
    const dependencies = {
      stopped: false,
      commitAndDispatchInbound,
      account: { accountId: "account-a" },
      logVerbose: () => events.push("log"),
      core: {},
      runtime: { error: vi.fn() },
      statusSink: () => events.push("status"),
      resolveInboundQueueKey: () => "direct:peer-1",
      inboundQueue: {
        enqueue: async () => {
          events.push("queue");
        },
      },
      abortSignal: { aborted: false },
      processMessage: vi.fn(),
      config: {},
      historyLimit: 0,
      groupHistories: new Map(),
    };
    const callback = makeCallback(dependencies);
    const message = { bridge: BRIDGE_INPUT };
    const uninstallCommitted = installBridge(async () => {
      events.push("commit");
      return await commit;
    });

    const pending = callback(message) as Promise<void>;
    await vi.waitFor(() => expect(events).toEqual(["commit"]));
    expect(events).toEqual(["commit"]);
    resolveCommit(COMMITTED_ACK);
    await pending;
    await vi.waitFor(() => expect(events).toContain("queue"));
    expect(events).toEqual(["commit", "log", "status", "queue"]);
    uninstallCommitted();

    events.length = 0;
    const uninstallDuplicate = installBridge(async () => ({ status: "duplicate", version: 1 }));
    await callback(message);
    expect(events).toEqual([]);
    uninstallDuplicate();

    const deniedCases: Array<readonly [string, () => Promise<unknown>]> = [
      ["collision", async () => ({ status: "collision", version: 1 })],
      ["corrupt acknowledgement", async () => ({ status: "committed" })],
      ["bridge error", async () => { throw new Error("bridge error"); }],
      ["timeout", async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); }],
      ["ENOSPC", async () => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); }],
    ];
    for (const [label, committer] of deniedCases) {
      events.length = 0;
      const uninstallDenied = installBridge(committer);
      await expect(callback(message), label).rejects.toBeInstanceOf(Error);
      expect(events, label).toEqual([]);
      uninstallDenied();
    }
  });

  it("awaits bridge readiness before attaching the provider listener", () => {
    const root = preparePatchedSource();
    const monitorSource = readFileSync(resolve(root, "src/monitor.ts"), "utf8");
    const readinessIndex = monitorSource.indexOf("await ensureInboundBridgeReady(account.accountId)");
    const listenerIndex = monitorSource.indexOf("await startZaloListener({");

    expect(readinessIndex).toBeGreaterThanOrEqual(0);
    expect(listenerIndex).toBeGreaterThan(readinessIndex);
  });

  it("executes the actual void provider callback with synchronous receipt capture and failure routing", async () => {
    const root = preparePatchedSource();
    const zaloJs = parse(root, "src/zalo-js.ts");
    const arrow = findVariableArrow(zaloJs, "startZaloListener", "onMessage");
    const makeCallback = compileCallback(zaloJs, arrow, [
      "captureProviderCallbackReceivedAt",
      "toInboundMessage",
      "ownUserId",
      "params",
      "failListener",
    ]);
    const events: string[] = [];
    const failures: Error[] = [];
    let rejectListener!: (reason: unknown) => void;
    const listener = new Promise<never>((_resolve, reject) => {
      rejectListener = reject;
    });
    const callback = makeCallback({
      captureProviderCallbackReceivedAt: () => {
        events.push("capture");
        return "2026-07-27T00:00:01.000Z";
      },
      toInboundMessage: (_incoming: unknown, _ownUserId: unknown, callbackReceivedAt: string) => {
        events.push(`normalize:${callbackReceivedAt}`);
        return { bridge: { callbackReceivedAt } };
      },
      ownUserId: "own-user-1",
      params: {
        onMessage: () => {
          events.push("listener");
          return listener;
        },
      },
      failListener: (error: Error) => failures.push(error),
    });

    const result = callback({ isSelf: false });

    expect(result).toBeUndefined();
    expect(events).toEqual([
      "capture",
      "normalize:2026-07-27T00:00:01.000Z",
      "listener",
    ]);
    const failure = Object.assign(new Error("bridge ENOSPC"), { code: "ENOSPC" });
    rejectListener(failure);
    await vi.waitFor(() => expect(failures).toEqual([failure]));
  });

  it("routes synchronous provider normalization failure through failListener without escaping", () => {
    const root = preparePatchedSource();
    const zaloJs = parse(root, "src/zalo-js.ts");
    const arrow = findVariableArrow(zaloJs, "startZaloListener", "onMessage");
    const makeCallback = compileCallback(zaloJs, arrow, [
      "captureProviderCallbackReceivedAt",
      "toInboundMessage",
      "ownUserId",
      "params",
      "failListener",
    ]);
    const failure = new Error("provider envelope snapshot failed");
    const failures: Error[] = [];
    const onMessage = vi.fn();
    const callback = makeCallback({
      captureProviderCallbackReceivedAt: () => "2026-07-27T00:00:01.000Z",
      toInboundMessage: () => {
        throw failure;
      },
      ownUserId: "own-user-1",
      params: { onMessage },
      failListener: (error: Error) => failures.push(error),
    });

    expect(() => callback({ isSelf: false })).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
    expect(failures).toEqual([failure]);

    const listenerFailure = new Error("synchronous listener failure");
    const listenerCallback = makeCallback({
      captureProviderCallbackReceivedAt: () => "2026-07-27T00:00:01.000Z",
      toInboundMessage: () => ({ bridge: BRIDGE_INPUT }),
      ownUserId: "own-user-1",
      params: {
        onMessage: () => {
          throw listenerFailure;
        },
      },
      failListener: (error: Error) => failures.push(error),
    });
    expect(() => listenerCallback({ isSelf: false })).not.toThrow();
    expect(failures).toEqual([failure, listenerFailure]);
  });

  it("patches the provider evidence type and construction inputs while leaving the overlay authoritative", () => {
    const root = preparePatchedSource();
    const types = readFileSync(resolve(root, "src/types.ts"), "utf8");
    const zaloJs = readFileSync(resolve(root, "src/zalo-js.ts"), "utf8");

    expect(types).toContain("ZaloUserInboundInputV1");
    expect(types).toContain("bridge: ZaloUserInboundInputV1");
    expect(zaloJs).toContain("const providerEventId = nullableProviderString(data.actionId);");
    expect(zaloJs).toContain(
      'cliMsgId: typeof data.cliMsgId === "string" ? data.cliMsgId : undefined',
    );
    expect(zaloJs).not.toContain(
      "providerEventId = nullableProviderString(data.cliMsgId)",
    );
    for (const field of [
      "providerEventId",
      "providerMessageId",
      "providerConversationId",
      "providerSenderId",
      "providerTarget",
      "providerEventType",
      "sourceTimestamp",
      "callbackReceivedAt",
      "rawEnvelope",
      "normalized",
      "media",
      "actionId",
      "stickerId",
      "videoUrl",
      "voiceUrl",
      "m4aUrl",
      "rawUrl",
      "hdUrl",
      "normalUrl",
      "oriUrl",
      "thumbUrl",
      "hdSize",
    ]) {
      expect(zaloJs).toContain(field);
    }
  });
});
