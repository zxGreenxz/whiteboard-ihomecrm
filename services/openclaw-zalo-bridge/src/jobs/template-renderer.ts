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
  | "FIELD_NOT_ALLOWED"
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
const CLOSED_PLACEHOLDER = /\{\{([\s\S]*?)\}\}/g;
const VALID_FIELD = /^\s*([A-Za-z0-9_]+)\s*$/;

/**
 * Control and markup characters are escaped deterministically so a value taken
 * from a customer record cannot alter the shape of the outgoing message.
 */
export function escapeTemplateValue(value: string): string {
  const withoutForbiddenControls = [...value].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return !(codePoint <= 8 || codePoint === 11 || codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) || codePoint === 127);
  }).join("");
  return withoutForbiddenControls
    .replace(/[<>]/g, (character) => (character === "<" ? "\u2039" : "\u203a"))
    .replace(/\r\n?/g, "\n");
}

export function renderTemplate({
  template,
  values,
  requiredFields = [],
  allowedFields,
}: {
  template: string;
  values: Partial<Record<TemplateField, string>>;
  requiredFields?: readonly TemplateField[];
  allowedFields?: readonly TemplateField[];
}): RenderResult {
  if (typeof template !== "string" || template.length === 0) {
    return { ok: false, failure: "MALFORMED_TEMPLATE" };
  }
  // An unmatched brace pair means the author made a mistake; rendering it
  // literally would leak template syntax to a customer.
  if (/\{\{(?![^}]*\}\})/.test(template)) {
    return { ok: false, failure: "MALFORMED_TEMPLATE" };
  }

  // Validate every closed token, not only tokens matching the allowlist syntax.
  // Otherwise invalid placeholders remain literal customer-facing text.
  const closed = [...template.matchAll(CLOSED_PLACEHOLDER)];
  const withoutClosed = template.replace(CLOSED_PLACEHOLDER, "");
  if (withoutClosed.includes("{{") || withoutClosed.includes("}}")) {
    return { ok: false, failure: "MALFORMED_TEMPLATE" };
  }

  const referenced: string[] = [];
  for (const match of closed) {
    const rawField = match[1] ?? "";
    const fieldMatch = rawField.match(VALID_FIELD);
    if (!fieldMatch) {
      const field = rawField.trim();
      if (field.length === 0 || rawField.includes("{") || rawField.includes("}")) {
        return { ok: false, failure: "MALFORMED_TEMPLATE" };
      }
      return { ok: false, failure: "UNKNOWN_FIELD", field };
    }
    const field = fieldMatch[1];
    if (field === undefined) {
      return { ok: false, failure: "MALFORMED_TEMPLATE" };
    }
    referenced.push(field);
  }
  const allowed = allowedFields === undefined ? null : new Set<string>(allowedFields);
  for (const field of referenced) {
    if (!(TEMPLATE_FIELD_ALLOWLIST as readonly string[]).includes(field)) {
      return { ok: false, failure: "UNKNOWN_FIELD", field };
    }
    if (allowed !== null && !allowed.has(field)) {
      return { ok: false, failure: "FIELD_NOT_ALLOWED", field };
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
