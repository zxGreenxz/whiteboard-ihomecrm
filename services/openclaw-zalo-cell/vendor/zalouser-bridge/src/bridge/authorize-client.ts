import type { BusinessFrame, SendContext } from "./send-context.js";

export function createAuthorizeClient(options: {
  call(context: SendContext, frames: readonly BusinessFrame[]): Promise<void>;
  timeoutMs: number;
}) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  return async (context: SendContext, frames: readonly BusinessFrame[]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        options.call(context, frames),
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
