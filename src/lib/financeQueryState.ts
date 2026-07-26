export type FinanceQueryErrorKind = "transient" | "blocking";

interface FinanceQueryLike<T> {
  data: T | undefined;
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

interface FinanceQueryState {
  canRenderData: boolean;
  showLoading: boolean;
  showStaleWarning: boolean;
  staleError: unknown | null;
  hasBlockingError: boolean;
  blockingError: unknown | null;
}

function errorDetails(error: unknown) {
  const record = error && typeof error === "object"
    ? (error as Record<string, unknown>)
    : null;
  const rawStatus = record?.status;
  const status = typeof rawStatus === "number"
    ? rawStatus
    : typeof rawStatus === "string" && /^\d+$/.test(rawStatus)
      ? Number(rawStatus)
      : null;
  const code = typeof record?.code === "string" ? record.code.toLowerCase() : "";
  const name = typeof record?.name === "string" ? record.name.toLowerCase() : "";
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof record?.message === "string"
        ? record.message
        : "";
  return { code, name, status, message: message.toLowerCase() };
}

export function classifyFinanceQueryError(error: unknown): FinanceQueryErrorKind {
  const { code, name, status, message } = errorDetails(error);

  if (status === 429) {
    return "transient";
  }

  if (
    status === 401 ||
    status === 403 ||
    code === "42501" ||
    name.includes("validation") ||
    name.includes("businessperformancedataerror") ||
    /permission|authori[sz]ation|unauthori[sz]ed|forbidden|access denied|scope|validation|malformed|invalid payload/.test(message)
  ) {
    return "blocking";
  }

  if (
    (status != null && status >= 500 && status <= 599) ||
    /timeout|timed out|network|failed to fetch|connection|econn|socket|service unavailable|too many requests|rate[- ]limit(?:ed|ing)?/.test(message)
  ) {
    return "transient";
  }

  return "blocking";
}

export function deriveFinanceQueryState<T>(
  query: FinanceQueryLike<T>,
  validationError: unknown | null = null,
): FinanceQueryState {
  const hasCachedData = query.data !== undefined;
  const isInitialPaused =
    query.status === "pending" &&
    query.fetchStatus === "paused" &&
    !hasCachedData;
  const isCachedPaused =
    query.status === "success" &&
    query.fetchStatus === "paused" &&
    hasCachedData &&
    validationError == null;
  const isTransientCachedError =
    query.isError &&
    hasCachedData &&
    validationError == null &&
    classifyFinanceQueryError(query.error) === "transient";
  const hasValidationError = validationError != null;
  const hasBlockingError =
    hasValidationError || (query.isError && !isTransientCachedError);
  const blockingError = hasValidationError ? validationError : (
    query.isError && !isTransientCachedError ? query.error : null
  );
  const showLoading = query.isLoading || isInitialPaused;
  const showStaleWarning = isTransientCachedError || isCachedPaused;

  return {
    canRenderData: !showLoading && !hasBlockingError,
    showLoading,
    showStaleWarning,
    staleError: isTransientCachedError ? query.error : null,
    hasBlockingError,
    blockingError,
  };
}
