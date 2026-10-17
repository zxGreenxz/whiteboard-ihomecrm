/** Tolerance for comparing an instant issued by the database (clock_timestamp(),
 * clock_timestamp() + interval, a renewal target) with this host's Date.now().
 * Supabase and the connector host are synchronized independently; the DB was
 * observed a few tens of ms ahead, so a strict `dbInstant > now` rejected about
 * half of the fresh reads. Add it ONLY to upper bounds ("not from the future",
 * "not longer than N from now"). Expiry (`<= now`) and staleness checks stay
 * strict, and instants this process issued itself never get it.
 * connection-control-plane keeps its own wider prepare-intent allowance. */
export const DB_CLOCK_SKEW_MS = 5_000;
