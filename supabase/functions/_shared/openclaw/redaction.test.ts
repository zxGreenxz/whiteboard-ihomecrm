import { describe, expect, it } from "vitest";

import { redactLogValue, redactText } from "./redaction";

describe("OpenClaw structured redaction", () => {
  it("removes structured credentials, QR, session, model, R2, and phone secrets", () => {
    const source = {
      authorization: "Bearer header-secret",
      claimToken: "claim-secret",
      markerNonce: "nonce-secret",
      "x-openclaw-media-ticket": "media-ticket-secret",
      "x-openclaw-delete-authorization": "delete-authorization-secret",
      supabaseServiceRoleKey: "supabase-secret",
      gatewayToken: "gateway-secret",
      cookie: "sid=cookie-secret",
      imei: "123456789012345",
      phone: "+84901234567",
      qrData: "data:image/png;base64,qr-secret",
      ciphertext: "cipher-secret",
      modelApiKey: "model-secret",
      r2Signature: "r2-secret",
      r2Receipt: "receipt-secret",
      revocationSignature: "revocation-secret",
      nested: [{ safe: "visible", access_token: "access-secret" }],
    };
    const redacted = redactLogValue(source) as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);

    for (const secret of [
      "header-secret",
      "claim-secret",
      "nonce-secret",
      "media-ticket-secret",
      "delete-authorization-secret",
      "supabase-secret",
      "gateway-secret",
      "cookie-secret",
      "123456789012345",
      "+84901234567",
      "qr-secret",
      "cipher-secret",
      "model-secret",
      "r2-secret",
      "receipt-secret",
      "revocation-secret",
      "access-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("visible");
  });

  it("redacts free text, signed URLs, JWTs, PATs, and exact injected secrets", () => {
    const input = [
      "Authorization: Bearer bearer-secret",
      '"claimToken":"json-secret"',
      "https://r2.example/object?X-Amz-Signature=signed-secret&token=ticket-secret",
      "sbp_abcdefghijklmnopqrstuvwxyz",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature",
      "+84901234567",
      "exact-runtime-secret",
    ].join("\n");
    const redacted = redactText(input, ["exact-runtime-secret"]);

    for (const secret of [
      "bearer-secret",
      "json-secret",
      "signed-secret",
      "ticket-secret",
      "sbp_abcdefghijklmnopqrstuvwxyz",
      "eyJhbGciOiJIUzI1NiJ9",
      "+84901234567",
      "exact-runtime-secret",
    ]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("redacts workload, runtime-key, ticket, receipt, and session fields", () => {
    const redacted = redactLogValue({
      credential: "credential-secret",
      workloadCredential: "workload-secret",
      credentialHash: "credential-hash-secret",
      credentialProofSha256: "credential-proof-secret",
      runtimeToken: "runtime-token-secret",
      runtimeTokenSigningKey: "runtime-key-secret",
      ticket: "ticket-secret",
      signature: "signature-secret",
      r2Ticket: "r2-ticket-secret",
      gatewayReceipt: "gateway-receipt-secret",
      session: "session-secret",
      sessionId: "session-id-secret",
    });
    const serialized = JSON.stringify(redacted);
    for (const secret of [
      "credential-secret",
      "workload-secret",
      "credential-hash-secret",
      "credential-proof-secret",
      "runtime-token-secret",
      "runtime-key-secret",
      "ticket-secret",
      "signature-secret",
      "r2-ticket-secret",
      "gateway-receipt-secret",
      "session-secret",
      "session-id-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(redactText('{"authorization":"Bearer json-authorization-secret"}'))
      .not.toContain("json-authorization-secret");
    expect(redactText([
      "credentialHash=free-text-credential-hash-secret",
      "credentialProofSha256=free-text-credential-proof-secret",
    ].join("\n")))
      .not.toMatch(/free-text-credential-(?:hash|proof)-secret/);
  });

  it("handles Error objects and circular values without throwing", () => {
    const circular: Record<string, unknown> = { safe: "visible" };
    circular.self = circular;
    const result = redactLogValue({
      error: new Error("cookie=session-secret"),
      circular,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("visible");
    expect(serialized).not.toContain("session-secret");
    expect(serialized).toContain("[CIRCULAR]");
  });
});
