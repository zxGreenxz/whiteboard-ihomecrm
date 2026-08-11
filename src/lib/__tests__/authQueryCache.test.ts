import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  clearBusinessPerformanceReportFilters,
  syncAuthQueryCache,
} from "@/lib/authQueryCache";

function session(userId: string, accessToken = userId): Session {
  return {
    access_token: accessToken,
    user: { id: userId },
  } as unknown as Session;
}

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
    },
  });
}

function memoryStorage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function addPendingMutation(
  client: QueryClient,
  mutationKey: readonly unknown[],
) {
  client.getMutationCache().build(
    client,
    {
      mutationKey,
      mutationFn: async (): Promise<void> => undefined,
    },
    {
      context: undefined,
      data: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
      isPaused: false,
      status: "pending",
      variables: undefined,
      submittedAt: Date.now(),
    },
  );
}

describe("syncAuthQueryCache", () => {
  it("drops principal-bound query and mutation state before publishing user B then null", () => {
    const client = queryClient();
    const fetchDashboard = vi.fn(async () => "fresh-dashboard");
    const sessionA = session("user-a", "token-a");
    const sessionB = session("user-b", "token-b");

    client.setQueryData(["auth", "session"], sessionA);
    client.setQueryData(["auth", "user"], sessionA.user);
    client.setQueryData(["dashboard"], "dashboard-a");
    client.setQueryData(["inactive-report"], "report-a");
    client.setQueryData(["auth", "profile"], "profile-a");
    client.getMutationCache().build(client, {
      mutationKey: ["save-report"],
      mutationFn: async (): Promise<void> => undefined,
    });

    const dashboardObserver = new QueryObserver(client, {
      queryKey: ["dashboard"],
      queryFn: fetchDashboard,
      staleTime: Infinity,
    });
    const authObserver = new QueryObserver(client, {
      queryKey: ["auth", "user"],
      enabled: false,
    });
    const unsubscribeDashboard = dashboardObserver.subscribe(() => {});
    const unsubscribeAuth = authObserver.subscribe(() => {});

    syncAuthQueryCache(client, "SIGNED_IN", sessionB, null, () => {});

    expect(dashboardObserver.getCurrentResult().data).toBeUndefined();
    expect(fetchDashboard).not.toHaveBeenCalled();
    expect(client.getQueryState(["dashboard"])).toBeDefined();
    expect(client.getQueryState(["inactive-report"])).toBeUndefined();
    expect(client.getQueryState(["auth", "profile"])).toBeUndefined();
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(client.getQueryData(["auth", "session"])).toStrictEqual(sessionB);
    expect(authObserver.getCurrentResult().data).toStrictEqual(sessionB.user);

    syncAuthQueryCache(client, "SIGNED_OUT", null, null, () => {});

    expect(client.getQueryData(["auth", "session"])).toBeNull();
    expect(authObserver.getCurrentResult().data).toBeNull();

    unsubscribeAuth();
    unsubscribeDashboard();
  });

  it("deferred-refetches an active same-key query exactly once under user B", async () => {
    const client = queryClient();
    const sessionA = session("user-a", "token-a");
    const sessionB = session("user-b", "token-b");
    const fetchedAsUsers: Array<string | null> = [];
    const fetchDashboard = vi.fn(async () => {
      const user = client.getQueryData<{ id: string }>(["auth", "user"]);
      fetchedAsUsers.push(user?.id ?? null);
      return "fresh-dashboard";
    });
    let scheduledRefetch: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void) => {
      scheduledRefetch = callback;
    });

    client.setQueryData(["auth", "session"], sessionA);
    client.setQueryData(["auth", "user"], sessionA.user);
    client.setQueryData(["dashboard"], "dashboard-a");
    const observerOptions = {
      queryKey: ["dashboard"] as const,
      queryFn: fetchDashboard,
      staleTime: Infinity,
    };
    const observer = new QueryObserver(client, observerOptions);
    const unsubscribe = observer.subscribe(() => {});

    syncAuthQueryCache(client, "SIGNED_IN", sessionB, null, schedule);
    observer.setOptions(observerOptions);

    expect(fetchDashboard).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(scheduledRefetch).toBeTypeOf("function");

    scheduledRefetch?.();
    await vi.waitFor(() => expect(fetchDashboard).toHaveBeenCalledTimes(1));
    expect(fetchedAsUsers).toEqual(["user-b"]);

    unsubscribe();
  });

  it("skips a deferred SIGNED_OUT refetch after the reset query becomes inactive", async () => {
    const client = queryClient();
    const sessionA = session("user-a", "token-a");
    const fetchDashboard = vi.fn(async () => "fresh-dashboard");
    let scheduledRefetch: (() => void) | undefined;

    client.setQueryData(["auth", "session"], sessionA);
    client.setQueryData(["auth", "user"], sessionA.user);
    client.setQueryData(["dashboard"], "dashboard-a");
    const observer = new QueryObserver(client, {
      queryKey: ["dashboard"],
      queryFn: fetchDashboard,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});

    syncAuthQueryCache(client, "SIGNED_OUT", null, null, (callback) => {
      scheduledRefetch = callback;
    });
    expect(scheduledRefetch).toBeTypeOf("function");
    unsubscribe();
    scheduledRefetch?.();
    await Promise.resolve();

    expect(fetchDashboard).not.toHaveBeenCalled();
  });

  it("resets a mounted disabled query without scheduling a refetch", () => {
    const client = queryClient();
    const sessionA = session("user-a", "token-a");
    const sessionB = session("user-b", "token-b");
    const fetchDisabledPanel = vi.fn(async () => "fresh-panel");
    const schedule = vi.fn();

    client.setQueryData(["auth", "session"], sessionA);
    client.setQueryData(["auth", "user"], sessionA.user);
    client.setQueryData(["disabled-panel"], "panel-a");
    const observer = new QueryObserver(client, {
      queryKey: ["disabled-panel"],
      queryFn: fetchDisabledPanel,
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    const query = client.getQueryCache().find({ queryKey: ["disabled-panel"] });

    expect(query?.getObserversCount()).toBe(1);
    expect(query?.isActive()).toBe(false);
    syncAuthQueryCache(client, "SIGNED_IN", sessionB, null, schedule);

    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(client.getQueryState(["disabled-panel"])).toBeDefined();
    expect(fetchDisabledPanel).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("reloads immediately for a pending non-auth mutation and skips deferred refetch", () => {
    const client = queryClient();
    const sessionA = session("user-a", "token-a");
    const sessionB = session("user-b", "token-b");
    const schedule = vi.fn();
    const reloadDocument = vi.fn(() => {
      expect(client.getQueryData(["auth", "user"])).toStrictEqual(sessionB.user);
      expect(client.getQueryData(["dashboard"])).toBeUndefined();
      return true;
    });

    client.setQueryData(["auth", "session"], sessionA);
    client.setQueryData(["auth", "user"], sessionA.user);
    client.setQueryData(["dashboard"], "dashboard-a");
    const observer = new QueryObserver(client, {
      queryKey: ["dashboard"],
      queryFn: async () => "fresh-dashboard",
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    addPendingMutation(client, ["save-report"]);

    syncAuthQueryCache(
      client,
      "SIGNED_IN",
      sessionB,
      null,
      schedule,
      reloadDocument,
    );

    expect(reloadDocument).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
    expect(client.getMutationCache().getAll()).toHaveLength(0);

    unsubscribe();
  });

  it("keeps deferred refetch as fallback when pending-mutation reload fails", () => {
    const client = queryClient();
    const sessionA = session("user-a", "token-a");
    const sessionB = session("user-b", "token-b");
    const schedule = vi.fn();
    const reloadDocument = vi.fn(() => false);

    client.setQueryData(["auth", "user"], sessionA.user);
    client.setQueryData(["dashboard"], "dashboard-a");
    const observer = new QueryObserver(client, {
      queryKey: ["dashboard"],
      queryFn: async () => "fresh-dashboard",
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    addPendingMutation(client, ["save-report"]);

    syncAuthQueryCache(
      client,
      "SIGNED_IN",
      sessionB,
      null,
      schedule,
      reloadDocument,
    );

    expect(reloadDocument).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("does not reload for a pending auth mutation and keeps normal scheduling", () => {
    const client = queryClient();
    const sessionA = session("user-a", "token-a");
    const sessionB = session("user-b", "token-b");
    const schedule = vi.fn();
    const reloadDocument = vi.fn(() => true);

    client.setQueryData(["auth", "user"], sessionA.user);
    client.setQueryData(["dashboard"], "dashboard-a");
    const observer = new QueryObserver(client, {
      queryKey: ["dashboard"],
      queryFn: async () => "fresh-dashboard",
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    addPendingMutation(client, ["auth", "login"]);

    syncAuthQueryCache(
      client,
      "SIGNED_IN",
      sessionB,
      null,
      schedule,
      reloadDocument,
    );

    expect(reloadDocument).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("preserves non-auth cache for a same-user token refresh", () => {
    const client = queryClient();
    const sessionA = session("user-a", "token-a");
    const refreshedSessionA = session("user-a", "token-a-refreshed");
    client.setQueryData(["auth", "user"], sessionA.user);
    client.setQueryData(["auth", "session"], sessionA);
    client.setQueryData(["dashboard"], "dashboard-a");

    syncAuthQueryCache(client, "TOKEN_REFRESHED", refreshedSessionA, null);

    expect(client.getQueryData(["dashboard"])).toBe("dashboard-a");
    expect(client.getQueryData(["auth", "session"])).toStrictEqual(
      refreshedSessionA,
    );
  });

  it("treats INITIAL_SESSION without prior auth query state as bootstrap", () => {
    const client = queryClient();
    const sessionA = session("user-a");
    client.setQueryData(["dashboard"], "bootstrap-data");
    client.getMutationCache().build(client, {
      mutationKey: ["bootstrap-mutation"],
      mutationFn: async (): Promise<void> => undefined,
    });

    syncAuthQueryCache(client, "INITIAL_SESSION", sessionA, null);

    expect(client.getQueryData(["dashboard"])).toBe("bootstrap-data");
    expect(client.getMutationCache().getAll()).toHaveLength(1);
    expect(client.getQueryData(["auth", "user"])).toBe(sessionA.user);
  });

  it("treats INITIAL_SESSION with unknown pending auth data as bootstrap", () => {
    const client = queryClient();
    const sessionA = session("user-a");
    const storage = memoryStorage({
      "flt:rpt-business-performance:period": "2026-07",
    });
    const schedule = vi.fn();
    client.getQueryCache().build(client, {
      queryKey: ["auth", "user"],
      queryFn: async () => sessionA.user,
    });
    client.setQueryData(["dashboard"], "bootstrap-data");
    client.getMutationCache().build(client, {
      mutationKey: ["bootstrap-mutation"],
      mutationFn: async (): Promise<void> => undefined,
    });
    const dashboardObserver = new QueryObserver(client, {
      queryKey: ["dashboard"],
      queryFn: async () => "fresh-dashboard",
      staleTime: Infinity,
    });
    const unsubscribeDashboard = dashboardObserver.subscribe(() => {});

    expect(client.getQueryState(["auth", "user"])?.data).toBeUndefined();
    syncAuthQueryCache(client, "INITIAL_SESSION", sessionA, storage, schedule);

    expect(dashboardObserver.getCurrentResult().data).toBe("bootstrap-data");
    expect(client.getMutationCache().getAll()).toHaveLength(1);
    expect(storage.getItem("flt:rpt-business-performance:period")).toBe(
      "2026-07",
    );
    expect(schedule).not.toHaveBeenCalled();
    expect(client.getQueryData(["auth", "session"])).toStrictEqual(sessionA);
    expect(client.getQueryData(["auth", "user"])).toStrictEqual(sessionA.user);

    unsubscribeDashboard();
  });
});

describe("clearBusinessPerformanceReportFilters", () => {
  it("removes only business-performance report filters", () => {
    const storage = memoryStorage({
      "flt:rpt-business-performance:period": "2026-07",
      "flt:rpt-business-performance:buildings": "[]",
      "flt:other-report:period": "2026-06",
    });

    clearBusinessPerformanceReportFilters(storage);

    expect(storage.getItem("flt:rpt-business-performance:period")).toBeNull();
    expect(storage.getItem("flt:rpt-business-performance:buildings")).toBeNull();
    expect(storage.getItem("flt:other-report:period")).toBe("2026-06");
  });

  it("swallows unavailable storage errors", () => {
    const storage = {
      get length() {
        throw new DOMException("blocked", "SecurityError");
      },
    } as unknown as Storage;

    expect(() => clearBusinessPerformanceReportFilters(storage)).not.toThrow();
  });
});
