import type { PrivateBridgeSendRequestV1 } from "./outbound-rpc.js";
import type { PreparedOutboundBatchV1 } from "./send-context.js";

export function createAuthorizeClient(options: {
  call(request: PrivateBridgeSendRequestV1, batch: PreparedOutboundBatchV1): Promise<void>;
  timeoutMs: number;
}) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  return async (request: PrivateBridgeSendRequestV1, batch: PreparedOutboundBatchV1) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        options.call(request, batch),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              Object.assign(new Error("authorization timed out"), {
                code: "AUTHORIZATION_TIMEOUT",
              }),
            );
          }, options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
