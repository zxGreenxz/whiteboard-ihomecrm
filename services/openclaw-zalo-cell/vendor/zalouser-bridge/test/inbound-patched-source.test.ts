import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const vendorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

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

function parse(root: string, path: string): ts.SourceFile {
  const source = readFileSync(resolve(root, path), "utf8");
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe("executable patched inbound source", () => {
  it("executes the actual monitor callback with zero queueing before commit and no duplicate dispatch", async () => {
    const root = preparePatchedSource();
    const monitor = parse(root, "src/monitor.ts");
    const arrow = findObjectPropertyArrow(monitor, "monitorZalouserProvider", "onMessage");
    const makeCallback = compileCallback(monitor, arrow, [
      "stopped",
      "commitInboundThroughBridge",
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
    const commitInputs: unknown[] = [];
    const dependencies = {
      stopped: false,
      commitInboundThroughBridge: async (_accountId: string, evidence: unknown) => {
        events.push("commit");
        commitInputs.push(evidence);
        return await commit;
      },
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
    const message = { bridge: { providerEventId: "event-1" } };

    const pending = callback(message) as Promise<void>;
    await vi.waitFor(() => expect(events).toEqual(["commit"]));
    expect(commitInputs).toEqual([message.bridge]);
    expect(events).toEqual(["commit"]);
    resolveCommit({ envelope: {}, status: "committed" });
    await pending;
    await vi.waitFor(() => expect(events).toContain("queue"));
    expect(events).toEqual(["commit", "log", "status", "queue"]);

    events.length = 0;
    const duplicateCallback = makeCallback({
      ...dependencies,
      commitInboundThroughBridge: async () => ({ envelope: {}, status: "duplicate" }),
    });
    await duplicateCallback(message);
    await Promise.resolve();
    expect(events).toEqual([]);
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

  it("patches the provider evidence type and construction inputs while leaving the overlay authoritative", () => {
    const root = preparePatchedSource();
    const types = readFileSync(resolve(root, "src/types.ts"), "utf8");
    const zaloJs = readFileSync(resolve(root, "src/zalo-js.ts"), "utf8");

    expect(types).toContain("ZaloUserInboundInputV1");
    expect(types).toContain("bridge: ZaloUserInboundInputV1");
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
    ]) {
      expect(zaloJs).toContain(field);
    }
  });
});
