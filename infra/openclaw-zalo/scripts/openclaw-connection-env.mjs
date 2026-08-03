/**
 * Turns a Postgres connection URI into the environment libpq will actually obey.
 *
 * Shared by the migration and recovery adapters because it was duplicated in both,
 * and a connection parser that drifts between two copies is a security bug waiting
 * for the one host that runs the older file.
 *
 * Three rules, all of them load-bearing:
 *
 *  1. libpq does NOT URI-expand from the environment. `PGDATABASE=postgres://…`
 *     is taken literally as a database NAME, so the URI must be split into
 *     discrete PG* variables. The password travels here rather than in argv,
 *     where /proc/<pid>/cmdline exposes it to every local user.
 *  2. Unknown query parameters FAIL rather than being dropped. An earlier version
 *     kept only `sslmode`, so a URI carrying `sslrootcert=` or
 *     `target_session_attrs=read-write` silently connected with neither - a
 *     weaker TLS posture, or a write step aimed at a read replica.
 *  3. The child gets a PG-free base environment. Inherited PGSERVICE, PGHOSTADDR
 *     or PGOPTIONS on the operator's shell outrank or subvert what we compute,
 *     and the operator would have no way to tell.
 */

/**
 * Query parameters libpq understands, mapped to the variable that carries them.
 * From the libpq "Parameter Key Words" table; anything absent here is refused.
 */
const PARAMETER_VARIABLES = Object.freeze({
  application_name: "PGAPPNAME",
  channel_binding: "PGCHANNELBINDING",
  client_encoding: "PGCLIENTENCODING",
  connect_timeout: "PGCONNECT_TIMEOUT",
  gssencmode: "PGGSSENCMODE",
  krbsrvname: "PGKRBSRVNAME",
  options: "PGOPTIONS",
  passfile: "PGPASSFILE",
  requirepeer: "PGREQUIREPEER",
  sslcert: "PGSSLCERT",
  sslcrl: "PGSSLCRL",
  sslkey: "PGSSLKEY",
  sslmode: "PGSSLMODE",
  sslrootcert: "PGSSLROOTCERT",
  sslsni: "PGSSLSNI",
  target_session_attrs: "PGTARGETSESSIONATTRS",
});

/**
 * Decorations the platform appends to its own connection strings.
 *
 * These are not libpq parameters and carry nothing this code needs - `supa` is what
 * the Supabase dashboard staples onto pooler URIs, `pgbouncer` is a driver hint. An
 * operator copying a URI from the dashboard would otherwise hit a hard refusal on a
 * string the platform itself handed them, so they are skipped by name rather than
 * lumped in with genuinely unknown parameters.
 */
const IGNORED_PARAMETERS = new Set(["supa", "pgbouncer"]);

/**
 * Splits a connection URI into PG* variables.
 *
 * @param {string} uri
 * @param {(message: string) => Error} fail - the caller's fail-closed error type,
 *   so a bad URI aborts the run the same way every other refusal here does.
 */
export function connectionEnvironment(uri, fail) {
  if (typeof uri !== "string" || uri.trim() === "") {
    throw fail("connection URI is missing");
  }
  // libpq's comma-separated multi-host form is not supported here. It has to be
  // detected BEFORE `new URL`, which rejects `a:5432,b:5432` outright as malformed -
  // a true refusal, but one that tells the operator nothing about why.
  //
  // Scanned on the host portion only, after dropping userinfo at the LAST `@`: a
  // comma is legal in userinfo, and checking the whole authority rejected any
  // rotated password containing one, sending the operator hunting for a multi-host
  // configuration that does not exist.
  const authority = uri.slice(uri.indexOf("//") + 2).split(/[/?]/u, 1)[0];
  const hostPortion = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPortion.includes(",")) {
    throw fail("multi-host connection URIs are not supported");
  }
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw fail("connection URI is malformed");
  }
  if (!/^postgres(ql)?:$/u.test(parsed.protocol)) {
    throw fail("connection URI must use the postgres scheme");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (!database) throw fail("connection URI carries no database name");

  const variables = { PGDATABASE: database };
  if (parsed.hostname) {
    // `new URL` keeps the brackets on an IPv6 literal. libpq strips them only inside
    // its own URI parser, never for PGHOST, so `[2406:da18::1]` would reach the
    // resolver verbatim and die with "could not translate host name". Supabase
    // direct endpoints are AAAA-only, so this shape is live, not hypothetical.
    variables.PGHOST = decodeURIComponent(parsed.hostname).replace(/^\[|\]$/gu, "");
  }
  if (parsed.port) variables.PGPORT = parsed.port;
  if (parsed.username) variables.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) variables.PGPASSWORD = decodeURIComponent(parsed.password);

  for (const [name, value] of parsed.searchParams) {
    if (IGNORED_PARAMETERS.has(name)) continue;
    // `Object.hasOwn`, not `in` or a truthiness check: a plain-object lookup walks
    // Object.prototype, so `?constructor=`, `?toString=` and `?__proto__=` all
    // returned something truthy and skipped this throw, putting a junk key into the
    // child environment while the fail-closed claim said otherwise.
    if (!Object.hasOwn(PARAMETER_VARIABLES, name)) {
      throw fail(`connection URI carries unsupported parameter ${name}`);
    }
    const variable = PARAMETER_VARIABLES[name];
    if (Object.hasOwn(variables, variable)) {
      throw fail(`connection URI sets ${name} more than once`);
    }
    variables[variable] = value;
  }
  return variables;
}

/**
 * Inherited variables that may NOT be overridden by the URI, but are kept.
 *
 * The rule this file enforces is "nothing inherited may change WHERE we connect or
 * WHO we connect as". PGPASSFILE changes neither: it supplies a password for the
 * host/user the URI already named. It is kept because this project's own operating
 * guidance says to inject the password through a temporary passfile rather than in
 * the URI - stripping it left the child with no password at all, and `psql` failed
 * with the opaque "canonical query failed with status 2".
 */
const KEPT_PARENT_VARIABLES = new Set(["PGPASSFILE"]);

/**
 * A complete child environment: the parent's, minus every inherited PG* variable
 * that could redirect the connection, plus exactly what the URI specifies.
 *
 * @param {NodeJS.ProcessEnv} parent
 * @param {Record<string, string>} variables - from {@link connectionEnvironment}
 */
export function childEnvironment(parent, variables) {
  const environment = {};
  for (const [name, value] of Object.entries(parent)) {
    // PGSERVICE alone can redirect the whole connection to another host, and
    // PGHOSTADDR outranks PGHOST. Case-insensitive because Windows environment
    // names are, and `Pguser` reached libpq intact.
    const isPostgresVariable = name.slice(0, 2).toUpperCase() === "PG";
    if (isPostgresVariable && !KEPT_PARENT_VARIABLES.has(name.toUpperCase())) continue;
    environment[name] = value;
  }
  // The URI still wins: a passfile inherited from the shell must not override a
  // password the operator put in the URI for this specific run.
  if (variables.PGPASSWORD !== undefined || variables.PGPASSFILE !== undefined) {
    delete environment.PGPASSFILE;
  }
  return { ...environment, ...variables };
}
