// Read value domains and emitted literals OUT OF THE REAL SOURCE FILES.
//
// WHY THIS FILE EXISTS. F6 shipped because three places restate the database's
// CHECK constraints in TypeScript - the worker's `domain.ts`, the worker's
// `sshConnector.ts` literals, and the Edge function's validation sets - and
// nothing ever compared any of them to the database. A test that retypes the
// allowed values by hand compares one restatement to a fourth restatement and
// passes while production is broken; that is exactly the vacuity that let
// `connectionType: "DHCP"` / `sessionType: "LEASE"` through 422 green tests.
//
// So nothing here is typed by hand. Every value is read from the file that
// actually ships, and the proof that consumes them derives the ONLY authority -
// the domains themselves - from `pg_get_constraintdef` on a real PostgreSQL 17
// cluster built from the real migrations.
//
// Every function fails closed: a declaration that cannot be found, or that is
// found but yields no strings, throws instead of returning an empty set. An
// extractor that silently returns nothing is a vacuous proof wearing a green
// tick.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Strip line and block comments, so a commented-out literal can never be
 * mistaken for a live one. String contents are preserved verbatim.
 */
export function stripComments(source) {
  let output = "";
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      output += character;
      if (character === "\\") {
        output += next ?? "";
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      output += character;
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        // Newlines are preserved so reported offsets stay meaningful.
        if (source[index] === "\n") output += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/**
 * The initializer of `... <name> = <initializer>;`, matched by brackets rather
 * than by a line-shaped regex, so reformatting the declaration cannot silently
 * stop the extraction from finding it.
 */
export function readInitializer(source, name) {
  const cleaned = stripComments(source);
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=`, "u");
  const match = declaration.exec(cleaned);
  if (!match) {
    throw new Error(`Declaration of ${name} was not found in the source`);
  }
  let index = match.index + match[0].length;
  let depth = 0;
  let quote = null;
  let start = -1;
  while (index < cleaned.length) {
    const character = cleaned[index];
    if (quote !== null) {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      if (start < 0) start = index;
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
      if (depth < 0) {
        throw new Error(`Initializer of ${name} is unbalanced`);
      }
    } else if (character === ";" && depth === 0) {
      if (start < 0) {
        throw new Error(`Initializer of ${name} contains no bracketed value`);
      }
      return cleaned.slice(start, index);
    }
    index += 1;
  }
  throw new Error(`Initializer of ${name} is unterminated`);
}

/** Every double- or single-quoted string in a fragment, in source order. */
export function stringLiteralsIn(fragment) {
  const literals = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/gu;
  let match;
  while ((match = pattern.exec(fragment)) !== null) {
    literals.push((match[1] ?? match[2] ?? "").replace(/\\(.)/gu, "$1"));
  }
  return literals;
}

/**
 * The members of a declared value domain, whether it is written as
 * `["A","B"] as const` or `new Set(["A","B"])`. Order is not significant; the
 * proof compares them as sets.
 */
export function extractDeclaredDomain(source, name) {
  const members = stringLiteralsIn(readInitializer(source, name));
  if (members.length === 0) {
    throw new Error(`Declared domain ${name} contains no members`);
  }
  const unique = [...new Set(members)];
  if (unique.length !== members.length) {
    throw new Error(`Declared domain ${name} repeats a member`);
  }
  return unique;
}

/**
 * The literal string values the worker assigns inside one object literal - here,
 * the `clients` observation built from a DHCP lease. Returns a map of property
 * name to literal, covering ONLY properties whose value is a plain string
 * literal, which is precisely the class F6 belongs to.
 */
export function extractObjectLiteralStrings(source, declarationName) {
  const initializer = readInitializer(source, declarationName);
  const entries = new Map();
  const pattern = /(?:^|[\s{,])([A-Za-z_$][\w$]*)\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?=[,}])/gu;
  let match;
  while ((match = pattern.exec(initializer)) !== null) {
    entries.set(match[1], match[2].replace(/\\(.)/gu, "$1"));
  }
  if (entries.size === 0) {
    throw new Error(`No string-literal properties found in ${declarationName}`);
  }
  return entries;
}

export const WORKER_DOMAIN_SOURCE = join(
  "infra",
  "network-center-worker",
  "src",
  "domain.ts",
);
export const WORKER_CONNECTOR_SOURCE = join(
  "infra",
  "network-center-worker",
  "src",
  "routeros",
  "sshConnector.ts",
);
export const EDGE_FUNCTION_SOURCE = join(
  "supabase",
  "functions",
  "network-center-worker",
  "index.ts",
);

/**
 * One enumerated telemetry field, and the three places that restate its domain.
 *
 * `table`/`column` are the only authority. The two symbol names are looked up in
 * the shipping source files, so renaming one without updating this list fails
 * the proof loudly rather than dropping the binding.
 */
export const TELEMETRY_DOMAIN_BINDINGS = Object.freeze([
  Object.freeze({
    field: "clients[].connectionType",
    table: "public.network_client_current",
    column: "connection_type",
    workerSymbol: "CLIENT_CONNECTION_TYPES",
    edgeSymbol: "CLIENT_CONNECTION_TYPES",
  }),
  Object.freeze({
    field: "clients[].connectionType (session history)",
    table: "public.network_client_sessions",
    column: "connection_type",
    workerSymbol: "CLIENT_CONNECTION_TYPES",
    edgeSymbol: "CLIENT_CONNECTION_TYPES",
  }),
  Object.freeze({
    field: "clients[].sessionType",
    table: "public.network_client_current",
    column: "session_type",
    workerSymbol: "CLIENT_SESSION_TYPES",
    edgeSymbol: "CLIENT_SESSION_TYPES",
  }),
  Object.freeze({
    field: "devices[].healthStatus",
    table: "public.network_device_current",
    column: "health_status",
    workerSymbol: "DEVICE_HEALTH_STATUSES",
    edgeSymbol: "DEVICE_HEALTH_STATUSES",
  }),
  Object.freeze({
    field: "devices[].pppoeState",
    table: "public.network_device_current",
    column: "pppoe_state",
    // The worker only ever sends null for this field, so it declares no union
    // for it; the Edge still has to police it because the RPC forwards whatever
    // arrives.
    workerSymbol: null,
    edgeSymbol: "DEVICE_PPPOE_STATES",
  }),
  Object.freeze({
    field: "interfaces[].linkState",
    table: "public.network_interface_current",
    column: "link_state",
    workerSymbol: "INTERFACE_LINK_STATES",
    edgeSymbol: "INTERFACE_LINK_STATES",
  }),
]);

/** The two literals F6 got wrong, read out of the connector that ships. */
export function readEmittedClientLiterals(repoRoot) {
  const source = readFileSync(join(repoRoot, WORKER_CONNECTOR_SOURCE), "utf8");
  const literals = extractObjectLiteralStrings(source, "clients");
  const connectionType = literals.get("connectionType");
  const sessionType = literals.get("sessionType");
  if (typeof connectionType !== "string" || typeof sessionType !== "string") {
    throw new Error(
      "The connector no longer assigns literal connectionType/sessionType values; "
        + "this proof can no longer see what it emits and must be updated rather than skipped",
    );
  }
  return { connectionType, sessionType };
}

/** Every declared domain the proof compares against the catalog. */
export function readDeclaredDomains(repoRoot) {
  const workerSource = readFileSync(join(repoRoot, WORKER_DOMAIN_SOURCE), "utf8");
  const edgeSource = readFileSync(join(repoRoot, EDGE_FUNCTION_SOURCE), "utf8");
  return TELEMETRY_DOMAIN_BINDINGS.map((binding) => ({
    ...binding,
    workerMembers: binding.workerSymbol === null
      ? null
      : extractDeclaredDomain(workerSource, binding.workerSymbol),
    edgeMembers: extractDeclaredDomain(edgeSource, binding.edgeSymbol),
  }));
}
