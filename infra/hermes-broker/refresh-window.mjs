/** Least token lease a provider-session refresh may start under, for both the
 * maintenance lane and the recovery lane. The SQL refresh fence needs a live
 * token at every step and quarantines the session for good (RECONNECT_REQUIRED)
 * when the token lapses mid-refresh, while a lapsed lease alone is recoverable:
 * the recovery lane revives it and refreshes inside a fresh 5-minute window.
 * So with less than this left a refresh is not started; the attempt fails before
 * any dispatch and a later one runs with a longer lease. One refresh is bounded
 * well below it (store steps and provider calls of at most 10 s each inside a
 * 30 s SQL lease, the lanes' own 60 s deadline). Compared against a DB-issued
 * expiry with this host's clock; the margin absorbs DB_CLOCK_SKEW_MS. */
export const MIN_REFRESH_WINDOW_MS = 150_000;
