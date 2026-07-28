import { createHash } from "node:crypto";

export type InboundMedia = Readonly<{
  contentType?: string;
  name?: string;
  size?: number;
  url?: string;
}>;

export type InboundEnvelope = Readonly<{
  accountId?: string;
  content: unknown;
  media?: readonly InboundMedia[];
  occurredAt: string;
  providerMessageId: string;
  senderId: string;
  threadId: string;
}>;

export type DurableInboundRecord = InboundEnvelope & Readonly<{
  accountId: string;
  dedupeKey: string;
}>;

export type CommitResult = Readonly<{
  status: "committed" | "duplicate" | "collision";
}>;

export type InboundBridgeCommitter = (
  request: Readonly<{ accountId: string; envelope: unknown }>,
) => Promise<CommitResult>;

let inboundBridgeCommitter: InboundBridgeCommitter | undefined;

export class InboundIdCollisionError extends Error {
  readonly code = "INBOUND_ID_COLLISION";

  constructor(message = "provider message id collision") {
    super(message);
    this.name = "InboundIdCollisionError";
  }
}

export class InboundBridgeUnavailableError extends Error {
  readonly code = "INBOUND_BRIDGE_UNAVAILABLE";

  constructor(message = "cell-local inbound bridge committer is unavailable") {
    super(message);
    this.name = "InboundBridgeUnavailableError";
  }
}

function required(name: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function makeRecord(accountId: string, envelope: InboundEnvelope): DurableInboundRecord {
  const providerMessageId = required("providerMessageId", envelope.providerMessageId);
  const senderId = required("senderId", envelope.senderId);
  const threadId = required("threadId", envelope.threadId);
  const occurredAt = required("occurredAt", envelope.occurredAt);
  const media = (envelope.media ?? []).map((item) => ({ ...item }));
  const identity = [accountId, providerMessageId, threadId].join("\0");
  const dedupeKey = createHash("sha256").update(identity, "utf8").digest("hex");
  return Object.freeze({
    accountId,
    content: envelope.content,
    dedupeKey,
    media,
    occurredAt,
    providerMessageId,
    senderId,
    threadId,
  });
}

export function createDurableInboundListener(options: {
  accountId: string;
  commit(record: DurableInboundRecord): Promise<CommitResult>;
  dispatch(record: DurableInboundRecord): Promise<void>;
}) {
  const accountId = required("accountId", options.accountId);
  return async function onProviderMessage(envelope: InboundEnvelope) {
    const record = makeRecord(accountId, envelope);
    const committed = await options.commit(record);
    if (committed.status === "duplicate") return { status: "duplicate" as const };
    if (committed.status === "collision") throw new InboundIdCollisionError();
    if (committed.status !== "committed") {
      throw new Error("inbound commit returned an unknown status");
    }
    await options.dispatch(record);
    return { status: "dispatched" as const };
  };
}

export function installInboundBridgeCommitter(committer: InboundBridgeCommitter): () => void {
  if (typeof committer !== "function") throw new TypeError("committer must be a function");
  inboundBridgeCommitter = committer;
  return () => {
    if (inboundBridgeCommitter === committer) inboundBridgeCommitter = undefined;
  };
}

export async function commitInboundThroughBridge(
  accountId: string,
  envelope: unknown,
): Promise<CommitResult> {
  const committer = inboundBridgeCommitter;
  if (!committer) throw new InboundBridgeUnavailableError();
  return await committer({ accountId: required("accountId", accountId), envelope });
}

export function isInboundControlContent(content: unknown): boolean {
  if (!content || typeof content !== "object") return false;
  const kind = (content as Record<string, unknown>).kind;
  return kind === "typing" || kind === "seen" || kind === "delivery-receipt";
}
