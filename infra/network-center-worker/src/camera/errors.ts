export type CameraClientErrorCode = "AUTH_DENIED" | "UNREACHABLE" | "INVALID_RESPONSE" | "RESPONSE_TOO_LARGE" | "UNSUPPORTED"
  | "STREAM_ENDED" | "STREAM_TIMEOUT" | "TLS_PIN_MISMATCH" | "TLS_HANDSHAKE_FAILED";

/** Fixed codes only: device text and credentials never reach a message or a log. */
export class CameraClientError extends Error {
  constructor(readonly code: CameraClientErrorCode) {
    super(code);
    this.name = "CameraClientError";
  }
}
