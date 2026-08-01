/**
 * The immutable object-key format. Every brace is a validated identifier taken
 * from a trusted database row, never a caller-selected path fragment, so no
 * endpoint has to accept a bucket name or an arbitrary key.
 *
 *   v1/org/{organizationId}/account/{accountId}/conversation/{conversationId}
 *     /message/{messageId}/media/{mediaId}/{variant}
 *
 * Daily audit anchors use a separate immutable shape:
 *
 *   v1/org/{organizationId}/audit/{utcDate}/{auditRootId}.json
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const MEDIA_VARIANTS = Object.freeze([
  "original",
  "thumbnail",
  "preview",
] as const);

export type MediaVariant = (typeof MEDIA_VARIANTS)[number];

export interface MediaKeyParts {
  organizationId: string;
  accountId: string;
  conversationId: string;
  messageId: string;
  mediaId: string;
  variant: MediaVariant;
}

export interface AuditAnchorKeyParts {
  organizationId: string;
  utcDate: string;
  auditRootId: string;
}

export class ObjectKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectKeyError";
  }
}

function assertUuid(value: string, label: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ObjectKeyError(`${label} must be a lowercase UUID.`);
  }
}

function assertUtcDate(value: string): void {
  if (typeof value !== "string" || !UTC_DATE_PATTERN.test(value)) {
    throw new ObjectKeyError("utcDate must be YYYY-MM-DD.");
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) throw new ObjectKeyError("utcDate is not a real date.");
  if (new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new ObjectKeyError("utcDate is not a real date.");
  }
}

export function buildMediaObjectKey(parts: MediaKeyParts): string {
  assertUuid(parts.organizationId, "organizationId");
  assertUuid(parts.accountId, "accountId");
  assertUuid(parts.conversationId, "conversationId");
  assertUuid(parts.messageId, "messageId");
  assertUuid(parts.mediaId, "mediaId");
  if (!MEDIA_VARIANTS.includes(parts.variant)) {
    throw new ObjectKeyError("variant is not allowed.");
  }
  return `v1/org/${parts.organizationId}/account/${parts.accountId}` +
    `/conversation/${parts.conversationId}/message/${parts.messageId}` +
    `/media/${parts.mediaId}/${parts.variant}`;
}

export function buildAuditAnchorObjectKey(parts: AuditAnchorKeyParts): string {
  assertUuid(parts.organizationId, "organizationId");
  assertUtcDate(parts.utcDate);
  assertUuid(parts.auditRootId, "auditRootId");
  return `v1/org/${parts.organizationId}/audit/${parts.utcDate}/${parts.auditRootId}.json`;
}

/**
 * Structural gate used by both the Edge issuer and the Worker. A key that does
 * not round-trip through the builders is rejected: this blocks traversal,
 * duplicate separators, and any key shape outside the two approved formats.
 */
export function isCanonicalObjectKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.includes("..") || key.includes("//") || key.startsWith("/") || key.endsWith("/")) {
    return false;
  }
  if (key !== key.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(key)) return false;

  const mediaMatch =
    /^v1\/org\/([^/]+)\/account\/([^/]+)\/conversation\/([^/]+)\/message\/([^/]+)\/media\/([^/]+)\/([^/]+)$/
      .exec(key);
  if (mediaMatch) {
    try {
      return buildMediaObjectKey({
        organizationId: mediaMatch[1] ?? "",
        accountId: mediaMatch[2] ?? "",
        conversationId: mediaMatch[3] ?? "",
        messageId: mediaMatch[4] ?? "",
        mediaId: mediaMatch[5] ?? "",
        variant: (mediaMatch[6] ?? "") as MediaVariant,
      }) === key;
    } catch {
      return false;
    }
  }

  const anchorMatch = /^v1\/org\/([^/]+)\/audit\/([^/]+)\/([^/]+)\.json$/.exec(key);
  if (anchorMatch) {
    try {
      return buildAuditAnchorObjectKey({
        organizationId: anchorMatch[1] ?? "",
        utcDate: anchorMatch[2] ?? "",
        auditRootId: anchorMatch[3] ?? "",
      }) === key;
    } catch {
      return false;
    }
  }
  return false;
}

export function objectKeyTenant(
  key: string,
): { organizationId: string; accountId: string | null } | null {
  if (!isCanonicalObjectKey(key)) return null;
  const media =
    /^v1\/org\/([^/]+)\/account\/([^/]+)\//.exec(key);
  if (media) return { organizationId: media[1] ?? "", accountId: media[2] ?? "" };
  const anchor = /^v1\/org\/([^/]+)\/audit\//.exec(key);
  if (anchor) return { organizationId: anchor[1] ?? "", accountId: null };
  return null;
}