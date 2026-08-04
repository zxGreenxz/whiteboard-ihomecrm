import type { QueryClient } from "@tanstack/react-query";

const IDENTITY_SCOPED_QUERY_KEYS = [
  ["my-permissions"],
  ["buildings"],
  ["network-center"],
] as const;

export function createAuthIdentityCacheIsolator(queryClient: QueryClient) {
  let initialized = false;
  let currentUserId: string | null = null;

  return (nextUserId: string | null | undefined): boolean => {
    const normalizedUserId = nextUserId ?? null;
    if (!initialized) {
      initialized = true;
      currentUserId = normalizedUserId;
      return false;
    }
    if (currentUserId === normalizedUserId) return false;

    for (const queryKey of IDENTITY_SCOPED_QUERY_KEYS) {
      queryClient.removeQueries({ queryKey: [...queryKey] });
    }
    currentUserId = normalizedUserId;
    return true;
  };
}
