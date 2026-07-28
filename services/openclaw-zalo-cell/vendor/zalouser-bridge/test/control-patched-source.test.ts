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
  const root = mkdtempSync(resolve(tmpdir(), "ihome-control-patched-source-"));
  temporaryRoots.push(root);
  cpSync(resolve(vendorRoot, "upstream/package"), root, { recursive: true });
  const series = readFileSync(resolve(vendorRoot, "patches/series"), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const patch of series) {
    execFileSync("git", ["apply", "--whitespace=nowarn", resolve(vendorRoot, "patches", patch)], {
      cwd: root,
      stdio: "pipe",
    });
  }
  return root;
}

function compileFunction(
  root: string,
  name: string,
  dependencyNames: readonly string[],
): (dependencies: Record<string, unknown>) => (...arguments_: unknown[]) => unknown {
  const path = resolve(root, "src/send.ts");
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`function ${name} was not found`);
  const dependencies = dependencyNames
    .map((dependency) => `const ${dependency} = injected.${dependency};`)
    .join("\n");
  const functionSource = declaration.getText(sourceFile).replace(/^export\s+/u, "");
  const source = `export function make(injected: any) {\n${dependencies}\n${functionSource}\nreturn ${name};\n}`;
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  if ((transpiled.diagnostics ?? []).length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(transpiled.diagnostics ?? [], {
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

const PROJECTED_SINK = Object.freeze({
  accountProfile: "projected-profile",
  conversationId: "projected-thread",
  isGroup: false,
});

const ORIGINAL_MESSAGE = Object.freeze({
  at: 0,
  cliMsgId: "original-cli",
  cmd: 0,
  idTo: "original-group",
  msgId: "original-message",
  msgType: "webchat",
  st: 0,
  ts: "1",
  uidFrom: "original-peer",
});

const PROJECTED_MESSAGE = Object.freeze({
  ...ORIGINAL_MESSAGE,
  cliMsgId: "projected-cli",
  idTo: "projected-thread",
  msgId: "projected-message",
});

describe("executable patched control source", () => {
  it("forwards only classifier-projected typing, seen, and delivery fields", async () => {
    const root = preparePatchedSource();
    const candidates: unknown[] = [];
    const classifyControlTraffic = (candidate: unknown) => {
      candidates.push(candidate);
      const kind = (candidate as { kind?: string }).kind;
      if (kind === "typing") return Object.freeze({ version: 1, kind, sink: PROJECTED_SINK });
      if (kind === "seen") {
        return Object.freeze({
          version: 1,
          kind,
          sink: PROJECTED_SINK,
          message: PROJECTED_MESSAGE,
        });
      }
      return Object.freeze({
        version: 1,
        kind: "delivery-receipt",
        sink: PROJECTED_SINK,
        message: PROJECTED_MESSAGE,
        isSeen: true,
      });
    };
    const sendZaloTypingEvent = vi.fn(async () => undefined);
    const sendZaloSeenEvent = vi.fn(async () => undefined);
    const sendZaloDeliveredEvent = vi.fn(async () => undefined);
    const sendTyping = compileFunction(root, "sendTypingZalouser", [
      "classifyControlTraffic",
      "sendZaloTypingEvent",
    ])({ classifyControlTraffic, sendZaloTypingEvent });
    const sendSeen = compileFunction(root, "sendSeenZalouser", [
      "classifyControlTraffic",
      "sendZaloSeenEvent",
    ])({ classifyControlTraffic, sendZaloSeenEvent });
    const sendDelivered = compileFunction(root, "sendDeliveredZalouser", [
      "classifyControlTraffic",
      "sendZaloDeliveredEvent",
    ])({ classifyControlTraffic, sendZaloDeliveredEvent });

    await sendTyping("original-thread", { profile: " original-profile ", isGroup: true });
    await sendSeen({
      profile: " original-profile ",
      isGroup: true,
      message: ORIGINAL_MESSAGE,
    });
    await sendDelivered({
      profile: " original-profile ",
      isGroup: true,
      message: ORIGINAL_MESSAGE,
      isSeen: false,
    });

    expect(candidates).toEqual([
      {
        version: 1,
        kind: "typing",
        sink: {
          accountProfile: "original-profile",
          conversationId: "original-thread",
          isGroup: true,
        },
      },
      {
        version: 1,
        kind: "seen",
        sink: {
          accountProfile: "original-profile",
          conversationId: "original-group",
          isGroup: true,
        },
        message: ORIGINAL_MESSAGE,
      },
      {
        version: 1,
        kind: "delivery-receipt",
        sink: {
          accountProfile: "original-profile",
          conversationId: "original-group",
          isGroup: true,
        },
        message: ORIGINAL_MESSAGE,
        isSeen: false,
      },
    ]);
    expect(sendZaloTypingEvent).toHaveBeenCalledWith("projected-thread", {
      profile: "projected-profile",
      isGroup: false,
    });
    expect(sendZaloSeenEvent).toHaveBeenCalledWith({
      profile: "projected-profile",
      isGroup: false,
      message: PROJECTED_MESSAGE,
    });
    expect(sendZaloDeliveredEvent).toHaveBeenCalledWith({
      profile: "projected-profile",
      isGroup: false,
      message: PROJECTED_MESSAGE,
      isSeen: true,
    });
  });
});
