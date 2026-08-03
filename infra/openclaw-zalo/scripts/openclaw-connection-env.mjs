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
  // `new URL` accepts `host1:5432,host2:5432` as a single opaque hostname, which
  // would send the whole thing to DNS and fail late with a confusing error - or,
  // worse, resolve. libpq's multi-host form is not supported here; say so.
  const authority = uri.slice(uri.indexOf("//") + 2).split(/[/?]/u, 1)[0];
  if (authority.includes(",")) {
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
  if (parsed.hostname) variables.PGHOST = decodeURIComponent(parsed.hostname);
  if (parsed.port) variables.PGPORT = parsed.port;
  if (parsed.username) variables.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) variables.PGPASSWORD = decodeURIComponent(parsed.password);

  for (const [name, value] of parsed.searchParams) {
    const variable = PARAMETER_VARIABLES[name];
    // Refusing beats dropping: the operator wrote the parameter for a reason, and
    // an unrecognised one usually means a typo in a security-relevant setting.
    if (!variable) throw fail(`connection URI carries unsupported parameter ${name}`);
    if (variable in variables) {
      throw fail(`connection URI sets ${name} more than once`);
    }
    variables[variable] = value;
  }
  return variables;
}

/**
 * A complete child environment: the parent's, minus EVERY inherited PG* variable,
 * plus exactly what the URI specifies.
 *
 * @param {NodeJS.ProcessEnv} parent
 * @param {Record<string, string>} variables - from {@link connectionEnvironment}
 */
export function childEnvironment(parent, variables) {
  const environment = {};
  for (const [name, value] of Object.entries(parent)) {
    // PGSERVICE alone can redirect the whole connection to another host, and
    // PGHOSTADDR outranks PGHOST. Nothing inherited may reach libpq.
    if (name.startsWith("PG")) continue;
    environment[name] = value;
  }
  return { ...environment, ...variables };
}
