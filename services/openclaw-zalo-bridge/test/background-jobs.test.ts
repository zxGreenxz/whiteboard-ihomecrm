import { describe, expect, it } from "vitest";

import {
  becomesUnknown,
  classifyOutboundError,
  mayRequeue,
} from "../src/outbox/error-classifier.js";
import {
  escapeTemplateValue,
  MAX_RENDERED_CODE_POINTS,
  renderTemplate,
  TEMPLATE_FIELD_ALLOWLIST,
} from "../src/jobs/template-renderer.js";

describe("Outbound error classification", () => {
  it("requeues only proven pre-handoff failures", () => {
    for (const code of [
      "AUTHORIZATION_DENIED",
      "MARKER_EXPIRED",
      "POLICY_DENIED",
      "EDGE_TIMEOUT",
      "MEDIA_VERIFICATION_FAILED",
    ]) {
      const classified = classifyOutboundError({ code, phase: "PRE_HANDOFF" });
      expect(classified.errorClass, code).toBe("RETRYABLE_PRE_HANDOFF");
      expect(classified.provenNoProviderFrame, code).toBe(true);
      expect(mayRequeue(classified), code).toBe(true);
    }
  });

  it("marks a definite provider rejection before handoff as permanent", () => {
    const classified = classifyOutboundError({
      code: "PROVIDER_REJECTED",
      phase: "PRE_HANDOFF",
    });
    expect(classified.errorClass).toBe("PERMANENT_REJECT");
    expect(mayRequeue(classified)).toBe(false);
    expect(becomesUnknown(classified)).toBe(false);
  });

  it("turns every post-handoff failure into UNKNOWN, including a reject", () => {
    for (const code of [
      "PROVIDER_REJECTED",
      "TARGET_BLOCKED",
      "SOCKET_CLOSED",
      "TIMEOUT",
      "PROCESS_CRASH",
    ]) {
      const classified = classifyOutboundError({ code, phase: "POST_HANDOFF" });
      expect(classified.errorClass, code).toBe("AMBIGUOUS_UNKNOWN");
      expect(classified.provenNoProviderFrame, code).toBe(false);
      expect(mayRequeue(classified), code).toBe(false);
      expect(becomesUnknown(classified), code).toBe(true);
    }
  });

  it("fails closed on an unrecognised pre-handoff code", () => {
    const classified = classifyOutboundError({
      code: "SOMETHING_NEW",
      phase: "PRE_HANDOFF",
    });
    expect(classified.errorClass).toBe("AMBIGUOUS_UNKNOWN");
    expect(mayRequeue(classified)).toBe(false);
  });
});

describe("Template rendering", () => {
  it("renders only allowlisted fields", () => {
    const result = renderTemplate({
      template: "Chào {{customerName}}, phòng {{roomCode}} còn {{amountDue}}.",
      values: { customerName: "An", roomCode: "P101", amountDue: "1.200.000" },
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe("Chào An, phòng P101 còn 1.200.000.");
  });

  it("rejects an unknown field instead of rendering it empty", () => {
    const result = renderTemplate({
      template: "Chào {{secretSalary}}",
      values: {},
    });
    expect(result.failure).toBe("UNKNOWN_FIELD");
    expect(result.field).toBe("secretSalary");
  });

  it.each([
    "customer.name",
    "customer-name",
    "unknown field",
  ])("rejects a closed placeholder with invalid field syntax: %s", (field) => {
    const result = renderTemplate({
      template: `Hello {{ ${field} }}`,
      values: {},
    });
    expect(result).toEqual({ ok: false, failure: "UNKNOWN_FIELD", field });
  });

  it("rejects a missing required value", () => {
    const result = renderTemplate({
      template: "Hóa đơn {{invoiceCode}}",
      values: {},
      requiredFields: ["invoiceCode"],
    });
    expect(result.failure).toBe("MISSING_REQUIRED_VALUE");
    expect(result.field).toBe("invoiceCode");
  });

  it("renders an optional missing value as an empty string", () => {
    const result = renderTemplate({
      template: "Phòng {{roomCode}}{{periodLabel}}",
      values: { roomCode: "P101" },
    });
    expect(result.text).toBe("Phòng P101");
  });

  it("escapes control and markup characters deterministically", () => {
    expect(escapeTemplateValue("a\u0000b")).toBe("ab");
    expect(escapeTemplateValue("<script>")).toBe("\u2039script\u203a");
    expect(escapeTemplateValue("a\r\nb")).toBe("a\nb");

    const first = renderTemplate({
      template: "{{customerName}}",
      values: { customerName: "<b>An</b>" },
    });
    const second = renderTemplate({
      template: "{{customerName}}",
      values: { customerName: "<b>An</b>" },
    });
    expect(first.text).toBe(second.text);
    expect(first.text).not.toContain("<");
  });

  it("rejects output above the length ceiling before chunking", () => {
    const result = renderTemplate({
      template: "{{customerName}}",
      values: { customerName: "a".repeat(MAX_RENDERED_CODE_POINTS + 1) },
    });
    expect(result.failure).toBe("OUTPUT_TOO_LONG");
  });

  it("rejects a malformed template", () => {
    expect(renderTemplate({ template: "", values: {} }).failure).toBe("MALFORMED_TEMPLATE");
    expect(renderTemplate({ template: "Chào {{customerName", values: {} }).failure)
      .toBe("MALFORMED_TEMPLATE");
  });

  it("freezes the field allowlist", () => {
    expect([...TEMPLATE_FIELD_ALLOWLIST]).toEqual([
      "customerName",
      "roomCode",
      "buildingName",
      "amountDue",
      "dueDate",
      "invoiceCode",
      "meterReading",
      "periodLabel",
      "contactPhoneMasked",
    ]);
  });
});
