import { describe, expect, it, vi } from "vitest";

// The SERVER'S OWN validator, imported from the Edge function. Nothing in this file
// restates the contract: a schema copied by hand would agree with whatever the
// client happens to send, which is precisely how the previous two attempts shipped.
import { qrRequestSchema } from "../../../../supabase/functions/openclaw-qr/schemas";

const ORG = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT = "dddd1000-0000-4000-8000-00000000000a";
const CELL = "dddd2000-0000-4000-8000-000000000010";
const CHALLENGE = "dddd3000-0000-4000-8000-000000000001";
const NONCE = "dddd4000-0000-4000-8000-000000000001";
/** A JWT whose payload carries a session_id; only the payload segment is read. */
const ACCESS_TOKEN = `x.${btoa(JSON.stringify({ session_id: "sess-1" }))
  .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}.y`;

/** Captures the body the client would POST, and replies with a chosen envelope. */
function captureInvoke(reply: unknown) {
  const invoke = vi.fn(async (_slug: string, options: { body: unknown }) => {
    captured.push(options.body);
    return { data: reply, error: null };
  });
  return invoke;
}

const captured: unknown[] = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (slug: string, options: { body: unknown }) =>
        currentInvoke(slug, options),
    },
  },
}));

let currentInvoke = captureInvoke(null);

const { beginQrLogin, pollQrLogin, consumeQrChallenge } = await import("../qrClient");

async function bodyOf(run: () => Promise<unknown>, reply: unknown) {
  captured.length = 0;
  currentInvoke = captureInvoke(reply);
  await run();
  return captured[0];
}

describe("QR client request bodies, validated by the server's own schema", () => {
  it("builds a BEGIN the server accepts", async () => {
    const body = await bodyOf(
      () => beginQrLogin({
        clientOperationId: CHALLENGE,
        organizationId: ORG,
        accountId: ACCOUNT,
        cellId: CELL,
        browserNonce: NONCE,
        accessToken: ACCESS_TOKEN,
        disclosureVersion: 2,
      }),
      { version: 1, requestId: "r", result: { challengeId: CHALLENGE, issuedAt: "t", expiresAt: "t" } },
    );
    const parsed = qrRequestSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("builds a POLL the server accepts, with no extra keys", async () => {
    // POLL_KEYS excludes clientOperationId and accountId, and hasExactKeys compares
    // LENGTH as well as membership - an earlier version sent both and every poll
    // 400'd in a 2-second loop until the challenge expired.
    const body = await bodyOf(
      () => pollQrLogin({
        organizationId: ORG,
        challengeId: CHALLENGE,
        browserNonce: NONCE,
        accessToken: ACCESS_TOKEN,
      }),
      { version: 1, requestId: "r", result: { version: 1, challenge: null } },
    );
    const parsed = qrRequestSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("builds a CONSUME the server accepts", async () => {
    const body = await bodyOf(
      () => consumeQrChallenge({
        clientOperationId: CHALLENGE,
        organizationId: ORG,
        accountId: ACCOUNT,
        challengeId: CHALLENGE,
        browserNonce: NONCE,
        accessToken: ACCESS_TOKEN,
      }),
      { version: 1, requestId: "r", result: { version: 1, challengeId: CHALLENGE, status: "CONSUMED", qrPngDataUrl: "data:image/png;base64,x" } },
    );
    const parsed = qrRequestSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("sends version: 1, which the schema checks before anything else", async () => {
    // `if (value.version !== 1) return {success:false}` runs first, so omitting it
    // rejected every call regardless of how correct the rest of the body was.
    const body = await bodyOf(
      () => pollQrLogin({
        organizationId: ORG, challengeId: CHALLENGE,
        browserNonce: NONCE, accessToken: ACCESS_TOKEN,
      }),
      { version: 1, requestId: "r", result: { version: 1, challenge: null } },
    );
    expect((body as { version: unknown }).version).toBe(1);
  });
});

describe("QR client response reading", () => {
  it("unwraps the result envelope for every operation", async () => {
    // The handler returns `{version, requestId, result}`. Reading the top level gave
    // undefined everywhere: BEGIN produced a challenge with no expiry (so the dialog
    // instantly showed "expired"), POLL produced no challenge (so the first tick
    // destroyed it), and CONSUME produced <img src={undefined}>.
    currentInvoke = captureInvoke({
      version: 1, requestId: "r",
      result: { challengeId: CHALLENGE, issuedAt: "2026-08-03T10:00:00Z", expiresAt: "2026-08-03T10:02:00Z" },
    });
    const begin = await beginQrLogin({
      clientOperationId: CHALLENGE, organizationId: ORG, accountId: ACCOUNT,
      cellId: CELL, browserNonce: NONCE, accessToken: ACCESS_TOKEN, disclosureVersion: 2,
    });
    expect(begin.challengeId).toBe(CHALLENGE);
    expect(begin.expiresAt).toBe("2026-08-03T10:02:00Z");

    currentInvoke = captureInvoke({
      version: 1, requestId: "r",
      result: { version: 1, challenge: { challengeId: CHALLENGE, challengeStatus: "READY", issuedAt: "a", expiresAt: "b" } },
    });
    const poll = await pollQrLogin({
      organizationId: ORG, challengeId: CHALLENGE, browserNonce: NONCE, accessToken: ACCESS_TOKEN,
    });
    expect(poll.challenge?.challengeStatus).toBe("READY");

    currentInvoke = captureInvoke({
      version: 1, requestId: "r",
      result: { version: 1, challengeId: CHALLENGE, status: "CONSUMED", qrPngDataUrl: "data:image/png;base64,x" },
    });
    const consumed = await consumeQrChallenge({
      clientOperationId: CHALLENGE, organizationId: ORG, accountId: ACCOUNT,
      challengeId: CHALLENGE, browserNonce: NONCE, accessToken: ACCESS_TOKEN,
    });
    expect(consumed.qrPngDataUrl).toBe("data:image/png;base64,x");
  });

  it("refuses a body without the result envelope rather than yielding undefined", async () => {
    currentInvoke = captureInvoke({ version: 1, requestId: "r" });
    await expect(pollQrLogin({
      organizationId: ORG, challengeId: CHALLENGE, browserNonce: NONCE, accessToken: ACCESS_TOKEN,
    })).rejects.toThrow(/result/iu);
  });
});
