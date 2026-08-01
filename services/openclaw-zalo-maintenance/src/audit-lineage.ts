import { canonicalJson, sha256Hex } from "./runtime-client.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const AUDIT_LINEAGE_ROOT_DOMAIN = "ihome-openclaw-audit-lineage-root-v1\0";

export interface AuditLineageRootInput {
  organizationId: string;
  rootDate: string;
  firstSequence: number;
  lastSequence: number;
  eventCount: number;
  previousRootHash: string | null;
  merkleRootHash: string;
  rootHash: string;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function sha256(value: string, name: string): string {
  if (!SHA256.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

export function assertAuditLineageRoot(input: AuditLineageRootInput): void {
  if (!UUID.test(input.organizationId)) throw new TypeError("organizationId is invalid");
  if (!DATE.test(input.rootDate)) throw new TypeError("rootDate is invalid");
  const parsedDate = Date.parse(`${input.rootDate}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsedDate) ||
    new Date(parsedDate).toISOString().slice(0, 10) !== input.rootDate
  ) throw new TypeError("rootDate is invalid");
  const firstSequence = positiveSafeInteger(input.firstSequence, "firstSequence");
  const lastSequence = positiveSafeInteger(input.lastSequence, "lastSequence");
  const eventCount = positiveSafeInteger(input.eventCount, "eventCount");
  if (lastSequence < firstSequence || eventCount !== lastSequence - firstSequence + 1) {
    throw new TypeError("audit root sequence range is invalid");
  }
  const previousRootHash = input.previousRootHash === null
    ? null
    : sha256(input.previousRootHash, "previousRootHash");
  const merkleRootHash = sha256(input.merkleRootHash, "merkleRootHash");
  const rootHash = sha256(input.rootHash, "rootHash");
  const expectedRootHash = sha256Hex(
    AUDIT_LINEAGE_ROOT_DOMAIN + canonicalJson({
      version: 1,
      organizationId: input.organizationId,
      rootDate: input.rootDate,
      firstSequence,
      lastSequence,
      eventCount,
      previousRootHash,
      merkleRootHash,
    }),
  );
  if (rootHash !== expectedRootHash) {
    throw new TypeError("audit lineage root hash mismatch");
  }
}
