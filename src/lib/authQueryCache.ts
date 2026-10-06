import {
  notifyManager,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import {
  browserLocalStorage,
  browserSessionStorage,
  clearAccountBrowserState,
} from "@/lib/accountBrowserState";

const AUTH_SESSION_QUERY_KEY = ["auth", "session"] as const;
const AUTH_USER_QUERY_KEY = ["auth", "user"] as const;

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

/**
 * Đọc lại các khu vực ĐANG HIỆN mà lần tải trước đã lỗi.
 *
 * Gọi khi có lý do mới để tin lần đọc sau sẽ được: token vừa làm mới, hoặc tab vừa hiện lại
 * (iPhone treo tab nền, mở lại thì request đầu có thể hỏng trước khi mạng/phiên kịp hồi).
 * Trước đây người dùng phải tự bấm "Tải lại" (báo lỗi 01/10/2026 ở màn Tài khoản).
 * Chỉ đụng query đang lỗi — query đang có dữ liệu tươi không bị gọi lại.
 */
export function refetchFailedActiveQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.refetchQueries({
    type: "active",
    predicate: (query) =>
      query.state.status === "error" && !isLiveAuthQueryKey(query.queryKey),
  });
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
  storage: Storage | null = browserSessionStorage(),
  schedule: AuthQueryRefetchScheduler = scheduleMacrotask,
  reloadDocument: AuthDocumentReloader = reloadDocumentSafely,
  localStore: Storage | null = browserLocalStorage(),
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
  const pendingMutations = principalChanged
    ? mutationCache
        .getAll()
        .filter((mutation) => mutation.state.status === "pending")
    : [];
  const hasPendingNonAuthMutation = pendingMutations.some(
    (mutation) => !isAuthMutationKey(mutation.options.mutationKey),
  );
  // Tài khoản đang đăng nhập rời tab mà tab này không tự làm: hết phiên, đăng xuất
  // hay đổi tài khoản ở tab khác. Nạp lại trang để không còn gì của tài khoản cũ
  // trong bộ nhớ JS (bộ lọc đang giữ trong state, cache module). Đăng nhập/đăng
  // xuất ngay trong tab thì mutation ['auth', …] đang chạy và tự điều hướng
  // (useLogout nạp lại trang /login) — nạp lại chen ngang sẽ cắt luồng đó.
  // PASSWORD_RECOVERY: trang đặt lại mật khẩu cần chính sự kiện này, nạp lại là mất.
  const leftSignedInAccount =
    principalChanged &&
    previousUserId !== null &&
    previousUserId !== nextUserId &&
    event !== "PASSWORD_RECOVERY" &&
    !pendingMutations.some((mutation) =>
      isAuthMutationKey(mutation.options.mutationKey),
    );

  notifyManager.batch(() => {
    if (principalChanged) {
      // Bộ lọc/lựa chọn của tài khoản trước không được sang tài khoản sau
      // (báo lỗi 06/10/2026, xem src/lib/accountBrowserState.ts).
      clearAccountBrowserState(storage, localStore);
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
  if (hasPendingNonAuthMutation || leftSignedInAccount) {
    // TanStack cannot cancel running mutation callbacks or queued microtasks;
    // reloading is the strongest generic boundary for tearing down the old realm.
    try {
      reloadInitiated = reloadDocument();
    } catch {
      reloadInitiated = false;
    }
  }

  if (
    !principalChanged &&
    nextUserId !== null &&
    (event === "TOKEN_REFRESHED" || event === "SIGNED_IN")
  ) {
    schedule(() => {
      void refetchFailedActiveQueries(queryClient);
    });
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
