/**
 * Redirect policy for inbound media fetches. Every hop is revalidated: scheme,
 * host allowlist, and hop count. A redirect can never move the fetch to a new
 * host class or downgrade the scheme.
 */

export const MAX_REDIRECTS = 3;

export type RedirectDenialReason =
  | "TOO_MANY_REDIRECTS"
  | "SCHEME_DOWNGRADE"
  | "NON_DEFAULT_PORT"
  | "HOST_NOT_ALLOWED"
  | "INVALID_URL";

export interface RedirectVerdict {
  allowed: boolean;
  reason?: RedirectDenialReason;
}

export function isAllowedMediaHost(host: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function evaluateRedirectChain(
  urls: readonly string[],
  allowlist: readonly string[],
): RedirectVerdict {
  if (urls.length === 0) return { allowed: false, reason: "INVALID_URL" };
  if (urls.length - 1 > MAX_REDIRECTS) return { allowed: false, reason: "TOO_MANY_REDIRECTS" };

  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { allowed: false, reason: "INVALID_URL" };
    }
    if (url.protocol !== "https:") return { allowed: false, reason: "SCHEME_DOWNGRADE" };
    if (url.port !== "") return { allowed: false, reason: "NON_DEFAULT_PORT" };
    if (url.username || url.password) return { allowed: false, reason: "INVALID_URL" };
    if (!isAllowedMediaHost(url.hostname, allowlist)) {
      return { allowed: false, reason: "HOST_NOT_ALLOWED" };
    }
  }
  return { allowed: true };
}
