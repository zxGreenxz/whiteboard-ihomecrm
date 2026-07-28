const CONTROL_KINDS = new Set(["typing", "seen", "delivery-receipt"]);
const BUSINESS_KEYS = new Set([
  "caption",
  "content",
  "emoji",
  "frames",
  "link",
  "media",
  "message",
  "text",
  "url",
]);

export type ControlTraffic = Readonly<{
  kind: "typing" | "seen" | "delivery-receipt";
  providerMessageId?: string;
  threadId: string;
}>;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function classifyControlTraffic(candidate: unknown): ControlTraffic {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    fail("INVALID_CONTROL_TRAFFIC", "control traffic must be an object");
  }
  const record = candidate as Record<string, unknown>;
  if (!CONTROL_KINDS.has(String(record.kind))) {
    fail("INVALID_CONTROL_TRAFFIC", "unknown control traffic kind");
  }
  if (typeof record.threadId !== "string" || record.threadId.trim() === "") {
    fail("INVALID_CONTROL_TRAFFIC", "control traffic threadId is required");
  }
  if (Object.keys(record).some((key) => BUSINESS_KEYS.has(key))) {
    fail("CONTROL_TRAFFIC_HAS_BUSINESS_CONTENT", "control traffic cannot carry business content");
  }
  return candidate as ControlTraffic;
}

export function createControlTrafficSender(options: {
  sendControl(frame: ControlTraffic): Promise<void>;
}) {
  return async (candidate: unknown) => {
    const frame = classifyControlTraffic(candidate);
    await options.sendControl(frame);
  };
}
