import { OpenClawHttpError } from "./errors.ts";
import { redactText } from "./redaction.ts";

interface SchemaLike<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: unknown };
}

interface StrictJsonOptions<T> {
  method: string;
  maxBytes: number;
  schema: SchemaLike<T>;
  requestIdFactory?: () => string;
}

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new OpenClawHttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body too large");
        throw new OpenClawHttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OpenClawHttpError) throw error;
    throw new OpenClawHttpError(400, "BODY_READ_FAILED", "Request body could not be read.");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readStrictJson<T>(
  request: Request,
  options: StrictJsonOptions<T>,
): Promise<{ data: T; requestId: string; rawBody: Uint8Array }> {
  if (request.method !== options.method) {
    throw new OpenClawHttpError(405, "METHOD_NOT_ALLOWED", "Method is not allowed.");
  }
  if (request.headers.get("content-type")?.trim().toLowerCase() !== "application/json") {
    throw new OpenClawHttpError(
      415,
      "CONTENT_TYPE_REQUIRED",
      "Content-Type must be application/json.",
    );
  }
  const rawBody = await readBoundedBody(request, options.maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    throw new OpenClawHttpError(400, "INVALID_JSON", "Request body is not valid JSON.");
  }
  const result = options.schema.safeParse(parsed);
  if (!result.success) {
    throw new OpenClawHttpError(400, "INVALID_REQUEST", "Request schema is invalid.");
  }
  const suppliedRequestId = request.headers.get("x-request-id")?.toLowerCase();
  const requestId = suppliedRequestId && REQUEST_ID_PATTERN.test(suppliedRequestId)
    ? suppliedRequestId
    : (options.requestIdFactory ?? (() => crypto.randomUUID()))();
  return { data: result.data, requestId, rawBody };
}

export function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
      ...extraHeaders,
    },
  });
}

export function errorResponse(error: unknown, requestId: string): Response {
  const known = error instanceof OpenClawHttpError ? error : null;
  const status = known?.status ?? 500;
  const code = known?.code ?? "INTERNAL_ERROR";
  const message = known?.expose
    ? redactText(known.message)
    : "Request failed.";
  return jsonResponse({ error: { code, message }, requestId }, status, requestId);
}
