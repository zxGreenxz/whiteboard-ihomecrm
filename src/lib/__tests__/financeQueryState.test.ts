import {
  onlineManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  classifyFinanceQueryError,
  deriveFinanceQueryState,
} from "@/lib/financeQueryState";

function getOfflinePausedResult(cachedData?: number[]) {
  const wasOnline = onlineManager.isOnline();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const queryKey = ["finance-query-state-offline"];
  let unsubscribe: (() => void) | undefined;

  try {
    onlineManager.setOnline(false);
    if (cachedData !== undefined) {
      queryClient.setQueryData(queryKey, cachedData);
    }

    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: async () => [2],
      staleTime: 0,
    });
    unsubscribe = observer.subscribe(() => undefined);

    return observer.getCurrentResult();
  } finally {
    try {
      unsubscribe?.();
    } finally {
      try {
        queryClient.clear();
      } finally {
        onlineManager.setOnline(wasOnline);
      }
    }
  }
}

describe("classifyFinanceQueryError", () => {
  it.each([
    [{ status: 401, message: "unauthorized" }, "blocking"],
    [{ status: 403, message: "forbidden" }, "blocking"],
    [{ code: "42501", message: "statement timeout" }, "blocking"],
    [new Error("permission denied for report"), "blocking"],
    [new Error("organization scope mismatch"), "blocking"],
    [new Error("validation failed"), "blocking"],
    [{ status: 429, message: "too many requests" }, "transient"],
    [{ status: 429, message: "authorization service rate limit" }, "transient"],
    [{ status: "429", message: "rate limited" }, "transient"],
    [new Error("Too many requests; retry later"), "transient"],
    [{ status: 503, message: "service unavailable" }, "transient"],
    [new Error("network connection failed"), "transient"],
    [new Error("request timed out"), "transient"],
  ] as const)("classifies %o as %s", (error, expected) => {
    expect(classifyFinanceQueryError(error)).toBe(expected);
  });
});

describe("deriveFinanceQueryState", () => {
  it("restores the online state that existed before the QueryObserver probe", () => {
    const wasOnline = onlineManager.isOnline();

    try {
      onlineManager.setOnline(false);
      getOfflinePausedResult();

      expect(onlineManager.isOnline()).toBe(false);
    } finally {
      onlineManager.setOnline(wasOnline);
    }
  });

  it("fails closed while an initial query is paused offline", () => {
    const query = getOfflinePausedResult();

    expect(query).toMatchObject({
      data: undefined,
      status: "pending",
      fetchStatus: "paused",
      isLoading: false,
      isError: false,
    });
    expect(deriveFinanceQueryState(query)).toMatchObject({
      canRenderData: false,
      showLoading: true,
      showStaleWarning: false,
      staleError: null,
      hasBlockingError: false,
      blockingError: null,
    });
  });

  it("keeps cached data visible with a stale warning while refetch is paused offline", () => {
    const query = getOfflinePausedResult([1]);

    expect(query).toMatchObject({
      data: [1],
      status: "success",
      fetchStatus: "paused",
      isLoading: false,
      isError: false,
    });
    expect(deriveFinanceQueryState(query)).toMatchObject({
      canRenderData: true,
      showLoading: false,
      showStaleWarning: true,
      staleError: null,
      hasBlockingError: false,
      blockingError: null,
    });
  });

  it("keeps cached data visible with a retryable warning for transient errors", () => {
    const error = new Error("network timeout");

    expect(
      deriveFinanceQueryState({
        data: [1],
        status: "error",
        fetchStatus: "idle",
        isLoading: false,
        isError: true,
        error,
      }),
    ).toMatchObject({
      canRenderData: true,
      showStaleWarning: true,
      staleError: error,
      hasBlockingError: false,
      blockingError: null,
    });
  });

  it("keeps cached data visible with a retryable warning after rate limiting", () => {
    const error = { status: 429, message: "too many requests" };

    expect(
      deriveFinanceQueryState({
        data: [1],
        status: "error",
        fetchStatus: "idle",
        isLoading: false,
        isError: true,
        error,
      }),
    ).toMatchObject({
      canRenderData: true,
      showStaleWarning: true,
      staleError: error,
      hasBlockingError: false,
      blockingError: null,
    });
  });

  it("blocks transient errors when no cached result exists", () => {
    const error = new Error("network timeout");

    expect(
      deriveFinanceQueryState({
        data: undefined,
        status: "error",
        fetchStatus: "idle",
        isLoading: false,
        isError: true,
        error,
      }),
    ).toMatchObject({
      canRenderData: false,
      showStaleWarning: false,
      hasBlockingError: true,
      blockingError: error,
    });
  });

  it("blocks permanent errors even when cached data exists", () => {
    const error = { code: "42501", message: "timeout while checking permission" };

    expect(
      deriveFinanceQueryState({
        data: [1],
        status: "error",
        fetchStatus: "idle",
        isLoading: false,
        isError: true,
        error,
      }),
    ).toMatchObject({
      canRenderData: false,
      showStaleWarning: false,
      hasBlockingError: true,
      blockingError: error,
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["false", false],
    ["zero", 0],
    ["empty string", ""],
  ])("fails closed for a cached query rejected with %s", (_label, error) => {
    expect(
      deriveFinanceQueryState({
        data: [1],
        status: "error",
        fetchStatus: "idle",
        isLoading: false,
        isError: true,
        error,
      }),
    ).toMatchObject({
      canRenderData: false,
      showStaleWarning: false,
      hasBlockingError: true,
      blockingError: error,
    });
  });

  it("lets validation errors override an otherwise transient cached refetch", () => {
    const validationError = new Error("validation failed");

    expect(
      deriveFinanceQueryState(
        {
          data: [1],
          status: "error",
          fetchStatus: "idle",
          isLoading: false,
          isError: true,
          error: new Error("network timeout"),
        },
        validationError,
      ),
    ).toMatchObject({
      canRenderData: false,
      showStaleWarning: false,
      hasBlockingError: true,
      blockingError: validationError,
    });
  });
});
