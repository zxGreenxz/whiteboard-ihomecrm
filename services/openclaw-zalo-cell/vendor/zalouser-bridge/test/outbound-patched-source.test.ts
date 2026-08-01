import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  it("installs the production bridge composition root before registering the private RPC", () => {
    const root = preparePatchedSource();
    const indexSource = readFileSync(resolve(root, "index.ts"), "utf8");
    const installIndex = indexSource.indexOf("installProductionBridgeRuntimeFromEnvironment()");
    const registerIndex = indexSource.indexOf("registerPrivateOutboundRpc(api, \"zalouser.bridge.send\")");

    expect(indexSource).toContain("./src/bridge/runtime-bootstrap.js");
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(registerIndex).toBeGreaterThan(installIndex);
  });

  it("routes only text and pre-materialized verified media through the provider wrapper", async () => {
    const root = preparePatchedSource();
    const events: string[] = [];
    const media = Buffer.from("prepared-media");
    const preparedSession = Object.freeze({ accountProfile: SINK.accountProfile });
    const dependencies = {
      assertAuthorizedProviderCall: vi.fn(() => events.push("wrapper")),
      verifyMaterializedMedia: vi.fn((_frame: unknown, candidate: Buffer | undefined) => {
        events.push("media-verified");
        if (!candidate) throw new Error("materialized media missing");
        return candidate;
      }),
      loadAndVerifyPreparedMedia: vi.fn(async () => {
        events.push("late-media-load");
        return {
          buffer: media,
          contentType: "image/png",
          fileName: "image.png",
          kind: "image",
        };
      }),
      sendZaloTextMessage: vi.fn(async () => {
        events.push("text-provider");
        return { ok: true, messageId: "text-id" };
      }),
      sendZaloPreparedMediaMessage: vi.fn(async () => {
        events.push("media-provider");
        return { ok: true, messageId: "media-id" };
      }),
      sendZaloLink: vi.fn(),
      sendZaloReaction: vi.fn(),
      unsupportedBusinessPart: vi.fn(() => {
        throw Object.assign(new Error("only text and media are supported"), {
          code: "UNSUPPORTED_BUSINESS_PART",
        });
      }),
    };
    const sendPrepared = compileFunction(root, "src/send.ts", "sendPreparedProviderCallZalouser", [
      "assertAuthorizedProviderCall",
      "verifyMaterializedMedia",
      "loadAndVerifyPreparedMedia",
      "sendZaloTextMessage",
      "sendZaloPreparedMediaMessage",
      "sendZaloLink",
      "sendZaloReaction",
      "unsupportedBusinessPart",
    ])(dependencies);
    const frames = [
      { kind: "text", text: "hello" },
      {
        kind: "media",
        objectKey: "organization-a/account-a/outbox-a/image.png",
        caption: "caption",
        byteLength: media.length,
        contentType: "image/png",
        sha256: createHash("sha256").update(media).digest("hex"),
      },
    ] as const;

    const receipts = [
      await sendPrepared({ frameIndex: 0, sink: SINK, frame: frames[0] }, undefined, preparedSession),
      await sendPrepared({ frameIndex: 1, sink: SINK, frame: frames[1] }, media, preparedSession),
    ];

    expect(receipts).toEqual([
      { providerMessageId: "text-id" },
      { providerMessageId: "media-id" },
    ]);
    expect(events).toEqual([
      "wrapper", "text-provider",
      "media-verified", "wrapper", "media-provider",
    ]);
    expect(dependencies.sendZaloTextMessage).toHaveBeenCalledWith(
      SINK.conversationId,
      "hello",
      { profile: SINK.accountProfile, isGroup: true },
      SINK,
      preparedSession,
    );
    expect(dependencies.sendZaloPreparedMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ frameIndex: 1, sink: SINK, frame: frames[1] }),
      media,
      preparedSession,
    );
    expect(dependencies.loadAndVerifyPreparedMedia).not.toHaveBeenCalled();
    expect(dependencies.sendZaloLink).not.toHaveBeenCalled();
    expect(dependencies.sendZaloReaction).not.toHaveBeenCalled();

    const wrapperBody = declaration(root, "src/send.ts", "sendPreparedProviderCallZalouser");
    const mediaBody = declaration(root, "src/zalo-js.ts", "sendZaloPreparedMediaMessage");
    expect(wrapperBody).not.toContain("loadAndVerifyPreparedMedia");
    expect(mediaBody).not.toContain("loadOutboundMediaFromUrl");
    expect(mediaBody).not.toContain("frame.url");
  });

  it("prepares only an already-ready provider session without restoring it", () => {
    const root = preparePatchedSource();
    const api = Object.freeze({ id: "api-a" });
    const apiByProfile = new Map<string, unknown>([["profile-a", api]]);
    const preparedApiBySession = new WeakMap<object, unknown>();
    const prepareSession = compileFunction(root, "src/zalo-js.ts", "prepareZaloProviderSession", [
      "apiByProfile",
      "normalizeProfile",
      "preparedApiBySession",
    ])({
      apiByProfile,
      normalizeProfile: (profile: string) => profile.trim(),
      preparedApiBySession,
    });

    const session = prepareSession(" profile-a ");

    expect(session).toEqual({ accountProfile: "profile-a" });
    expect(Object.isFrozen(session)).toBe(true);
    expect(preparedApiBySession.get(session as object)).toBe(api);
    expect(() => prepareSession("cold-profile")).toThrow(expect.objectContaining({
      code: "PROVIDER_SESSION_NOT_READY",
    }));
  });

  it("installs one identity-bound offline provider fixture only when the probe gate is enabled", () => {
    const root = preparePatchedSource();
    const apiByProfile = new Map<string, unknown>();
    const apiInitByProfile = new Map<string, Promise<unknown>>();
    const installFixture = compileFunction(
      root,
      "src/zalo-js.ts",
      "installZaloBehaviorProbeProviderV1",
      ["apiByProfile", "apiInitByProfile", "normalizeProfile"],
    )({
      apiByProfile,
      apiInitByProfile,
      normalizeProfile: (profile: string) => profile.trim(),
    });
    const fixture = Object.freeze({
      getContext: vi.fn(),
      getCookie: vi.fn(),
      sendMessage: vi.fn(),
      uploadAttachment: vi.fn(),
      sendVoice: vi.fn(),
      sendTypingEvent: vi.fn(),
    });
    const previous = process.env.IHOME_BEHAVIOR_PROBE;
    try {
      delete process.env.IHOME_BEHAVIOR_PROBE;
      expect(() => installFixture("profile-a", fixture)).toThrow(expect.objectContaining({
        code: "BEHAVIOR_PROBE_DISABLED",
      }));

      process.env.IHOME_BEHAVIOR_PROBE = "1";
      const cleanup = installFixture(" profile-a ", fixture) as () => void;
      expect(apiByProfile.get("profile-a")).toBe(fixture);
      expect(() => installFixture("profile-a", fixture)).toThrow(expect.objectContaining({
        code: "BEHAVIOR_PROBE_PROFILE_OCCUPIED",
      }));

      cleanup();
      cleanup();
      expect(apiByProfile.has("profile-a")).toBe(false);

      const secondCleanup = installFixture("profile-a", fixture) as () => void;
      const replacement = Object.freeze({ id: "replacement" });
      apiByProfile.set("profile-a", replacement);
      secondCleanup();
      expect(apiByProfile.get("profile-a")).toBe(replacement);
    } finally {
      if (previous === undefined) delete process.env.IHOME_BEHAVIOR_PROBE;
      else process.env.IHOME_BEHAVIOR_PROBE = previous;
    }
  });

  it("enters the provider operation without awaiting session restoration after authorization", async () => {
    const root = preparePatchedSource();
    const events: string[] = [];
    const api = Object.freeze({ id: "api-a" });
    const session = Object.freeze({ accountProfile: "profile-a" });
    const ensureApi = vi.fn(async () => {
      throw new Error("session restoration must not run after authorization");
    });
    const withZaloApi = compileFunction(root, "src/zalo-js.ts", "withZaloApi", [
      "ensureApi",
      "normalizeProfile",
      "persistApiCredentialsIfChanged",
      "preparedApiForSession",
    ])({
      ensureApi,
      normalizeProfile: (profile: string) => profile.trim(),
      persistApiCredentialsIfChanged: vi.fn(() => events.push("persist")),
      preparedApiForSession: vi.fn(() => {
        events.push("prepared-api");
        return api;
      }),
    });

    const result = await withZaloApi(
      "profile-a",
      async (receivedApi: unknown) => {
        events.push("provider-call");
        expect(receivedApi).toBe(api);
        return "sent";
      },
      { preparedSession: session },
    );

    expect(result).toBe("sent");
    expect(ensureApi).not.toHaveBeenCalled();
    expect(events).toEqual(["prepared-api", "provider-call", "persist"]);
  });

  it.each([
    {
      label: "link",
      frame: { kind: "link", url: "https://example.invalid", caption: "link" },
    },
    {
      label: "reaction",
      frame: { kind: "reaction", msgId: "msg-1", cliMsgId: "cli-1", emoji: "heart", remove: false },
    },
    {
      label: "URL media",
      frame: {
        kind: "media",
        url: "https://media.invalid/image.png",
        caption: null,
        byteLength: 1,
        contentType: "image/png",
        name: "image.png",
        sha256: "a".repeat(64),
      },
    },
  ])("denies $label before authorization or provider I/O", async ({ frame }) => {
    const root = preparePatchedSource();
    const dependencies = {
      assertAuthorizedProviderCall: vi.fn(),
      verifyMaterializedMedia: vi.fn(),
      loadAndVerifyPreparedMedia: vi.fn(),
      sendZaloTextMessage: vi.fn(),
      sendZaloPreparedMediaMessage: vi.fn(),
      sendZaloLink: vi.fn(),
      sendZaloReaction: vi.fn(),
      unsupportedBusinessPart: vi.fn(() => {
        throw Object.assign(new Error("only text and media are supported"), {
          code: "UNSUPPORTED_BUSINESS_PART",
        });
      }),
    };
    const sendPrepared = compileFunction(root, "src/send.ts", "sendPreparedProviderCallZalouser", [
      "assertAuthorizedProviderCall",
      "verifyMaterializedMedia",
      "loadAndVerifyPreparedMedia",
      "sendZaloTextMessage",
      "sendZaloPreparedMediaMessage",
      "sendZaloLink",
      "sendZaloReaction",
      "unsupportedBusinessPart",
    ])(dependencies);

    await expect(sendPrepared({ frameIndex: 0, sink: SINK, frame })).rejects.toMatchObject({
      code: "UNSUPPORTED_BUSINESS_PART",
    });
    expect(dependencies.unsupportedBusinessPart).toHaveBeenCalledTimes(1);
    expect(dependencies.assertAuthorizedProviderCall).not.toHaveBeenCalled();
    expect(dependencies.sendZaloTextMessage).not.toHaveBeenCalled();
    expect(dependencies.sendZaloPreparedMediaMessage).not.toHaveBeenCalled();
    expect(dependencies.sendZaloLink).not.toHaveBeenCalled();
    expect(dependencies.sendZaloReaction).not.toHaveBeenCalled();
  });

  it("verifies materialized length and SHA-256 before the wrapper authorization check", () => {
    const root = preparePatchedSource();
    const verifier = compileFunction(root, "src/send.ts", "verifyMaterializedMedia", [
      "createHash",
      "preparedMediaMismatch",
    ])({
      createHash,
      preparedMediaMismatch: (message: string) => {
        throw Object.assign(new Error(message), { code: "PREPARED_MEDIA_MISMATCH" });
      },
    });
    const media = Buffer.from("verified-media");
    const frame = {
      kind: "media",
      objectKey: "organization-a/account-a/outbox-a/verified.png",
      byteLength: media.length,
      contentType: "image/png",
      sha256: createHash("sha256").update(media).digest("hex"),
    };

    expect(verifier(frame, media)).toBe(media);
    expect(() => verifier({ ...frame, byteLength: media.length + 1 }, media)).toThrowError(
      expect.objectContaining({ code: "PREPARED_MEDIA_MISMATCH" }),
    );
    expect(() => verifier({ ...frame, sha256: "0".repeat(64) }, media)).toThrowError(
      expect.objectContaining({ code: "PREPARED_MEDIA_MISMATCH" }),
    );
  });

  it("omits an absent provider message ID from the receipt", async () => {
    const root = preparePatchedSource();
    const sendPrepared = compileFunction(root, "src/send.ts", "sendPreparedProviderCallZalouser", [
      "assertAuthorizedProviderCall",
      "verifyMaterializedMedia",
      "preparedMediaMismatch",
      "sendZaloTextMessage",
      "sendZaloPreparedMediaMessage",
      "unsupportedBusinessPart",
    ])({
      assertAuthorizedProviderCall: vi.fn(),
      verifyMaterializedMedia: vi.fn(),
      preparedMediaMismatch: vi.fn(),
      sendZaloTextMessage: vi.fn(async () => ({ ok: true })),
      sendZaloPreparedMediaMessage: vi.fn(),
      unsupportedBusinessPart: vi.fn(),
    });

    const receipt = await sendPrepared({
      frameIndex: 0,
      sink: SINK,
      frame: { kind: "text", text: "hello" },
    });
    expect(receipt).toEqual({});
    expect(Object.keys(receipt as object)).toEqual([]);
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
    const textBody = declaration(root, "src/zalo-js.ts", "sendZaloTextMessage");
    const mediaBody = declaration(root, "src/zalo-js.ts", "sendZaloPreparedMediaMessage");
    const reactionBody = declaration(root, "src/zalo-js.ts", "sendZaloReaction");
    const linkBody = declaration(root, "src/zalo-js.ts", "sendZaloLink");
    expect(textBody).not.toContain("loadOutboundMediaFromUrl");
    expect(textBody).toMatch(
      /assertAuthorizedProviderIo\(sink\);\s*const response = await api\.sendMessage/u,
    );
    expect(mediaBody.indexOf("withZaloApi")).toBeLessThan(
      mediaBody.indexOf("assertAuthorizedProviderIo"),
    );
    expect(mediaBody).toMatch(
      /assertAuthorizedProviderIo\(sink\);\s*const uploaded = await api\.uploadAttachment/u,
    );
    expect(mediaBody).toMatch(
      /assertAuthorizedProviderIo\(sink\);\s*const response = await api\.sendMessage/u,
    );
    expect(reactionBody).toMatch(
      /assertAuthorizedProviderIo\(sink\);\s*await api\.addReaction/u,
    );
    expect(linkBody).toMatch(
      /assertAuthorizedProviderIo\(sink\);\s*const response = await api\.sendLink/u,
    );
  });

  it("rethrows internally proven pre-handoff failures before provider error normalization", () => {
    const root = preparePatchedSource();
    const source = readFileSync(resolve(root, "src/zalo-js.ts"), "utf8");
    const textBody = declaration(root, "src/zalo-js.ts", "sendZaloTextMessage");
    const mediaBody = declaration(root, "src/zalo-js.ts", "sendZaloPreparedMediaMessage");

    expect(source).toContain("isProvenPreHandoffFailure");
    for (const body of [textBody, mediaBody]) {
      expect(body).toMatch(
        /catch \(error\) \{\s*if \(isProvenPreHandoffFailure\(error\)\) throw error;\s*return/u,
      );
    }
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
      { method: "uploadAttachment", owner: "sendZaloPreparedMediaMessage" },
      { method: "sendVoice", owner: "sendZaloPreparedMediaMessage" },
      { method: "sendMessage", owner: "sendZaloPreparedMediaMessage" },
      { method: "addReaction", owner: "sendZaloReaction" },
      { method: "sendLink", owner: "sendZaloLink" },
    ]);
  });
});
