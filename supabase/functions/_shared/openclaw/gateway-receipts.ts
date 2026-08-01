import { base64UrlDecode, canonicalJson, sha256Hex, utf8 } from "./crypto.ts";
import { OpenClawHttpError } from "./errors.ts";

export type GatewayReceiptDomain =
  | "ihome-openclaw-retention-receipt-v1"
  | "ihome-openclaw-audit-receipt-v1"
  | "ihome-openclaw-media-upload-receipt-v1";

export interface VerifiedGatewayReceipt {
  receiptHash: string;
  gatewaySigningKeyGeneration: number;
}

export interface GatewayReceiptKeyMetadata {
  generation: number;
  publicKeySpkiBase64: string;
  activatesAt: string;
  retiresAt: string | null;
  revokedAt: string | null;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64Decode(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid base64 value.");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function invalidReceipt(): OpenClawHttpError {
  return new OpenClawHttpError(
    403,
    "GATEWAY_RECEIPT_INVALID",
    "Gateway receipt verification failed.",
  );
}

export async function verifyGatewayReceipt(input: {
  domain: GatewayReceiptDomain;
  receipt: Record<string, unknown>;
  keyRegistry?: Readonly<Record<string, GatewayReceiptKeyMetadata>>;
}): Promise<VerifiedGatewayReceipt> {
  const signature = input.receipt.signature;
  const generation = input.receipt.gatewaySigningKeyGeneration;
  const signedAt = input.receipt.receiptKind === "MEDIA_UPLOAD"
    ? input.receipt.storedAt
    : input.receipt.receiptKind === "AUDIT_ANCHOR_VERIFY"
    ? input.receipt.verifiedAt
    : input.receipt.receiptKind === "RETENTION_FINAL_DELETE"
    ? input.receipt.completedAt
    : null;
  if (
    typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
    !Number.isSafeInteger(generation) || Number(generation) < 1 ||
    typeof signedAt !== "string" || !Number.isFinite(new Date(signedAt).valueOf()) ||
    new Date(signedAt).toISOString() !== signedAt
  ) {
    throw invalidReceipt();
  }
  const key = input.keyRegistry?.[String(generation)];
  if (
    !key || key.generation !== generation || signedAt < key.activatesAt ||
    (key.retiresAt !== null && signedAt >= key.retiresAt) ||
    (key.revokedAt !== null && signedAt >= key.revokedAt)
  ) throw invalidReceipt();

  const unsignedReceipt = { ...input.receipt };
  delete unsignedReceipt.signature;
  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      ownedArrayBuffer(base64Decode(key.publicKeySpkiBase64)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      ownedArrayBuffer(base64UrlDecode(signature)),
      ownedArrayBuffer(utf8(`${input.domain}\0${canonicalJson(unsignedReceipt)}`)),
    );
    if (!valid) throw invalidReceipt();
    return {
      gatewaySigningKeyGeneration: Number(generation),
      receiptHash: await sha256Hex(
        utf8(`${input.domain}\0${canonicalJson(input.receipt)}`),
      ),
    };
  } catch (error) {
    if (error instanceof OpenClawHttpError) throw error;
    throw invalidReceipt();
  }
}
