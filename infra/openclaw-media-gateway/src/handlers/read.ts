import type { MediaGatewayEnv } from "../env";
import { GatewayError } from "../gateway-error";
import { errorResponse, objectResponse } from "../responses";
import { verifyTicketRequest } from "../ticket-verifier";

function sha256Hex(bytes: ArrayBuffer | undefined): string | null {
  if (!bytes || bytes.byteLength !== 32) return null;
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fileName(objectKey: string, contentType: string): string {
  const segments = objectKey.split("/");
  const variant = segments.at(-1) ?? "media";
  const mediaId = segments.at(-2) ?? "object";
  const extension = ({
    "image/png": "png",
    "image/jpeg": "jpg",
    "video/mp4": "mp4",
    "audio/mpeg": "mp3",
    "application/json": "json",
  } as Record<string, string>)[contentType] ?? "bin";
  return `${mediaId}-${variant}.${extension}`;
}

export async function handleRead(request: Request, env: MediaGatewayEnv): Promise<Response> {
  try {
    const ticket = await verifyTicketRequest(request, env, "GET");
    const object = await env.MEDIA.get(ticket.objectKey);
    if (!object) throw new GatewayError("OBJECT_NOT_FOUND", 404);
    if (object.size !== ticket.contentLength) {
      throw new GatewayError("OBJECT_INTEGRITY_MISMATCH", 409);
    }
    if (
      sha256Hex(object.checksums.sha256) !== ticket.sha256 ||
      (object.httpMetadata?.contentType !== undefined &&
        object.httpMetadata.contentType !== ticket.contentType) ||
      (object.customMetadata?.sha256 !== undefined &&
        object.customMetadata.sha256 !== ticket.sha256)
    ) throw new GatewayError("OBJECT_INTEGRITY_MISMATCH", 409);
    return objectResponse(
      object.body,
      ticket.contentType,
      fileName(ticket.objectKey, ticket.contentType),
    );
  } catch (error) {
    if (error instanceof GatewayError) return errorResponse(error.code, error.status);
    return errorResponse("MEDIA_TICKET_INVALID", 403);
  }
}
