import { describe, expect, it } from "vitest";

import { loadTicketSigningConfiguration } from "./ticket-keyring";

async function privateKeyPkcs8Base64(): Promise<string> {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
}

describe("OpenClaw runtime ticket signing keyring", () => {
  it("imports the active key and at most eight strictly versioned historical keys", async () => {
    const [activePrivateKey, historicalPrivateKey] = await Promise.all([
      privateKeyPkcs8Base64(),
      privateKeyPkcs8Base64(),
    ]);

    const configuration = await loadTicketSigningConfiguration({
      OPENCLAW_TICKET_KEY_GENERATION: "3",
      OPENCLAW_TICKET_PRIVATE_KEY_B64: activePrivateKey,
      OPENCLAW_TICKET_HISTORICAL_KEYS_JSON: JSON.stringify([{
        generation: 2,
        privateKeyPkcs8Base64: historicalPrivateKey,
        activatedAt: "2026-07-01T00:00:00.000Z",
        retiredAt: "2026-08-01T00:00:00.000Z",
        emergencyRevokedAt: null,
      }]),
    });

    expect(configuration.ticketKeyGeneration).toBe(3);
    expect(Object.keys(configuration.historicalTicketSigningKeys)).toEqual(["2"]);
    expect(configuration.historicalTicketSigningKeys[2]).toMatchObject({
      activatedAtEpochSeconds: 1_782_864_000,
      retiredAtEpochSeconds: 1_785_542_400,
      emergencyRevokedAtEpochSeconds: null,
    });
    await expect(configuration.signGatewayPayload(new TextEncoder().encode("active")))
      .resolves.toMatch(/^[A-Za-z0-9_-]{86}$/);
    await expect(configuration.historicalTicketSigningKeys[2].signGatewayPayload(
      new TextEncoder().encode("historical"),
    )).resolves.toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it("rejects duplicate, active, future, over-limit, and malformed historical metadata", async () => {
    const privateKey = await privateKeyPkcs8Base64();
    const validEntry = {
      generation: 2,
      privateKeyPkcs8Base64: privateKey,
      activatedAt: "2026-07-01T00:00:00.000Z",
      retiredAt: "2026-08-01T00:00:00.000Z",
      emergencyRevokedAt: null,
    };
    const load = (entries: unknown) => loadTicketSigningConfiguration({
      OPENCLAW_TICKET_KEY_GENERATION: "3",
      OPENCLAW_TICKET_PRIVATE_KEY_B64: privateKey,
      OPENCLAW_TICKET_HISTORICAL_KEYS_JSON: JSON.stringify(entries),
    });

    await expect(load([validEntry, validEntry])).rejects.toThrow(/historical.*keyring/i);
    await expect(load([{ ...validEntry, generation: 3 }])).rejects.toThrow(/historical.*keyring/i);
    await expect(load([{ ...validEntry, generation: 4 }])).rejects.toThrow(/historical.*keyring/i);
    await expect(load(Array.from({ length: 9 }, (_, index) => ({
      ...validEntry,
      generation: index + 1,
    })))).rejects.toThrow(/historical.*keyring/i);
    await expect(load([{
      ...validEntry,
      unexpected: true,
    }])).rejects.toThrow(/historical.*keyring/i);
    await expect(load([{
      ...validEntry,
      retiredAt: validEntry.activatedAt,
    }])).rejects.toThrow(/historical.*keyring/i);
    await expect(load([{
      ...validEntry,
      emergencyRevokedAt: "2026-06-30T23:59:59.000Z",
    }])).rejects.toThrow(/historical.*keyring/i);
  });

  it("rejects malformed JSON and private keys without exposing configured key material", async () => {
    const privateKey = await privateKeyPkcs8Base64();
    await expect(loadTicketSigningConfiguration({
      OPENCLAW_TICKET_KEY_GENERATION: "3",
      OPENCLAW_TICKET_PRIVATE_KEY_B64: privateKey,
      OPENCLAW_TICKET_HISTORICAL_KEYS_JSON: "{",
    })).rejects.toThrow("OpenClaw historical ticket signing keyring is invalid.");

    const invalidPrivateKey = Buffer.from("not-a-private-key").toString("base64");
    await expect(loadTicketSigningConfiguration({
      OPENCLAW_TICKET_KEY_GENERATION: "3",
      OPENCLAW_TICKET_PRIVATE_KEY_B64: invalidPrivateKey,
    })).rejects.toThrow("OpenClaw active ticket signing key is invalid.");
  });
});
