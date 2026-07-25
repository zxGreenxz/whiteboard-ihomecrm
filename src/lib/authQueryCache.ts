import {
  notifyManager,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";

const AUTH_SESSION_QUERY_KEY = ["auth", "session"] as const;
const AUTH_USER_QUERY_KEY = ["auth", "user"] as const;
const BUSINESS_PERFORMANCE_FILTER_PREFIX =
  "flt:rpt-business-performance:";

type AuthQueryRefetchScheduler = (callback: () => void) => void;
type AuthDocumentReloader = () => boolean;

const scheduleMacrotask: AuthQueryRefetchScheduler = (callback) => {
  globalThis.setTimeout(callback, 0);
};

const reloadDocumentSafely: AuthDocumentReloader = () => {
  try {
    if (typeof window === "undefined") return false;
    window.location.reload();
    return true;
  } catch {
    return false;
  }
};

function authUserId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("id" in value)) return null;
  return typeof value.id === "string" ? value.id : null;
}

function isLiveAuthQueryKey(queryKey: QueryKey): boolean {
  return (
    queryKey.length === 2 &&
    queryKey[0] === "auth" &&
    (queryKey[1] === "user" || queryKey[1] === "session")
  );
}

function isAuthMutationKey(mutationKey: readonly unknown[] | undefined) {
  return mutationKey?.[0] === "auth";
}

function sessionStorageSafely(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function clearBusinessPerformanceReportFilters(
  storage: Storage | null = sessionStorageSafely(),
): void {
  if (!storage) return;

  const matchingKeys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(BUSINESS_PERFORMANCE_FILTER_PREFIX)) {
        matchingKeys.push(key);
      }
    }
  } catch {
    return;
  }

  for (const key of matchingKeys) {
    try {
      storage.removeItem(key);
    } catch {
      // Storage may become unavailable between enumeration and removal.
    }
  }
}

export function didAuthPrincipalChange(
  event: AuthChangeEvent,
  previousPrincipalKnown: boolean,
  previousUserId: string | null,
  nextUserId: string | null,
): boolean {
  return (
    event === "SIGNED_OUT" ||
    (previousPrincipalKnown && previousUserId !== nextUserId)
  );
}

export function syncAuthQueryCache(
  queryClient: QueryClient,
  event: AuthChangeEvent,
  session: Session | null,
  storage: Storage | null = sessionStorageSafely(),
  schedule: AuthQueryRefetchScheduler = scheduleMacrotask,
  reloadDocument: AuthDocumentReloader = reloadDocumentSafely,
): void {
  const previousUserState = queryClient.getQueryState(AUTH_USER_QUERY_KEY);
  const previousUserId = authUserId(previousUserState?.data);
  const nextUserId = session?.user.id ?? null;
  const principalChanged = didAuthPrincipalChange(
    event,
    previousUserState?.data !== undefined,
    previousUserId,
    nextUserId,
  );
  const resetQueryHashes = new Set<string>();
  const mutationCache = queryClient.getMutationCache();
  const hasPendingNonAuthMutation =
    principalChanged &&
    mutationCache
      .getAll()
      .some(
        (mutation) =>
          mutation.state.status === "pending" &&
          !isAuthMutationKey(mutation.options.mutationKey),
      );

  notifyManager.batch(() => {
    if (principalChanged) {
      clearBusinessPerformanceReportFilters(storage);
      const queryCache = queryClient.getQueryCache();
      for (const query of queryCache.getAll()) {
        if (isLiveAuthQueryKey(query.queryKey)) continue;
        const wasActive = query.isActive();
        if (query.getObserversCount() > 0) {
          if (wasActive) resetQueryHashes.add(query.queryHash);
          query.reset();
        } else {
          queryCache.remove(query);
        }
      }
      mutationCache.clear();
    }

    queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, session);
    queryClient.setQueryData(AUTH_USER_QUERY_KEY, session?.user ?? null);
  });

  let reloadInitiated = false;
  if (hasPendingNonAuthMutation) {
    // TanStack cannot cancel running mutation callbacks or queued microtasks;
    // reloading is the strongest generic boundary for tearing down the old realm.
    try {
      reloadInitiated = reloadDocument();
    } catch {
      reloadInitiated = false;
    }
  }

  if (!reloadInitiated && resetQueryHashes.size > 0) {
    schedule(() => {
      void queryClient.refetchQueries({
        type: "active",
        predicate: (query) =>
          resetQueryHashes.has(query.queryHash) &&
          !isLiveAuthQueryKey(query.queryKey),
      });
    });
  }
}
