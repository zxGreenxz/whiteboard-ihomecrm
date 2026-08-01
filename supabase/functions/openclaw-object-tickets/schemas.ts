const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The browser asks for a ticket by naming a canonical media row, never a bucket,
 * a key, or a path fragment. Edge derives everything else from trusted rows.
 */
export const OBJECT_TICKET_OPERATIONS = Object.freeze(["GET"] as const);

export type ObjectTicketOperation = (typeof OBJECT_TICKET_OPERATIONS)[number];

export interface ObjectTicketRequest {
  version: 1;
  operation: ObjectTicketOperation;
  organizationId: string;
  mediaId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const objectTicketRequestSchema = {
  safeParse(
    value: unknown,
  ): { success: true; data: ObjectTicketRequest } | { success: false; error: string } {
    if (!isPlainObject(value)) return { success: false, error: "request must be an object" };
    if (Object.keys(value).length !== 4) {
      return { success: false, error: "request has unexpected keys" };
    }
    if (value.version !== 1) return { success: false, error: "version must be 1" };
    if (
      typeof value.operation !== "string" ||
      !(OBJECT_TICKET_OPERATIONS as readonly string[]).includes(value.operation)
    ) {
      return { success: false, error: "operation is not allowed" };
    }
    if (
      typeof value.organizationId !== "string" || !UUID_PATTERN.test(value.organizationId) ||
      typeof value.mediaId !== "string" || !UUID_PATTERN.test(value.mediaId)
    ) {
      return { success: false, error: "request identifiers are invalid" };
    }
    // A caller-supplied bucket or key would defeat the immutable key format.
    for (const forbidden of ["objectKey", "bucket", "bucketName", "path", "key"]) {
      if (forbidden in value) return { success: false, error: "request has unexpected keys" };
    }
    return {
      success: true,
      data: {
        version: 1,
        operation: value.operation as ObjectTicketOperation,
        organizationId: value.organizationId,
        mediaId: value.mediaId,
      },
    };
  },
};

/** The RPC that resolves a media row into its trusted tenant/key fields. */
export const OBJECT_TICKET_RESOLVE_RPC = "openclaw_resolve_media_object_v1";
