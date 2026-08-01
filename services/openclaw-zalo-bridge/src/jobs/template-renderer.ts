/**
 * Deterministic template rendering for schedule and CRM sends.
 *
 * The field mapping is frozen: a template may only reference fields in the
 * allowlist, and an unknown field is a hard error rather than an empty string.
 * That keeps a template from silently exfiltrating a field nobody reviewed.
 */

export const TEMPLATE_FIELD_ALLOWLIST = Object.freeze([
  "customerName",
  "roomCode",
  "buildingName",
  "amountDue",
  "dueDate",
  "invoiceCode",
  "meterReading",
  "periodLabel",
  "contactPhoneMasked",
] as const);

export type TemplateField = (typeof TEMPLATE_FIELD_ALLOWLIST)[number];

export type RenderFailure =
  | "UNKNOWN_FIELD"
  | "MISSING_REQUIRED_VALUE"
  | "OUTPUT_TOO_LONG"
  | "MALFORMED_TEMPLATE";

export interface RenderResult {
  ok: boolean;
  failure?: RenderFailure;
  field?: string;
  text?: string;
}

export const MAX_RENDERED_CODE_POINTS = 4_000;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Control and markup characters are escaped deterministically so a value taken
 * from a customer record cannot alter the shape of the outgoing message.
 */
export function escapeTemplateValue(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[<>]/g, (character) => (character === "<" ? "\u2039" : "\u203a"))
    .replace(/\r\n?/g, "\n");
}

export function renderTemplate({
  template,
  values,
  requiredFields = [],
}: {
  template: string;
  values: Partial<Record<TemplateField, string>>;
  requiredFields?: readonly TemplateField[];
}): RenderResult {
  if (typeof template !== "string" || template.length === 0) {
    return { ok: false, failure: "MALFORMED_TEMPLATE" };
  }
  // An unmatched brace pair means the author made a mistake; rendering it
  // literally would leak template syntax to a customer.
  if (/\{\{(?![^}]*\}\})/.test(template)) {
    return { ok: false, failure: "MALFORMED_TEMPLATE" };
  }

  const referenced = [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
  for (const field of referenced) {
    if (!(TEMPLATE_FIELD_ALLOWLIST as readonly string[]).includes(field)) {
      return { ok: false, failure: "UNKNOWN_FIELD", field };
    }
  }
  for (const field of requiredFields) {
    const value = values[field];
    if (value === undefined || value === null || value === "") {
      return { ok: false, failure: "MISSING_REQUIRED_VALUE", field };
    }
  }

  const text = template.replace(PLACEHOLDER, (_match, rawField: string) => {
    const field = rawField as TemplateField;
    const value = values[field];
    // The frozen missing-value rule: an optional field with no value renders as
    // an empty string, never as the placeholder text.
    return value === undefined || value === null ? "" : escapeTemplateValue(value);
  });

  if (Array.from(text).length > MAX_RENDERED_CODE_POINTS) {
    return { ok: false, failure: "OUTPUT_TOO_LONG" };
  }
  return { ok: true, text };
}