import { constants as fsConstants } from "node:fs";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { redactLogValue, redactText } from "../src/security/redact.js";
import {
  readProtectedSecretFile,
  type SecretFileOperations,
} from "../src/security/secret-files.js";
import {
  prepareBridgeStoragePaths,
  validateBridgeStoragePaths,
} from "../src/security/storage-paths.js";

function secretOperations(overrides: {
  kind?: "file" | "directory" | "symlink";
  mode?: number;
  size?: number;
  uid?: number;
  contents?: Buffer;
} = {}): SecretFileOperations & { open: ReturnType<typeof vi.fn> } {
  const contents = overrides.contents ?? Buffer.from("root-credential\n");
  return {
    getuid: () => 1000,
    open: vi.fn(async () => ({
      stat: async () => ({
        kind: overrides.kind ?? "file",
        mode: overrides.mode ?? 0o100400,
        size: overrides.size ?? contents.byteLength,
        uid: overrides.uid ?? 1000,
      }),
      readFile: async () => Buffer.from(contents),
      close: async () => undefined,
    })),
  };
}

describe("bridge structured-log redaction", () => {
  it("removes every runtime, media, provider, session, and model secret class", () => {
    const value = {
      authorization: "Bearer auth-secret",
      claimToken: "claim-secret",
      markerNonce: "nonce-secret",
      "X-OpenClaw-Media-Ticket": "media-ticket-secret",
      "X-OpenClaw-Delete-Authorization": "delete-auth-secret",
      supabaseServiceRoleKey: "service-role-secret",
      gatewayToken: "gateway-secret",
      cookie: "session=cookie-secret",
      imei: "123456789012345",
      qrData: "data:image/png;base64,supersecretqr",
      ciphertext: "qr-ciphertext",
      modelApiKey: "model-secret",
      r2Signature: "r2-signature-secret",
      r2Receipt: { objectKey: "private-key" },
      revocationSignature: "revocation-secret",
      providerUid: "zalo-user-uid-secret",
      prompt: "customer-private-prompt",
      rawAdapterPayload: { text: "raw-provider-payload" },
      rawEnvelope: { content: "raw-envelope-content" },
      nested: { phone: "0912345678", safeCount: 2 },
    };

    const redacted = redactLogValue(value);
    const serialized = JSON.stringify(redacted);
    for (const secret of [
      "auth-secret", "claim-secret", "nonce-secret", "media-ticket-secret",
      "delete-auth-secret", "service-role-secret", "gateway-secret", "cookie-secret",
      "123456789012345", "supersecretqr", "qr-ciphertext", "model-secret",
      "r2-signature-secret", "private-key", "revocation-secret", "0912345678",
      "zalo-user-uid-secret", "customer-private-prompt", "raw-provider-payload",
      "raw-envelope-content",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(redacted).toMatchObject({ nested: { phone: "[REDACTED]", safeCount: 2 } });
  });

  it("redacts known values and secret-shaped text without mutating the source", () => {
    const source = {
      message: "Authorization: Bearer jwt-secret phone 0912345678",
      safe: "ready",
    };
    const redacted = redactLogValue(source, ["jwt-secret"]);

    expect(redacted).toEqual({
      message: "Authorization: Bearer [REDACTED_TOKEN] phone [REDACTED_PHONE]",
      safe: "ready",
    });
    expect(source.message).toContain("jwt-secret");
    expect(redactText("?x-amz-signature=abc123&safe=1")).not.toContain("abc123");
  });

  it("redacts serialized fields, secret headers, complete cookies, IMEI, and ticket queries", () => {
    const source = [
      '{"claimToken":"json-claim-secret"}',
      "x-openclaw-credential: workload-header-secret",
      "Cookie: first=cookie-one; second=cookie-two",
      "IMEI=123456789012345",
      "https://media.invalid/object?ticket=query-ticket-secret&safe=1",
    ].join("\n");
    const redacted = redactText(source);

    for (const secret of [
      "json-claim-secret",
      "workload-header-secret",
      "cookie-one",
      "cookie-two",
      "123456789012345",
      "query-ticket-secret",
    ]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("handles errors and cycles without serializing hidden values", () => {
    const cyclic: Record<string, unknown> = { password: "hidden" };
    cyclic.self = cyclic;
    const error = new Error("claimToken=hidden-token");

    expect(redactLogValue(cyclic)).toEqual({ password: "[REDACTED]", self: "[CIRCULAR]" });
    expect(JSON.stringify(redactLogValue(error))).not.toContain("hidden-token");
  });
});

describe("protected secret files", () => {
  it("opens only a direct /run/secrets file with no-follow and returns one scalar", async () => {
    const operations = secretOperations();

    await expect(readProtectedSecretFile(
      "/run/secrets/openclaw_runtime_credential",
      operations,
    )).resolves.toBe("root-credential");

    expect(operations.open).toHaveBeenCalledTimes(1);
    const [candidate, flags] = operations.open.mock.calls[0]!;
    expect(candidate).toBe("/run/secrets/openclaw_runtime_credential");
    expect(flags & fsConstants.O_RDONLY).toBe(fsConstants.O_RDONLY);
    if (fsConstants.O_NOFOLLOW !== undefined) {
      expect(flags & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    } else {
      // Windows cannot represent O_NOFOLLOW; the real filesystem adapter fails
      // closed there while injected operations keep path/inode checks testable.
      expect(flags).toBe(fsConstants.O_RDONLY);
    }
  });

  it("rejects traversal, nested paths, loose mode, wrong owner, and non-files", async () => {
    await expect(readProtectedSecretFile(
      "/run/secrets/../attacker",
      secretOperations(),
    )).rejects.toThrow(/secret path/i);
    await expect(readProtectedSecretFile(
      "/run/secrets/nested/credential",
      secretOperations(),
    )).rejects.toThrow(/secret path/i);
    await expect(readProtectedSecretFile(
      "/run/secrets/openclaw_runtime_credential",
      secretOperations({ mode: 0o100440 }),
    )).rejects.toThrow(/mode/i);
    await expect(readProtectedSecretFile(
      "/run/secrets/openclaw_runtime_credential",
      secretOperations({ mode: 0o100600 }),
    )).rejects.toThrow(/mode/i);
    await expect(readProtectedSecretFile(
      "/run/secrets/openclaw_runtime_credential",
      secretOperations({ uid: 0 }),
    )).rejects.toThrow(/owner/i);
    await expect(readProtectedSecretFile(
      "/run/secrets/openclaw_runtime_credential",
      secretOperations({ kind: "symlink" }),
    )).rejects.toThrow(/regular file/i);
  });

  it("rejects empty, oversized, NUL-containing, or multiline values", async () => {
    for (const contents of [
      Buffer.alloc(0),
      Buffer.alloc(16_385, 0x61),
      Buffer.from("secret\0suffix"),
      Buffer.from("first\nsecond"),
    ]) {
      await expect(readProtectedSecretFile(
        "/run/secrets/openclaw_runtime_credential",
        secretOperations({ contents }),
      )).rejects.toThrow(/secret file|secret value/i);
    }
  });
});

describe("owned bridge storage paths", () => {
  it("requires spool and temp paths to stay under one explicit data root", () => {
    const root = join(tmpdir(), "openclaw-owned-root");
    expect(validateBridgeStoragePaths({
      dataDirectory: root,
      spoolPath: join(root, "spool.db"),
      tempDirectory: join(root, "temp"),
    })).toEqual({
      dataDirectory: root,
      spoolPath: join(root, "spool.db"),
      tempDirectory: join(root, "temp"),
    });
    expect(() => validateBridgeStoragePaths({
      dataDirectory: root,
      spoolPath: join(tmpdir(), "outside.db"),
      tempDirectory: join(root, "temp"),
    })).toThrow(/contain|root/i);
  });

  it("rejects symlink traversal for owned leaf directories", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openclaw-storage-paths-"));
    try {
      const root = join(parent, "root");
      const outside = join(parent, "outside");
      await mkdir(root);
      await mkdir(outside);
      await symlink(outside, join(root, "temp"), process.platform === "win32" ? "junction" : "dir");

      await expect(prepareBridgeStoragePaths({
        dataDirectory: root,
        spoolPath: join(root, "spool.db"),
        tempDirectory: join(root, "temp"),
      })).rejects.toThrow(/symlink|owned directory/i);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
