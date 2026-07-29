const DISPOSABLE_MARKER_PATTERN =
  /^network-center-disposable:v1:([a-z0-9-]{8,64})$/i;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MAX_SENTINEL_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export function assertDisposableTenantTestTarget(
  { projectRef, marker, host, expiresAt },
  { productionRefs = new Set(), now = new Date() } = {},
) {
  const normalizedProjectRef = String(projectRef ?? "").trim();
  if (!normalizedProjectRef || productionRefs.has(normalizedProjectRef)) {
    throw new Error("Cross-tenant test refuses production project reference");
  }

  const markerMatch = String(marker ?? "").match(DISPOSABLE_MARKER_PATTERN);
  if (!markerMatch) {
    throw new Error("Cross-tenant test requires an immutable disposable marker");
  }

  const normalizedHost = String(host ?? "").trim().toLowerCase();
  if (!LOCAL_HOSTS.has(normalizedHost)) {
    throw new Error("Cross-tenant test target must be the per-run local Supabase stack");
  }

  const expiry = new Date(String(expiresAt ?? ""));
  if (Number.isNaN(expiry.getTime())) {
    throw new Error("Disposable database sentinel expiry is invalid");
  }
  const remainingLifetime = expiry.getTime() - now.getTime();
  if (remainingLifetime <= 0) {
    throw new Error("Disposable database sentinel has expired");
  }
  if (remainingLifetime > MAX_SENTINEL_LIFETIME_MS) {
    throw new Error("Disposable database sentinel cannot exceed 24 hours");
  }

  return {
    projectRef: normalizedProjectRef,
    host: normalizedHost,
    runId: markerMatch[1],
    expiresAt: expiry.toISOString(),
  };
}
