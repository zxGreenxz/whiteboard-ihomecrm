const encoder = new TextEncoder();

export class WorkerCredentialError extends Error {
  constructor() {
    super("Worker credential is invalid");
    this.name = "WorkerCredentialError";
  }
}

export async function credentialDigestHex(secret: string): Promise<string> {
  if (secret.length < 32 || secret.length > 512) {
    throw new WorkerCredentialError();
  }

  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
