import { describe, expect, it } from "vitest";

import {
  applyDlp,
  evaluateGeneratedContent,
  MAX_GENERATED_CODE_POINTS,
  selectChunksForPrompt,
  type KnowledgeChunk,
} from "../src/ai/dlp.js";

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