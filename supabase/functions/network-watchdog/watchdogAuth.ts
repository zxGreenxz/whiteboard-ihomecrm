const encoder = new TextEncoder();

/**
 * Thrown when `NETWORK_WATCHDOG_CRON_SECRET` is absent or too weak to be a
 * secret. It is deliberately distinct from "the caller presented the wrong
 * secret": an unconfigured watchdog must answer 500, never 200 and never 401,
 * because "nobody set a secret" must not read as "the request is fine" and must
 * not read as "someone tried and failed" either.
 */
export class WatchdogConfigError extends Error {
  constructor() {
    super("Watchdog cron secret is not configured");
    this.name = "WatchdogConfigError";
  }
}

/**
 * Compares the presented secret with the configured one in constant time.
 *
 * Both sides are hashed first, so the comparison runs over two fixed 32-byte
 * digests: the loop length leaks nothing about the configured secret, and a
 * caller cannot learn its length by probing prefixes. The loop is unconditional
 * - no early return - so it also leaks nothing about the position of the first
 * differing byte.
 */
export async function watchdogSecretMatches(
  presented: string,
  configured: string | undefined,
): Promise<boolean> {
  if (
    typeof configured !== "string"
    || configured.length < 32
    || configured.length > 512
  ) {
    throw new WatchdogConfigError();
  }
  const [presentedDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  const left = new Uint8Array(presentedDigest);
  const right = new Uint8Array(configuredDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
