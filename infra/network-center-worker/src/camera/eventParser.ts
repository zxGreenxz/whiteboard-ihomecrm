export interface CameraDeviceEvent {
  code: "VideoLoss" | "StorageNotExist" | "StorageFailure" | "StorageLowSpace";
  action: "Start" | "Stop" | "Pulse";
  /** Disk event indexes are disk indexes, not video channel numbers. */
  index: number;
  channelNumber?: number;
}

export type CameraStreamMessage = { type: "heartbeat" } | { type: "event"; event: CameraDeviceEvent };

/** Parse one complete multipart payload, not an arbitrary TCP chunk. */
export function parseCameraEvent(payload: string): CameraDeviceEvent | null {
  if (payload.length > 16_384) return null;
  const match = /^Code=(VideoLoss|StorageNotExist|StorageFailure|StorageLowSpace);\s*action=(Start|Stop|Pulse);\s*index=(\d+)(?:;\s*data=([\s\S]*))?\s*$/u.exec(payload.trim());
  if (!match) return null;
  if (match[4] !== undefined) {
    // Payloads can contain multiline JSON. Validate it, but never forward raw
    // device metadata (which may include private identifiers) to the journal.
    try { JSON.parse(match[4]); } catch { return null; }
  }
  const index = Number(match[3]);
  if (!Number.isSafeInteger(index) || index < 0 || index > 4095) return null;
  const code = match[1] as CameraDeviceEvent["code"];
  const action = match[2] as CameraDeviceEvent["action"];
  return { code, action, index, ...(code === "VideoLoss" ? { channelNumber: index + 1 } : {}) };
}

/** Bounded byte framing: UTF-8 payload length is measured in bytes, not JS chars. */
export class CameraMultipartParser {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly boundary: Buffer;

  constructor(boundary: string, private readonly maxPartBytes = 64 * 1024) {
    if (!/^[a-zA-Z0-9'()+_,\-./:=?]{1,70}$/u.test(boundary)) throw new Error("INVALID_CAMERA_BOUNDARY");
    this.boundary = Buffer.from(`--${boundary}`, "ascii");
  }

  push(chunk: Uint8Array): CameraStreamMessage[] {
    if (this.buffer.byteLength + chunk.byteLength > this.maxPartBytes) throw new Error("CAMERA_EVENT_TOO_LARGE");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: CameraStreamMessage[] = [];
    for (;;) {
      const start = this.buffer.indexOf(this.boundary);
      if (start < 0) break;
      if (start > 0) this.buffer = this.buffer.subarray(start);
      const headerEnd = this.buffer.indexOf("\r\n\r\n", this.boundary.byteLength);
      if (headerEnd < 0) break;
      if (headerEnd > 4096) throw new Error("INVALID_CAMERA_EVENT_HEADERS");
      const headers = this.buffer.subarray(this.boundary.byteLength, headerEnd).toString("ascii");
      const lengths = [...headers.matchAll(/^content-length:\s*(\d+)\s*$/gimu)];
      if (lengths.length > 1) throw new Error("INVALID_CAMERA_EVENT_LENGTH");
      const payloadStart = headerEnd + 4;
      let payloadEnd: number;
      if (lengths.length === 1) {
        const length = Number(lengths[0]![1]);
        if (!Number.isSafeInteger(length) || length > this.maxPartBytes - payloadStart) throw new Error("CAMERA_EVENT_TOO_LARGE");
        payloadEnd = payloadStart + length;
        if (this.buffer.byteLength < payloadEnd) break;
      } else {
        const next = this.buffer.indexOf(this.boundary, payloadStart);
        if (next < 0) break;
        payloadEnd = next;
      }
      const payload = this.buffer.subarray(payloadStart, payloadEnd).toString("utf8").trim();
      this.buffer = this.buffer.subarray(payloadEnd);
      if (payload === "Heartbeat") messages.push({ type: "heartbeat" });
      else {
        const event = parseCameraEvent(payload);
        if (event) messages.push({ type: "event", event });
        else throw new Error("INVALID_CAMERA_EVENT_PAYLOAD");
      }
    }
    return messages;
  }
}
