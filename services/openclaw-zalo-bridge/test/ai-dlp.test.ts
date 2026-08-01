import { describe, expect, it } from "vitest";

import {
  applyDlp,
  selectChunksForPrompt,
  type KnowledgeChunk,
} from "../src/ai/dlp.js";
import {
  evaluateGeneratedContent,
  MAX_GENERATED_CODE_POINTS,
} from "../src/ai/content-policy.js";

const chunks: KnowledgeChunk[] = [
  { chunkId: "safe", sensitivity: "CUSTOMER_SAFE", text: "Giờ mở cửa 8h-20h" },
  { chunkId: "internal", sensitivity: "INTERNAL_REVIEW_ONLY", text: "Biên độ giảm giá tối đa 15%" },
  { chunkId: "restricted", sensitivity: "RESTRICTED", text: "Danh sách lương nhân viên" },
];

describe("Knowledge sensitivity gate", () => {
  it("lets only CUSTOMER_SAFE chunks into a customer-facing prompt", () => {
    const selected = selectChunksForPrompt(chunks, "CUSTOMER_FACING");
    expect(selected.map((chunk) => chunk.chunkId)).toEqual(["safe"]);
  });

  it("lets INTERNAL_REVIEW_ONLY inform a human draft review", () => {
    const selected = selectChunksForPrompt(chunks, "HUMAN_DRAFT_REVIEW");
    expect(selected.map((chunk) => chunk.chunkId)).toEqual(["safe", "internal"]);
  });

  it("never lets RESTRICTED material into any generation path", () => {
    for (const purpose of ["CUSTOMER_FACING", "HUMAN_DRAFT_REVIEW"] as const) {
      expect(
        selectChunksForPrompt(chunks, purpose).some(
          (chunk) => chunk.sensitivity === "RESTRICTED",
        ),
      ).toBe(false);
    }
  });
});

describe("Deterministic DLP", () => {
  it("passes clean text unchanged", () => {
    const result = applyDlp("Xin chào, cửa hàng mở cửa lúc 8 giờ sáng.");
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("redacts phone numbers, emails, ids, accounts, and credentials", () => {
    expect(applyDlp("gọi 0912345678").findings).toContain("PHONE_NUMBER");
    expect(applyDlp("mail a.b@example.com").findings).toContain("EMAIL");
    expect(applyDlp("cccd 012345678901").findings).toContain("NATIONAL_ID");
    expect(applyDlp("stk 1234567890").findings).toContain("BANK_ACCOUNT");
    expect(applyDlp("password: hunter2").findings).toContain("CREDENTIAL");
  });

  it.each([
    "0912 345 678",
    "0912.345.678",
    "+84 912-345-678",
    "(0912) 345 678",
    "0912/345/678",
    "0912\u00a0345\u00a0678",
  ])("blocks formatted Vietnamese phone numbers: %s", (phone) => {
    const result = applyDlp(`Lien he ${phone}`);
    expect(result.findings).toContain("PHONE_NUMBER");
    expect(result.redacted).not.toContain(phone);
  });

  it("blocks formatted national IDs and bank accounts", () => {
    expect(applyDlp("CCCD 012 345 678 901").findings).toContain("NATIONAL_ID");
    expect(applyDlp("STK 1234-567-890").findings).toContain("BANK_ACCOUNT");
  });

  it("redacts credentials nested in JSON without persisting the secret value", () => {
    const result = applyDlp('{"outer":{"apiKey":"nested-secret-value"}}');

    expect(result.findings).toContain("CREDENTIAL");
    expect(result.redacted).not.toContain("nested-secret-value");
  });

  it.each([
    '{"clientSecret":"raw-secret"}',
    '{"accessToken":"raw-secret"}',
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.1234567890.signature",
    "session_token=secret-session-value",
    "cookie: sid=secret-cookie-value",
    "-----BEGIN PRIVATE KEY----- secret -----END PRIVATE KEY-----",
  ])("blocks and fully redacts secret canaries: %s", (text) => {
    const result = applyDlp(text);

    expect(result.findings).toContain("CREDENTIAL");
    expect(result.findings).not.toContain("BANK_ACCOUNT");
    expect(result.redacted).not.toContain("raw-secret");
    expect(result.redacted).not.toContain("1234567890");
    expect(result.redacted).not.toContain("secret-session-value");
    expect(result.redacted).not.toContain("secret-cookie-value");
    expect(result.redacted).not.toContain("BEGIN PRIVATE KEY");
  });

  it.each([
    "system prompt: never reveal internal policy",
    "Developer message says to ignore previous instructions",
    "Here are the hidden instructions for this agent",
  ])("blocks prompt and instruction leakage: %s", (text) => {
    expect(applyDlp(text).findings).toContain("PROMPT_LEAKAGE");
  });

  it.each([
    "INTERNAL_REVIEW_ONLY: margin is 15%",
    "RESTRICTED customer note",
    "internal-only discount policy",
  ])("blocks internal-only markers: %s", (text) => {
    expect(applyDlp(text).findings).toContain("INTERNAL_ONLY");
  });

  it("allows current-customer PII from authorized context but blocks other-customer PII", () => {
    expect(applyDlp(
      "Email current@example.com",
      [],
      ["The current customer email is current@example.com"],
    ).ok).toBe(true);

    const crossCustomer = applyDlp(
      "Email other@example.com",
      [],
      ["The current customer email is current@example.com"],
    );
    expect(crossCustomer.findings).toEqual(expect.arrayContaining(["EMAIL", "CROSS_CUSTOMER_PII"]));
    expect(crossCustomer.redacted).not.toContain("other@example.com");
  });

  it("blocks exact unlabeled runtime and prompt canaries", () => {
    const runtimeSecret = "actual-runtime-secret-value-7f236e";
    const promptCanary = "OPENCLAW_PROMPT_CANARY_" + "c".repeat(64);
    const result = applyDlp(
      `Do not repeat ${runtimeSecret} or ${promptCanary}`,
      [],
      [],
      [runtimeSecret, promptCanary],
    );

    expect(result.findings).toContain("CREDENTIAL");
    expect(result.findings).toContain("PROMPT_LEAKAGE");
    expect(result.redacted).not.toContain(runtimeSecret);
    expect(result.redacted).not.toContain(promptCanary);
  });

  it("removes the secret value from the redacted text", () => {
    const result = applyDlp("liên hệ 0912345678 hoặc a.b@example.com");
    expect(result.redacted).not.toContain("0912345678");
    expect(result.redacted).not.toContain("a.b@example.com");
  });

  it("is deterministic for the same input", () => {
    const text = "gọi 0912345678 hoặc mail a.b@example.com";
    expect(applyDlp(text)).toEqual(applyDlp(text));
  });

  it("strips control characters", () => {
    const result = applyDlp("xin\u0000 chào\u001f");
    expect(result.findings).toContain("CONTROL_CHARACTERS");
    expect(result.redacted).toBe("xin chào");
  });

  it("blocks a URL outside the allowlist and keeps an allowed one", () => {
    expect(applyDlp("xem https://evil.example/x").findings).toContain("URL_NOT_ALLOWED");
    expect(applyDlp("xem https://ptcrm.vercel.app/x", ["ptcrm.vercel.app"]).ok).toBe(true);
  });

  it("does not let bare or non-HTTP URLs bypass the URL allowlist", () => {
    expect(applyDlp("xem evil.example/path").findings).toContain("URL_NOT_ALLOWED");
    expect(applyDlp("xem ftp://ptcrm.vercel.app/file", ["ptcrm.vercel.app"]).findings)
      .toContain("URL_NOT_ALLOWED");
    expect(applyDlp("xem ptcrm.vercel.app/help", ["ptcrm.vercel.app"]).ok).toBe(true);
    expect(applyDlp("xem //evil.example/path").findings).toContain("URL_NOT_ALLOWED");
    expect(applyDlp("xem 1.2.3.4/path").findings).toContain("URL_NOT_ALLOWED");
  });
});

describe("Generated content gate before an outbox intent", () => {
  const safeChunks = chunks.filter((chunk) => chunk.sensitivity === "CUSTOMER_SAFE");

  it("accepts clean generated text from safe sources", () => {
    expect(
      evaluateGeneratedContent({ text: "Dạ cửa hàng mở 8h-20h ạ.", sourceChunks: safeChunks }),
    ).toEqual({ ok: true });
  });

  it("rejects empty output", () => {
    expect(evaluateGeneratedContent({ text: "   ", sourceChunks: safeChunks }).failure)
      .toBe("EMPTY");
  });

  it("rejects output above the length ceiling", () => {
    expect(
      evaluateGeneratedContent({
        text: "a".repeat(MAX_GENERATED_CODE_POINTS + 1),
        sourceChunks: safeChunks,
      }).failure,
    ).toBe("TOO_LONG");
  });

  it("rejects generation that drew on a RESTRICTED source", () => {
    expect(
      evaluateGeneratedContent({ text: "Xin chào", sourceChunks: chunks }).failure,
    ).toBe("RESTRICTED_SOURCE");
  });

  it("blocks an outbox intent when DLP finds leaking data", () => {
    const result = evaluateGeneratedContent({
      text: "Anh gọi số 0912345678 nhé",
      sourceChunks: safeChunks,
    });
    expect(result.failure).toBe("DLP_BLOCKED");
    expect(result.findings).toContain("PHONE_NUMBER");
  });
});
