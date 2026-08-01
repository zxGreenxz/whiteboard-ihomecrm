import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createPinnedHttpsRequest } from "../src/media/pinned-https.js";

describe("pinned HTTPS media requester", () => {
  it("connects using the vetted address while preserving TLS hostname validation", async () => {
    const request = vi.fn((options: Record<string, unknown>, onResponse: (response: unknown) => void) => {
      const pending = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
      pending.end = () => {
        const response = Object.assign(Readable.from([Buffer.from("media")]), {
          statusCode: 200,
          headers: { "content-type": "application/octet-stream", "content-length": "5" },
        });
        onResponse(response);
      };
      pending.destroy = () => undefined;
      return pending;
    });
    const send = createPinnedHttpsRequest({ request: request as never });

    const response = await send({
      url: new URL("https://cdn.zalo.me/media/1"),
      pinnedAddress: "1.1.1.1",
      resolvedAddresses: ["1.1.1.1"],
    });

    expect(await response.text()).toBe("media");
    const [options] = request.mock.calls[0]!;
    expect(options).toMatchObject({ hostname: "cdn.zalo.me", servername: "cdn.zalo.me" });
    const lookup = options.lookup as (
      hostname: string,
      options: unknown,
      callback: (error: Error | null, address: string, family: 4 | 6) => void,
    ) => void;
    expect(lookup("cdn.zalo.me", {}, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe("1.1.1.1");
      expect(family).toBe(4);
    })).toBeUndefined();
  });
});
