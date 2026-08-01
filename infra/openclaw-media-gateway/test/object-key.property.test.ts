import { describe, expect, it } from "vitest";

import {
  buildAuditAnchorObjectKey,
  buildMediaObjectKey,
  isCanonicalObjectKey,
  objectKeyTenant,
  ObjectKeyError,
} from "../src/object-key";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "dddd4000-0000-4000-8000-000000000001";
const MESSAGE_ID = "dddd5000-0000-4000-8000-000000000001";
const MEDIA_ID = "dddd6000-0000-4000-8000-000000000001";
const AUDIT_ROOT_ID = "dddd7000-0000-4000-8000-000000000001";

const mediaParts = {
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  mediaId: MEDIA_ID,
  variant: "original" as const,
};

describe("OpenClaw immutable object keys", () => {
  it("builds the exact documented media key", () => {
    expect(buildMediaObjectKey(mediaParts)).toBe(
      `v1/org/${ORGANIZATION_ID}/account/${ACCOUNT_ID}` +
        `/conversation/${CONVERSATION_ID}/message/${MESSAGE_ID}` +
        `/media/${MEDIA_ID}/original`,
    );
  });

  it("builds the exact documented audit anchor key", () => {
    expect(
      buildAuditAnchorObjectKey({
        organizationId: ORGANIZATION_ID,
        utcDate: "2026-08-01",
        auditRootId: AUDIT_ROOT_ID,
      }),
    ).toBe(`v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`);
  });

  it("refuses any identifier that is not a validated trusted-row value", () => {
    for (const mutation of [
      { organizationId: "../../etc" },
      { accountId: "not-a-uuid" },
      { conversationId: "" },
      { messageId: `${MESSAGE_ID}/extra` },
      { mediaId: MEDIA_ID.toUpperCase() },
    ]) {
      expect(() => buildMediaObjectKey({ ...mediaParts, ...mutation })).toThrow(ObjectKeyError);
    }
    expect(() => buildMediaObjectKey({ ...mediaParts, variant: "raw" as never }))
      .toThrow(ObjectKeyError);
  });

  it("refuses an impossible or non-canonical audit date", () => {
    for (const utcDate of ["2026-13-01", "2026-02-30", "20260801", "2026-8-1"]) {
      expect(() =>
        buildAuditAnchorObjectKey({
          organizationId: ORGANIZATION_ID,
          utcDate,
          auditRootId: AUDIT_ROOT_ID,
        })
      ).toThrow(ObjectKeyError);
    }
  });

  it("accepts only keys that round-trip through the builders", () => {
    expect(isCanonicalObjectKey(buildMediaObjectKey(mediaParts))).toBe(true);
    expect(
      isCanonicalObjectKey(
        buildAuditAnchorObjectKey({
          organizationId: ORGANIZATION_ID,
          utcDate: "2026-08-01",
          auditRootId: AUDIT_ROOT_ID,
        }),
      ),
    ).toBe(true);

    for (const key of [
      "",
      "/",
      "v1/org/../account/x/conversation/y/message/z/media/m/original",
      `v1/org/${ORGANIZATION_ID}//account/${ACCOUNT_ID}/conversation/${CONVERSATION_ID}/message/${MESSAGE_ID}/media/${MEDIA_ID}/original`,
      `v1/org/${ORGANIZATION_ID}/account/${ACCOUNT_ID}/conversation/${CONVERSATION_ID}/message/${MESSAGE_ID}/media/${MEDIA_ID}/original/`,
      `v1/org/${ORGANIZATION_ID}/account/${ACCOUNT_ID}/conversation/${CONVERSATION_ID}/message/${MESSAGE_ID}/media/${MEDIA_ID}/exec`,
      "ihome-openclaw-media-private/anything",
      `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.txt`,
      `v1/org/${ORGANIZATION_ID}/account/${ACCOUNT_ID}/conversation/${CONVERSATION_ID}/message/${MESSAGE_ID}/media/${MEDIA_ID}/original\u0000`,
    ]) {
      expect(isCanonicalObjectKey(key), key).toBe(false);
    }
  });

  it("derives the tenant that owns a canonical key", () => {
    expect(objectKeyTenant(buildMediaObjectKey(mediaParts))).toEqual({
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
    });
    expect(
      objectKeyTenant(
        buildAuditAnchorObjectKey({
          organizationId: ORGANIZATION_ID,
          utcDate: "2026-08-01",
          auditRootId: AUDIT_ROOT_ID,
        }),
      ),
    ).toEqual({ organizationId: ORGANIZATION_ID, accountId: null });
    expect(objectKeyTenant("nonsense")).toBeNull();
  });
});