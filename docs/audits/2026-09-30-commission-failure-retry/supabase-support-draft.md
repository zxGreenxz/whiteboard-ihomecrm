# Supabase support draft — not sent

Prepared 30 September 2026. This is an unsent draft for the controller to review; no ticket, email or issue comment has been submitted.

**Subject:** Internal Realtime partition DDL triggers PostgREST schema-cache reload, followed by catalog timeout and PGRST002 on TEST

We are investigating earlier release-validation failures on our separate TEST project **hzulujxgonszuleqticb**, PostgreSQL **17.6**, **PostgREST 14.5** (identified in database logs). App source is frozen at reviewed commit **832b4261bcab9a582e39513ac242fd0b1634f175**. No production schema or app changes have been made for this hotfix.

A full TEST OWNER browser flow creates a contract and separately saves, reopens and signs a draft through real application/RPCs. Both commission popups remain open; closing them creates zero commission requests. Cleanup succeeded, with zero production violations. The strict flow failed with one HTTP 503/PGRST002 and four HTTP 500/SQLSTATE 57014 responses.

**Sanitized service/database timeline — UTC on 29 September 2026:**

| Time | Evidence |
|---|---|
| 20:19:38.631 | Realtime websocket HTTP 101. |
| 20:19:39.069 | Realtime logs: tenant initialization, reconcile migrations in 0 ms, and creation of partitions for `realtime.messages`. |
| 20:19:39.217–.245 | PostgREST: five log rows reporting receipt of schema-cache reload messages on `pgrst`. This does not prove five separate DDL transactions or identify each sender. |
| 20:19:47.568 | PostgreSQL: `PostgREST 14.5` / `authenticator`, catalog SELECT of 5257 characters, `57014` / statement timeout. |
| 20:19:47.707 | PostgREST: schema-cache load failed with that SQLSTATE, followed by `PGRST002`. |
| 20:19:51.698 / 20:19:54.338 | Subsequent schema-cache queries succeeded in 2233.3 / 2315.6 ms. |

Read-only catalog inspection shows enabled `extensions.pgrst_ddl_watch()` watches `CREATE TABLE`/`ALTER TABLE` and excludes only schema `pg_temp`. It does not exclude `realtime` or restrict events to configured API schemas, so internal partition DDL has a concrete route to `NOTIFY pgrst, 'reload schema'`. `pgrst_drop_watch()` also has no schema allowlist. The runtime service log and definitions support this mechanism; individual DDL/sender traces are still missing.

The schema-cache failure's direct underlying cause is a catalog-query timeout. Our inspected fixture call chain has no DDL/NOTIFY. A Network Center partition-maintenance function exists, but has no runtime evidence of being called in this window.

The full resource-traced flow contains these **browser-clock** failures; browser and server clocks must not be treated as one synchronized latency measure:

| Start UTC | Reader path | HTTP / code | Duration |
|---|---|---|---:|
| 20:19:56.906 | `/rest/v1/rooms` | 503 / `PGRST002` | 1931.632 ms |
| 20:20:26.693 | `/rest/v1/contracts` | 500 / `57014` | 15688.610 ms |
| 20:20:26.697 | `/rest/v1/rooms` | 500 / `57014` | 9816.623 ms |
| 20:20:26.723 | `/rest/v1/rpc/sale_bonus_status_v1` | 500 / `57014` | 15307.490 ms |
| 20:20:26.723 | `/rest/v1/rpc/list_contract_commission_followups_v2` | 500 / `57014` | 15306.595 ms |

We do **not** attribute all four later reader timeouts solely to earlier DDL/reload. An earlier v2 read and subsequent refetch returned 200. Isolated read-only plans did not reproduce the failing window. One concurrent 10-reader replay returned 200/206 in 0.70–1.67 seconds, but omitted the signing snapshot, fresh fixture writes, Realtime startup and full UI/refetch sequence; it is not a passing full-flow test.

A passive monitor retained 33 scrape attempts over 20:18:58.024–20:24:59.032; one HTTP 500 scrape is missing data. Total RAM was 426,258,432 bytes (426.3 decimal MB). Available memory fell from 158.6 to 76.2 MB and swap used rose from 636.3 to 694.0 MB. The counter update first observed at 20:20:46 included 84,529 swap-ins, 103,215 swap-outs, 105,183 major faults and increased disk I/O; iowait was 34.82% of aggregate two-core CPU delta. Counters repeat for about a minute: these are broad-window correlations, not per-query attribution, proof of OOM or CPU saturation. Page counters have not been converted to bytes.

Role `postgres` is neither superuser nor a member of `supabase_admin`. Both enabled watcher functions/events are owned by `supabase_admin`; we have not modified them. Exposed REST settings at the original readback were `db_schema=api, public,graphql_public`, `db_extra_search_path=public, extensions`, `db_pool=null`, `max_rows=1000` and acquisition timeout 10 seconds. Service logs reported a maximum pool size of 10.

The first bounded TEST pool experiment aborted before any change: preflight PATCH of original `db_pool=null` at 20:38:14.259 returned 400; 20:39:01.716 GET verified unchanged. A later numeric TEST 10 → 2 attempt on 30 September at 02:20 UTC hit a local Windows Node runner error before browser, fixture or metrics execution. Its finally block restored explicit numeric 10, verified by GET: the same effective original capacity, but not original null metadata, since the API rejected null. This is not a product E2E failure or pool-hypothesis result. After correcting the ignored runner with `fileURLToPath`, the controller ran one full OWNER strict flow on the unchanged source at 02:21:31.427–02:22:44.269 UTC on 30 September. It passed with browser exit 0, both popup checks, empty errors/network/production violations and successful cleanup. Pool 2 was retained, with GET verification at 02:22:44.712 and all other captured REST settings unchanged. The monitor child exited 0 at 02:25:31.468. This resolves the current popup validation blocker under TEST pool 2; it does not prove the broad watcher is fixed, pool sizing explains all prior timeouts, or production should change its pool. The passing run still had cold Realtime startup/partition creation at 02:21:40.654 and five reload rows at 02:21:40.760–02:21:41.200; cache queries succeeded in 2867.3/1015.0 ms, loading 282 relations/810 functions, with no collected cache failure. All 22 monitor samples returned 200 and the maximum browser request duration was 1963.333 ms. The Realtime replication-slot version marker changed from 2.138.1 in the failed run to 2.139.0 in the passing run: an additional service confound, so we cannot attribute the pass only to pool size. Timeouts, compute, managed watchers and app assertions have not changed.

Could you please:

1. Confirm whether internal Realtime partition CREATE/ALTER should trigger this managed watcher, and provide a supported fix/update that avoids unnecessary internal-schema reloads while preserving API DDL/dependency invalidation.
2. Investigate the `authenticator` catalog timeout at 20:19:47.568, repeated reload rows and any managed-service restart, concurrent catalog work or resource limits in that window.
3. Help distinguish the four later reader timeouts from the cache failure/resource correlation, and advise what bounded evidence is needed.
4. Explain supported handling of `db_pool=null` and the PATCH rejection if pool configuration is relevant.

[Supabase issue #50043](https://github.com/supabase/supabase/issues/50043) describes a similar symptom; closure for inactivity does not establish a shipped fix or resolution here.

We can provide sanitized log excerpts, watcher definitions, path/status/timing records and resource counters. This draft contains no credentials, tokens, JWTs, request bodies, customer rows or fixture identifiers. The [verification audit](verification.md) records the validation and remaining limits; the current popup gate has passed under the recorded TEST condition, while PR, production migration/gates/CI, promotion and smoke remain pending. This unsent provider inquiry does not itself block those remaining steps.
