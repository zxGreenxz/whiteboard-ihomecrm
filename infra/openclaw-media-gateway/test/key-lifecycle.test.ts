import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareReceiptSigner } from "../src/receipts";
import { ticketVerificationKey } from "../src/ticket-verifier";
import {
  base64,
  gatewayEnv,
  png,
  receiptKeys,
  runtimeTicket,
  sha256Hex,
  ticketKeys,
} from "./fixtures";

afterEach(() => vi.useRealTimers());

describe("ticket verification key lifecycle", () => {
  it("uses an inclusive activation start and exclusive activation end", async () => {
    vi.useFakeTimers();
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    fixture.env.OPENCLAW_TICKET_KEY_NOT_BEFORE_EPOCH_SECONDS = "10000";
    fixture.env.OPENCLAW_TICKET_KEY_NOT_AFTER_EPOCH_SECONDS = "10001";

    vi.setSystemTime(new Date(9_999_000));
    await expect(ticketVerificationKey(fixture.env, 1, false)).rejects.toThrow(
      "ticket key generation invalid",
    );
    vi.setSystemTime(new Date(10_000_000));
    await expect(ticketVerificationKey(fixture.env, 1, false)).resolves.toBeInstanceOf(
      CryptoKey,
    );
    vi.setSystemTime(new Date(10_001_000));
    await expect(ticketVerificationKey(fixture.env, 1, false)).rejects.toThrow(
      "ticket key generation invalid",
    );
  });

  it("rejects an emergency-revoked historical key even for recovery lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000_000));
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const rotated = await ticketKeys();
    fixture.env.OPENCLAW_TICKET_RECOVERY_KEYRING_JSON = JSON.stringify([{
      generation: 1,
      publicKeyB64: fixture.env.OPENCLAW_TICKET_PUBLIC_KEY_B64,
      notBeforeEpochSeconds: 0,
      notAfterEpochSeconds: 20_000,
      emergencyRevoked: true,
    }]);
    fixture.env.OPENCLAW_TICKET_PUBLIC_KEY_B64 = base64(
      await crypto.subtle.exportKey("spki", rotated.publicKey) as ArrayBuffer,
    );
    fixture.env.OPENCLAW_TICKET_KEY_GENERATION = "2";

    await expect(ticketVerificationKey(fixture.env, 1, false)).rejects.toThrow(
      "ticket key generation invalid",
    );
    await expect(ticketVerificationKey(fixture.env, 1, true)).rejects.toThrow(
      "ticket key generation invalid",
    );
  });
});

describe("receipt signing key lifecycle", () => {
  it("uses an inclusive activation start and exclusive activation end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000_000));
    const ticketKeysFixture = await ticketKeys();
    const fixture = await gatewayEnv(ticketKeysFixture);
    const ticket = await runtimeTicket(ticketKeysFixture.privateKey, png());
    fixture.env.OPENCLAW_RECEIPT_KEY_NOT_BEFORE_EPOCH_SECONDS = "10000";
    fixture.env.OPENCLAW_RECEIPT_KEY_NOT_AFTER_EPOCH_SECONDS = "10001";

    vi.setSystemTime(new Date(9_999_000));
    await expect(prepareReceiptSigner(fixture.env, ticket.claims)).rejects.toMatchObject({
      code: "RECEIPT_SIGNING_KEY_UNAVAILABLE",
    });
    vi.setSystemTime(new Date(10_000_000));
    await expect(prepareReceiptSigner(fixture.env, ticket.claims)).resolves.toMatchObject({
      generation: 1,
    });
    vi.setSystemTime(new Date(10_001_000));
    await expect(prepareReceiptSigner(fixture.env, ticket.claims)).rejects.toMatchObject({
      code: "RECEIPT_SIGNING_KEY_UNAVAILABLE",
    });
  });

  it("permits an active historical signer but rejects emergency revocation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000_000));
    const mediaKeys = await ticketKeys();
    const fixture = await gatewayEnv(mediaKeys);
    const ticket = await runtimeTicket(mediaKeys.privateKey, png());
    const oldPrivateKeyB64 = fixture.env.OPENCLAW_RECEIPT_PRIVATE_KEY_B64;
    const oldPublicKeySha256 = fixture.env.OPENCLAW_RECEIPT_PUBLIC_KEY_SHA256;
    const rotated = await receiptKeys();
    const rotatedSpki = new Uint8Array(
      await crypto.subtle.exportKey("spki", rotated.publicKey) as ArrayBuffer,
    );
    fixture.env.OPENCLAW_RECEIPT_PRIVATE_KEY_B64 = base64(
      await crypto.subtle.exportKey("pkcs8", rotated.privateKey) as ArrayBuffer,
    );
    fixture.env.OPENCLAW_RECEIPT_PUBLIC_KEY_SHA256 = await sha256Hex(rotatedSpki);
    fixture.env.OPENCLAW_RECEIPT_KEY_GENERATION = "2";
    const historical = (emergencyRevoked: boolean) => JSON.stringify([{
      generation: 1,
      privateKeyB64: oldPrivateKeyB64,
      publicKeySha256: oldPublicKeySha256,
      notBeforeEpochSeconds: 0,
      notAfterEpochSeconds: 20_000,
      emergencyRevoked,
    }]);

    fixture.env.OPENCLAW_RECEIPT_RECOVERY_KEYRING_JSON = historical(false);
    await expect(prepareReceiptSigner(fixture.env, ticket.claims)).resolves.toMatchObject({
      generation: 1,
    });
    fixture.env.OPENCLAW_RECEIPT_RECOVERY_KEYRING_JSON = historical(true);
    await expect(prepareReceiptSigner(fixture.env, ticket.claims)).rejects.toMatchObject({
      code: "RECEIPT_SIGNING_KEY_UNAVAILABLE",
    });
  });
});
