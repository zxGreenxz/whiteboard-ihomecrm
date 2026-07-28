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
  const root = mkdtempSync(resolve(tmpdir(), "ihome-outbound-patched-source-"));
  temporaryRoots.push(root);
  cpSync(resolve(vendorRoot, "upstream/package"), root, { recursive: true });
  for (const patch of readFileSync(resolve(vendorRoot, "patches/series"), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)) {
    execFileSync("git", ["apply", "--whitespace=nowarn", resolve(vendorRoot, "patches", patch)], {
      cwd: root,
      stdio: "pipe",
    });
  }
  return root;
}

function declaration(root: string, relativePath: string, name: string): string {
  const path = resolve(root, relativePath);
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!found) throw new Error(`function ${name} was not found in ${relativePath}`);
  return found.getText(sourceFile).replace(/^export\s+/u, "");
}

function compileFunction(
  root: string,
  relativePath: string,
  name: string,
  dependencyNames: readonly string[],
): (dependencies: Record<string, unknown>) => (...arguments_: unknown[]) => unknown {
  const dependencies = dependencyNames
    .map((dependency) => `const ${dependency} = injected.${dependency};`)
    .join("\n");
  const source = `export function make(injected: any) {\n${dependencies}\n${declaration(root, relativePath, name)}\nreturn ${name};\n}`;
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
  new Function("module", "exports", transpiled.outputText)(module, module.exports);
  return module.exports.make as (
    dependencies: Record<string, unknown>,
  ) => (...arguments_: unknown[]) => unknown;
}

const SINK = Object.freeze({
  accountId: "account-a",
  accountProfile: "profile-a",
  conversationId: "thread-a",
  isGroup: true,
});

function privateFailure(): never {
  throw Object.assign(new Error("business sends require the private bridge RPC"), {
    code: "PRIVATE_RPC_REQUIRED",
  });
}

describe("executable patched outbound source", () => {
  it("routes exact prepared text, media, link, and reaction calls through one wrapper", async () => {
    const root = preparePatchedSource();
    const events: string[] = [];
    const media = Object.freeze({
      buffer: Buffer.from("prepared-media"),
      contentType: "image/png",
      fileName: "image.png",
      kind: "image",
    });
    const dependencies = {
      assertAuthorizedProviderCall: vi.fn(() => events.push("wrapper")),
      loadAndVerifyPreparedMedia: vi.fn(async () => {
        events.push("media-ready");
        return media;
      }),
      sendZaloTextMessage: vi.fn(async () => {
        events.push("text-provider");
        return { ok: true, messageId: "text-id" };
      }),
      sendZaloPreparedMediaMessage: vi.fn(async () => {
        events.push("media-provider");
        return { ok: true, messageId: "media-id" };
      }),
      sendZaloLink: vi.fn(async () => {
        events.push("link-provider");
        return { ok: true, messageId: "link-id" };
      }),
      sendZaloReaction: vi.fn(async () => {
        events.push("reaction-provider");
        return { ok: true };
      }),
    };
    const sendPrepared = compileFunction(root, "src/send.ts", "sendPreparedProviderCallZalouser", [
      "assertAuthorizedProviderCall",
      "loadAndVerifyPreparedMedia",
      "sendZaloTextMessage",
      "sendZaloPreparedMediaMessage",
      "sendZaloLink",
      "sendZaloReaction",
    ])(dependencies);
    const frames = [
      { kind: "text", text: "hello" },
      {
        kind: "media",
        url: "https://media.invalid/image.png",
        caption: "caption",
        byteLength: media.buffer.length,
        contentType: media.contentType,
        name: media.fileName,
        sha256: "a".repeat(64),
      },
      { kind: "link", url: "https://example.invalid", caption: "link" },
      { kind: "reaction", msgId: "msg-1", cliMsgId: "cli-1", emoji: "heart", remove: false },
    ] as const;

    const receipts = [];
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      receipts.push(await sendPrepared({ frameIndex, sink: SINK, frame: frames[frameIndex] }));
    }

    expect(receipts).toEqual([
      { providerMessageId: "text-id" },
      { providerMessageId: "media-id" },
      { providerMessageId: "link-id" },
      {},
    ]);
    expect(events).toEqual([
      "wrapper", "text-provider",
      "wrapper", "media-ready", "media-provider",
      "wrapper", "link-provider",
      "wrapper", "reaction-provider",
    ]);
    expect(dependencies.sendZaloTextMessage).toHaveBeenCalledWith(
      SINK.conversationId,
      "hello",
      { profile: SINK.accountProfile, isGroup: true },
      SINK,
    );
    expect(dependencies.sendZaloPreparedMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ frameIndex: 1, sink: SINK, frame: frames[1] }),
      media,
    );
    expect(dependencies.sendZaloLink).toHaveBeenCalledWith(
      SINK.conversationId,
      frames[2].url,
      { profile: SINK.accountProfile, isGroup: true, caption: frames[2].caption },
      SINK,
    );
    expect(dependencies.sendZaloReaction).toHaveBeenCalledWith({
      profile: SINK.accountProfile,
      threadId: SINK.conversationId,
      isGroup: true,
      msgId: frames[3].msgId,
      cliMsgId: frames[3].cliMsgId,
      emoji: frames[3].emoji,
      remove: false,
    }, SINK);
  });

  it("denies every public send.ts business export without touching a provider", async () => {
    const root = preparePatchedSource();
    for (const [name, arguments_] of [
      ["sendMessageZalouser", ["thread", "text", {}]],
      ["sendImageZalouser", ["thread", "https://media.invalid/a.png", {}]],
      ["sendLinkZalouser", ["thread", "https://example.invalid", {}]],
      ["sendReactionZalouser", [{ threadId: "thread", msgId: "m", cliMsgId: "c", emoji: "x" }]],
    ] as const) {
      const send = compileFunction(root, "src/send.ts", name, ["privateRpcRequired"])(
        { privateRpcRequired: privateFailure },
      );
      await expect(Promise.resolve().then(() => send(...arguments_))).rejects.toMatchObject({
        code: "PRIVATE_RPC_REQUIRED",
      });
    }
  });

  it("denies direct zalo-js business entry before any provider boundary", () => {
    const root = preparePatchedSource();
    const assertAuthorizedProviderIo = vi.fn(() => privateFailure());
    const bindProviderSink = compileFunction(root, "src/zalo-js.ts", "bindProviderSink", [
      "assertAuthorizedProviderIo",
      "normalizeProfile",
      "providerSinkMismatch",
    ])({
      assertAuthorizedProviderIo,
      normalizeProfile: (profile?: string | null) => profile?.trim() || "default",
      providerSinkMismatch: (message: string) => {
        throw Object.assign(new Error(message), { code: "AUTHORIZED_PROVIDER_SINK_MISMATCH" });
      },
    });

    expect(() => bindProviderSink(undefined, {
      profile: "profile-a",
      conversationId: "thread-a",
      isGroup: true,
    })).toThrowError(expect.objectContaining({ code: "PRIVATE_RPC_REQUIRED" }));
    expect(assertAuthorizedProviderIo).toHaveBeenCalledTimes(1);

    for (const name of [
      "sendZaloTextMessage",
      "sendZaloPreparedMediaMessage",
      "sendZaloReaction",
      "sendZaloLink",
    ]) {
      const body = declaration(root, "src/zalo-js.ts", name);
      expect(body).toContain("assertAuthorizedProviderIo");
    }
    const mediaBody = declaration(root, "src/zalo-js.ts", "sendZaloPreparedMediaMessage");
    expect(mediaBody.indexOf("assertAuthorizedProviderIo")).toBeLessThan(
      mediaBody.indexOf("withZaloApi"),
    );
  });

  it("preserves exactly 2000 Unicode code points and rejects 2001 before provider I/O", () => {
    const root = preparePatchedSource();
    const exactProviderText = compileFunction(root, "src/zalo-js.ts", "exactProviderText", [])({});
    const exact = "😀".repeat(2_000);
    expect(exactProviderText(exact)).toBe(exact);
    expect(() => exactProviderText(`${exact}😀`)).toThrowError(
      expect.objectContaining({ code: "INVALID_PROVIDER_FRAME" }),
    );
    const sendText = declaration(root, "src/zalo-js.ts", "sendZaloTextMessage");
    expect(sendText.indexOf("exactProviderText")).toBeLessThan(
      sendText.indexOf("assertAuthorizedProviderIo"),
    );
  });

  it("executes adapter, monitor, tool, pairing, and reaction bypass guards", async () => {
    const root = preparePatchedSource();
    for (const [path, name, argument] of [
      ["src/channel.adapters.ts", "sendZalouserTextFromContext", {}],
      ["src/channel.adapters.ts", "sendZalouserMediaFromContext", {}],
      ["src/monitor.ts", "deliverZalouserReply", {}],
    ] as const) {
      const guarded = compileFunction(root, path, name, ["privateRpcRequired"])(
        { privateRpcRequired: privateFailure },
      );
      await expect(Promise.resolve().then(() => guarded(argument))).rejects.toMatchObject({
        code: "PRIVATE_RPC_REQUIRED",
      });
    }

    const executeTool = compileFunction(root, "src/tool.ts", "executeZalouserTool", [
      "privateRpcRequired",
      "json",
      "formatErrorMessage",
    ])({
      privateRpcRequired: privateFailure,
      json: (value: unknown) => value,
      formatErrorMessage: (error: unknown) =>
        error && typeof error === "object" && "code" in error ? String(error.code) : String(error),
    });
    await expect(executeTool("call", { action: "send" })).resolves.toEqual({
      error: "PRIVATE_RPC_REQUIRED",
    });

    const adapters = readFileSync(resolve(root, "src/channel.adapters.ts"), "utf8");
    const monitor = readFileSync(resolve(root, "src/monitor.ts"), "utf8");
    expect(adapters).toMatch(/handleAction[\s\S]*?privateRpcRequired\(\)[\s\S]*?sendReactionZalouser/u);
    expect(adapters).toMatch(/notify:\s*async[\s\S]*?privateRpcRequired\(\)[\s\S]*?sendMessageZalouser/u);
    expect(monitor).toMatch(/sendPairingReply:\s*async[\s\S]*?privateRpcRequired\(\)[\s\S]*?sendMessageZalouser/u);
  });

  it("accounts for every patched business provider call behind an I/O assertion", () => {
    const root = preparePatchedSource();
    const path = resolve(root, "src/zalo-js.ts");
    const sourceText = readFileSync(path, "utf8");
    const sourceFile = ts.createSourceFile(
      path,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const businessMethods = new Set(["sendMessage", "uploadAttachment", "sendVoice", "addReaction", "sendLink"]);
    const inventory: Array<{ method: string; owner: string }> = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "api" &&
        businessMethods.has(node.expression.name.text)
      ) {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
        const functionName = ts.isFunctionDeclaration(owner) ? owner.name?.text : undefined;
        if (!functionName) throw new Error(`provider call ${node.expression.name.text} has no owner`);
        const ownerText = owner.getText(sourceFile);
        expect(ownerText.indexOf("assertAuthorizedProviderIo")).toBeGreaterThanOrEqual(0);
        expect(ownerText.indexOf("assertAuthorizedProviderIo")).toBeLessThan(
          ownerText.indexOf(`api.${node.expression.name.text}`),
        );
        inventory.push({ method: node.expression.name.text, owner: functionName });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    expect(inventory).toEqual([
      { method: "sendMessage", owner: "sendZaloTextMessage" },
      { method: "uploadAttachment", owner: "sendZaloTextMessage" },
      { method: "sendVoice", owner: "sendZaloTextMessage" },
      { method: "sendMessage", owner: "sendZaloTextMessage" },
      { method: "sendMessage", owner: "sendZaloTextMessage" },
      { method: "sendMessage", owner: "sendZaloPreparedMediaMessage" },
      { method: "uploadAttachment", owner: "sendZaloPreparedMediaMessage" },
      { method: "sendVoice", owner: "sendZaloPreparedMediaMessage" },
      { method: "sendMessage", owner: "sendZaloPreparedMediaMessage" },
      { method: "addReaction", owner: "sendZaloReaction" },
      { method: "sendLink", owner: "sendZaloLink" },
    ]);
  });
});
