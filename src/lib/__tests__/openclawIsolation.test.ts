import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanOpenClawFiles } from "../../../scripts/check-openclaw-isolation.mjs";

const fixtureRoots: string[] = [];
const scannerPath = resolve("scripts/check-openclaw-isolation.mjs");

const ignoredOpenClawPaths = [
  "infra/openclaw-zalo/.env",
  "infra/openclaw-zalo/secrets/",
  "infra/openclaw-zalo/rendered/",
  "infra/openclaw-media-gateway/.dev.vars",
  "infra/openclaw-media-gateway/.wrangler/",
  "services/openclaw-zalo-bridge/.data/",
  "services/openclaw-zalo-bridge/coverage/",
  "services/openclaw-zalo-cell/.state/",
  "services/openclaw-zalo-cell/.release/",
  "services/openclaw-zalo-cell/vendor/zalouser-bridge/.work/",
];

function makeFixture(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-isolation-"));
  fixtureRoots.push(root);

  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, source, "utf8");
  }

  return root;
}

function encodeUtf16Le(source: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")]);
}

function encodeUtf16Be(source: string): Buffer {
  const content = Buffer.from(source, "utf16le");
  for (let index = 0; index < content.length; index += 2) {
    [content[index], content[index + 1]] = [content[index + 1], content[index]];
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), content]);
}

afterEach(() => {
  while (fixtureRoots.length > 0) {
    rmSync(fixtureRoots.pop()!, { recursive: true, force: true });
  }
});

describe("OpenClaw Zalo isolation guardrail", () => {
  it("finds no forbidden references in the repository OpenClaw scopes", () => {
    expect(scanOpenClawFiles()).toEqual([]);
  });

  it("scans every isolated scope while allowing the canonical channel and approved fork seams", () => {
    const root = makeFixture({
      "src/lib/openclaw-zalo/types.ts": `export const channel = "zalouser";`,
      "services/openclaw-egress-broker/src/index.ts": `export const channel = "zalouser";`,
      "services/openclaw-zalo-cell/vendor/zalouser-bridge/src/send.ts": [
        `import "@openclaw/zalouser";`,
        `export const delivery = adapter.send(payload);`,
        `export const rpc = tool.execute("send", payload);`,
      ].join("\n"),
      "services/openclaw-zalo-cell/vendor/@openclaw/zalouser/index.js": `export const installed = true;`,
      "services/openclaw-zalo-cell/package.json": `{"dependencies":{"@openclaw/zalouser":"file:vendor/zalouser.tgz"}}`,
      "services/openclaw-zalo-bridge/src/adapters/zalouser-bridge-rpc-adapter.ts": [
        `import "@openclaw/zalouser";`,
        `export const delivery = adapter.send(payload);`,
        `export const rpc = tool.execute("send", payload);`,
      ].join("\n"),
      "services/openclaw-zalo-bridge/test/upstream-contract.test.ts": [
        `import "@openclaw/zalouser";`,
        `expect(adapter.send(payload)).toBeDefined();`,
      ].join("\n"),
      "services/openclaw-zalo-bridge/test/zalouser-bridge-rpc-adapter.test.ts": [
        `import "@openclaw/zalouser";`,
        `expect(tool.execute("send", payload)).toBeDefined();`,
      ].join("\n"),
      "infra/openclaw-zalo/config/runtime.env.example": `OPENCLAW_CHANNEL=zalouser`,
      "contracts/openclaw-zalo/runtime.schema.json": `{"channel":"zalouser"}`,
      "supabase/migrations/20260727010000_openclaw_catalog_foundation.sql": `create table openclaw_zalo_accounts;`,
      "supabase/functions/_shared/openclaw/constants.ts": `export const CHANNEL = "zalouser";`,
      "supabase/functions/openclaw-control/index.ts": `export const channel = "zalouser";`,
      "services/openclaw-zalo-bridge/src/classification.ts": `classificationTool.execute(payload);`,
      "infra/openclaw-zalo/secrets/runtime.env": `LEGACY_TABLE=zalo_ignored_secret`,
      "src/lib/legacy.ts": `const old = "zalo_legacy";`,
    });

    expect(scanOpenClawFiles(root)).toEqual([]);
  });

  it("reports legacy coupling, package bypasses, generic sends, direct delivery, and worker paths", () => {
    const root = makeFixture({
      "src/lib/openclaw-zalo/bad.ts": [
        `import "@openclaw/zalouser";`,
        `import "../chat-zalo/legacy";`,
        `const hook = "src/hooks/useZaloChat.ts";`,
      ].join("\n"),
      "services/openclaw-zalo-bridge/src/not-approved.ts": [
        `import "@openclaw/zalouser";`,
        `client.call("send", payload);`,
        `adapter.sendText(payload);`,
      ].join("\n"),
      "services/openclaw-zalo-bridge/package.json": `{"dependencies":{"@openclaw/zalouser":"2026.7.1"}}`,
      "services/openclaw-zalo-bridge/vendor/@openclaw/zalouser/index.js": `export const installed = true;`,
      "services/openclaw-zalo-bridge/src/quoted-rpc.ts": `const request = {"method":"send"};`,
      "services/openclaw-zalo-bridge/src/optional-adapter.ts": `adapter?.send(payload);`,
      "services/openclaw-zalo-bridge/src/bracket-tool.ts": `tool["execute"]("send", payload);`,
      "services/openclaw-zalo-bridge/src/secrets/not-generated.ts": `const table = "zalo_must_fail";`,
      "services/openclaw-zalo-bridge/test/not-a-contract.test.ts": [
        `import "@openclaw/zalouser";`,
        `client.call("send", payload);`,
        `adapter.send(payload);`,
      ].join("\n"),
      "services/openclaw-zalo-bridge/worker/queue.ts": `export const queue = true;`,
      "services/openclaw-egress-broker/src/legacy.sql": `select zalo_legacy from old_table;`,
      "infra/openclaw-zalo/config/chat.ts": `const route = "/chat-zalo";`,
      "contracts/openclaw-zalo/bad.schema.json": `{"hook":"useZaloChat"}`,
      "supabase/migrations/20260727010000_openclaw_catalog_foundation.sql": `create table zalo_legacy;`,
      "supabase/functions/openclaw-control/index.ts": `const path = "worker/queue";`,
    });

    const findings = scanOpenClawFiles(root);

    const expectFinding = (file: string, rule: string) => {
      expect(findings).toContainEqual(expect.objectContaining({ file, rule }));
    };

    expectFinding("src/lib/openclaw-zalo/bad.ts", "direct-zalouser-package");
    expectFinding("src/lib/openclaw-zalo/bad.ts", "legacy-chat-zalo-path");
    expectFinding("src/lib/openclaw-zalo/bad.ts", "legacy-use-zalo-chat");
    expectFinding("services/openclaw-zalo-bridge/src/not-approved.ts", "stock-generic-send");
    expectFinding(
      "services/openclaw-zalo-bridge/src/not-approved.ts",
      "direct-adapter-tool-delivery",
    );
    expectFinding("services/openclaw-zalo-bridge/package.json", "direct-zalouser-package");
    expectFinding(
      "services/openclaw-zalo-bridge/vendor/@openclaw/zalouser/index.js",
      "direct-zalouser-package",
    );
    expectFinding("services/openclaw-zalo-bridge/src/quoted-rpc.ts", "stock-generic-send");
    expectFinding(
      "services/openclaw-zalo-bridge/src/optional-adapter.ts",
      "direct-adapter-tool-delivery",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/src/bracket-tool.ts",
      "direct-adapter-tool-delivery",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/test/not-a-contract.test.ts",
      "direct-zalouser-package",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/test/not-a-contract.test.ts",
      "stock-generic-send",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/test/not-a-contract.test.ts",
      "direct-adapter-tool-delivery",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/src/secrets/not-generated.ts",
      "legacy-zalo-identifier",
    );
    expectFinding("services/openclaw-zalo-bridge/worker/queue.ts", "legacy-worker-path");
    expectFinding("services/openclaw-egress-broker/src/legacy.sql", "legacy-zalo-identifier");
    expectFinding("infra/openclaw-zalo/config/chat.ts", "legacy-chat-zalo-path");
    expectFinding("contracts/openclaw-zalo/bad.schema.json", "legacy-use-zalo-chat");
    expectFinding(
      "supabase/migrations/20260727010000_openclaw_catalog_foundation.sql",
      "legacy-zalo-identifier",
    );
    expectFinding("supabase/functions/openclaw-control/index.ts", "legacy-worker-path");
  });

  it("decodes static package strings and detects semantic delivery calls without control false positives", () => {
    const root = makeFixture({
      "services/openclaw-zalo-bridge/src/escaped-package.ts": String.raw`
        const direct = "@openclaw\u002fzalouser";
        const required = require("@openclaw\x2fzalouser");
        const dynamic = import("@openclaw/" + ("zalo" as string) + "user");
        const legacy = "zalo_\u006cegacy";
      `,
      "services/openclaw-zalo-bridge/package.json": String.raw`{"dependency":"@openclaw\/\u007aalouser"}`,
      "services/openclaw-zalo-bridge/src/rpc-bypasses.ts": `
        client /* boundary */ ?. ["call"]?.(("s" + "end"), payload);
        const request = { ["method"]: ("s" + "end") };
      `,
      "services/openclaw-zalo-bridge/src/delivery-aliases.ts": `
        transportSender.send(payload);
        upstreamProvider?.["send"](payload);
        arbitraryAlias["sendMedia"](payload);
        messageTool["execute"]("deliver", payload);
      `,
      "services/openclaw-zalo-bridge/src/static-templates.ts": [
        'import(`@openclaw/${"zalo"}user`);',
        'client.call(`${"se"}nd`, payload);',
      ].join("\n"),
      "services/openclaw-zalo-bridge/src/object-tool-delivery.ts": [
        `messageTool.execute({ action: "send", payload });`,
        'messageTool.execute({ ["action"]: `de${"liv"}er`, payload });',
      ].join("\n"),
      "services/openclaw-zalo-bridge/src/non-delivery-controls.ts": [
        `socket.send(payload);`,
        `classificationTool.execute(payload);`,
        `classificationTool.execute("classify", payload);`,
        `messageTool.execute({ action: "classify", payload });`,
        `messageTool.execute({ ["action"]: "status", payload });`,
        `const packageName = "zalo";`,
        'import(`@openclaw/${packageName}user`);',
        `const verb = "se";`,
        'client.call(`${verb}nd`, payload);',
        `statusReporter.report(payload);`,
      ].join("\n"),
    });

    const findings = scanOpenClawFiles(root);
    const expectFinding = (file: string, rule: string) => {
      expect(findings).toContainEqual(expect.objectContaining({ file, rule }));
    };

    expectFinding(
      "services/openclaw-zalo-bridge/src/escaped-package.ts",
      "direct-zalouser-package",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/src/escaped-package.ts",
      "legacy-zalo-identifier",
    );
    expectFinding("services/openclaw-zalo-bridge/package.json", "direct-zalouser-package");
    expectFinding("services/openclaw-zalo-bridge/src/rpc-bypasses.ts", "stock-generic-send");
    expectFinding(
      "services/openclaw-zalo-bridge/src/delivery-aliases.ts",
      "direct-adapter-tool-delivery",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/src/static-templates.ts",
      "direct-zalouser-package",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/src/static-templates.ts",
      "stock-generic-send",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/src/object-tool-delivery.ts",
      "direct-adapter-tool-delivery",
    );
    expect(
      findings.filter(
        (finding) =>
          finding.file === "services/openclaw-zalo-bridge/src/non-delivery-controls.ts",
      ),
    ).toEqual([]);
  });

  it("allows adversarial package and delivery forms only in the exact approved seams", () => {
    const approvedSource = [
      String.raw`import("@openclaw\u002fzalouser");`,
      'import(`@openclaw/${"zalo"}user`);',
      `client?.["call"]?.(("s" + "end"), payload);`,
      'client.call(`${"se"}nd`, payload);',
      `upstreamProvider?.["send"](payload);`,
      `messageTool["execute"]("deliver", payload);`,
      'messageTool.execute({ ["action"]: `se${"n"}d`, payload });',
    ].join("\n");
    const root = makeFixture({
      "services/openclaw-zalo-cell/src/adversarial.ts": approvedSource,
      "services/openclaw-zalo-bridge/src/adapters/zalouser-bridge-rpc-adapter.ts": approvedSource,
      "services/openclaw-zalo-bridge/test/upstream-contract.test.ts": approvedSource,
      "services/openclaw-zalo-bridge/test/zalouser-bridge-rpc-adapter.test.ts": approvedSource,
    });

    expect(scanOpenClawFiles(root)).toEqual([]);
  });

  it("rejects invalid roots instead of treating them as empty repositories", () => {
    const root = makeFixture({ "not-a-directory.txt": "fixture" });

    expect(() => scanOpenClawFiles(join(root, "missing"))).toThrow(/root.*does not exist/i);
    expect(() => scanOpenClawFiles(join(root, "not-a-directory.txt"))).toThrow(
      /root.*directory/i,
    );
  });

  it("decodes UTF-16 source and fails closed on parse errors or NUL source", () => {
    const root = makeFixture({
      "services/openclaw-zalo-bridge/src/utf16-le.ts": encodeUtf16Le(
        `const table = "zalo_utf16_le";`,
      ),
      "services/openclaw-zalo-bridge/src/utf16-be.ts": encodeUtf16Be(
        `const table = "zalo_utf16_be";`,
      ),
      "services/openclaw-zalo-bridge/src/utf8-bom.ts": Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(`const table = "zalo_utf8_bom";`),
      ]),
      "services/openclaw-zalo-bridge/src/parse-error.ts": `
        const table = "zalo_parse_error";
        const broken = ;
      `,
      "services/openclaw-zalo-bridge/src/nul-source.ts": Buffer.from([
        ...Buffer.from(`const table = "zalo_before_nul";`),
        0,
        ...Buffer.from(`const tail = true;`),
      ]),
      "services/openclaw-zalo-bridge/src/invalid-utf16.ts": Buffer.from([
        0xff,
        0xfe,
        0x00,
        0xd8,
      ]),
      "services/openclaw-zalo-bridge/src/invalid-utf8.ts": Buffer.from([0xc3, 0x28]),
      "services/openclaw-zalo-cell/artifacts/openclaw-zalouser.tgz": Buffer.from([0, 1, 2, 3]),
    });

    const findings = scanOpenClawFiles(root);
    const expectFinding = (file: string, rule: string) => {
      expect(findings).toContainEqual(expect.objectContaining({ file, rule }));
    };

    expectFinding("services/openclaw-zalo-bridge/src/utf16-le.ts", "legacy-zalo-identifier");
    expectFinding("services/openclaw-zalo-bridge/src/utf16-be.ts", "legacy-zalo-identifier");
    expectFinding("services/openclaw-zalo-bridge/src/utf8-bom.ts", "legacy-zalo-identifier");
    expectFinding(
      "services/openclaw-zalo-bridge/src/parse-error.ts",
      "unscannable-openclaw-source",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/src/nul-source.ts",
      "unscannable-openclaw-source",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/src/invalid-utf16.ts",
      "unscannable-openclaw-source",
    );
    expectFinding(
      "services/openclaw-zalo-bridge/src/invalid-utf8.ts",
      "unscannable-openclaw-source",
    );
    expect(
      findings.filter(
        (finding) =>
          finding.file === "services/openclaw-zalo-cell/artifacts/openclaw-zalouser.tgz",
      ),
    ).toEqual([]);
  });

  it("reports a symlink or junction inside a scanned scope without following it", ({ skip }) => {
    const root = makeFixture({
      "outside/legacy.ts": `const table = "zalo_outside";`,
      "contracts-target/openclaw-zalo/legacy.ts": `const table = "zalo_parent_link";`,
      "services/openclaw-zalo-bridge/src/safe.ts": `export const safe = true;`,
    });
    const linkPath = join(root, "services/openclaw-zalo-bridge/src/linked");
    const contractsLinkPath = join(root, "contracts");

    try {
      symlinkSync(
        join(root, "outside"),
        linkPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      symlinkSync(
        join(root, "contracts-target"),
        contractsLinkPath,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) return skip();
      throw error;
    }

    const findings = scanOpenClawFiles(root);
    expect(findings).toContainEqual(
      expect.objectContaining({
        file: "services/openclaw-zalo-bridge/src/linked",
        rule: "unsafe-openclaw-filesystem-entry",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        file: "contracts",
        rule: "unsafe-openclaw-filesystem-entry",
      }),
    );
    expect(findings.some((finding) => finding.file.startsWith("contracts/openclaw-zalo/"))).toBe(
      false,
    );
  });

  it("covers every OpenClaw scope and skips only the exact generated or secret paths", () => {
    const scopedPaths = [
      "src/components/openclaw-zalo/scoped.ts",
      "services/openclaw-zalo-bridge/src/scoped.ts",
      "services/openclaw-zalo-maintenance/src/scoped.ts",
      "services/openclaw-egress-broker/src/scoped.ts",
      "infra/openclaw-zalo/scoped.yaml",
      "infra/openclaw-media-gateway/scoped.ts",
      "contracts/openclaw-zalo/scoped.json",
      "supabase/migrations/20990101000000_openclaw_scoped.sql",
      "supabase/functions/_shared/openclaw/scoped.ts",
      "supabase/functions/openclaw-control/scoped.ts",
    ];
    const ignoredFiles = [
      "infra/openclaw-zalo/.env",
      "infra/openclaw-zalo/secrets/runtime.env",
      "infra/openclaw-zalo/rendered/compose.yaml",
      "infra/openclaw-media-gateway/.dev.vars",
      "infra/openclaw-media-gateway/.wrangler/state.json",
      "services/openclaw-zalo-bridge/.data/spool.sql",
      "services/openclaw-zalo-bridge/coverage/report.json",
      "services/openclaw-zalo-cell/.state/session.json",
      "services/openclaw-zalo-cell/.release/image.json",
      "services/openclaw-zalo-cell/vendor/zalouser-bridge/.work/build.json",
    ];
    const root = makeFixture(
      Object.fromEntries(
        [...scopedPaths, ...ignoredFiles].map((path) => [path, `const table = "zalo_scope";`]),
      ),
    );

    const foundFiles = scanOpenClawFiles(root)
      .filter((finding) => finding.rule === "legacy-zalo-identifier")
      .map((finding) => finding.file);

    expect(foundFiles).toEqual([...scopedPaths].sort());
  });

  it("keeps every required OpenClaw ignore entry exactly once", () => {
    const ignoreLines = readFileSync(".gitignore", "utf8").split(/\r?\n/);

    for (const ignoredPath of ignoredOpenClawPaths) {
      expect(ignoreLines.filter((line) => line === ignoredPath)).toHaveLength(1);
    }
  });

  it("detects escaped packages and generic send methods in non-code configuration", () => {
    const root = makeFixture({
      "infra/openclaw-zalo/config/package.yaml": String.raw`package: "@openclaw\x2f\u007aalouser"`,
      "infra/openclaw-zalo/config/rpc.yaml": [
        `method: send`,
        `rpcName = "send" # exact generic RPC`,
        `'rpcMethod': 'send'`,
      ].join("\n"),
      "infra/openclaw-zalo/config/status.yaml": [
        `method: status`,
        `rpcName = classify`,
      ].join("\n"),
    });

    const findings = scanOpenClawFiles(root);
    expect(findings).toContainEqual(
      expect.objectContaining({
        file: "infra/openclaw-zalo/config/package.yaml",
        rule: "direct-zalouser-package",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        file: "infra/openclaw-zalo/config/rpc.yaml",
        rule: "stock-generic-send",
      }),
    );
    expect(
      findings.filter(
        (finding) => finding.file === "infra/openclaw-zalo/config/status.yaml",
      ),
    ).toEqual([]);
  });

  it("returns findings in exact code-point order", () => {
    const orderedPaths = [
      "services/openclaw-zalo-bridge/src/Z.ts",
      "services/openclaw-zalo-bridge/src/a.ts",
      "services/openclaw-zalo-bridge/src/é.ts",
      "services/openclaw-zalo-bridge/src/😀.ts",
    ];
    const root = makeFixture(
      Object.fromEntries(orderedPaths.map((path) => [path, `const table = "zalo_order";`])),
    );

    expect(
      scanOpenClawFiles(root)
        .filter((finding) => finding.rule === "legacy-zalo-identifier")
        .map((finding) => finding.file),
    ).toEqual(orderedPaths);
  });

  it("sets CLI status and output for clean, finding, and invalid roots", () => {
    const cleanRoot = makeFixture({
      "services/openclaw-zalo-bridge/src/clean.ts": `export const channel = "zalouser";`,
    });
    const findingRoot = makeFixture({
      "services/openclaw-zalo-bridge/src/bad.ts": `const table = "zalo_cli";`,
    });
    const invalidRoot = join(cleanRoot, "missing");
    const run = (root: string) =>
      spawnSync(process.execPath, [scannerPath, root], { encoding: "utf8" });

    const clean = run(cleanRoot);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("0 forbidden references");

    const finding = run(findingRoot);
    expect(finding.status).toBe(1);
    expect(finding.stderr).toContain("legacy-zalo-identifier");
    expect(finding.stderr).toContain("services/openclaw-zalo-bridge/src/bad.ts");

    const invalid = run(invalidRoot);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("root does not exist");
  });
});
