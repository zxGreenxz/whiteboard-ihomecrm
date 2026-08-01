export interface BoundedResponseErrors {
  invalidContentLength(): Error;
  invalidUtf8(): Error;
  tooLarge(): Error;
}

/** Read a response without ever buffering more than the configured byte limit. */
export async function readBoundedUtf8Response(
  response: Response,
  maximumBytes: number,
  errors: BoundedResponseErrors,
): Promise<string> {
  const rawContentLength = response.headers.get("content-length");
  if (rawContentLength !== null) {
    if (!/^\d+$/u.test(rawContentLength)) throw errors.invalidContentLength();
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength)) throw errors.invalidContentLength();
    if (contentLength > maximumBytes) throw errors.tooLarge();
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maximumBytes - totalBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is authoritative; transport cancellation is best effort.
        }
        throw errors.tooLarge();
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw errors.invalidUtf8();
  }
}
