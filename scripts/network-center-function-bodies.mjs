// Function-body evidence for the Network Center rollout.
//
// The rollout contract used to be proved entirely with catalog descriptors:
// "does to_regprocedure('public.f(uuid)') resolve?". That question has a blind
// spot wide enough to lose a whole migration in. On 2026-08-02 the fifteenth
// migration of the reviewed release --
// 20260729140000_network_center_admin_status_forward_fix.sql -- redefined one
// function with CREATE OR REPLACE and created no new catalog object. Every
// descriptor was already present, so the audit classified the rollout
// `complete`, the apply tool started past the last stage, executed nothing, and
// reported success. The function stayed broken in production and the post-apply
// audit stayed green, because "the function exists" was true the whole time and
// "the function is the one we reviewed" was never asked.
//
// A function body is the one part of a migration that is content-addressable
// from BOTH sides: the repository holds the exact dollar-quoted text, and
// PostgreSQL stores that same text verbatim in pg_proc.prosrc. So the digest of
// the body in the reviewed migration can be compared, byte for byte, with the
// digest of the body that is live. That comparison is the evidence this module
// produces.
//
// Deliberate limits, stated so nobody mistakes this for total coverage:
//   - Policy predicates, grants and constraint expressions are NOT covered. A
//     policy USING clause comes back from pg_get_expr deparsed and normalized,
//     so it cannot be compared with repository text; it would have to be
//     re-derived, and a re-derivation that is wrong is worse than none.
//     assertStagesObservable is what closes that hole: a stage whose only effect
//     is invisible to both catalog descriptors and body digests is rejected from
//     the manifest instead of being silently skipped forever.
//   - Extraction fails loudly. A CREATE FUNCTION statement whose body this
//     module cannot read throws, because the alternative -- reporting that the
//     migration defines no functions -- is exactly the silence that caused the
//     incident.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { REPO_ROOT, sha256 } from "./network-center-rollout-common.mjs";

// Deliberately ASCII. PostgreSQL allows wider dollar-quote tags, but every one
// in this release is ASCII and an unrecognised tag degrades safely: the scanner
// does not treat it as a quote, the body count check then fails, and extraction
// throws instead of silently mis-reading a body.
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
const FUNCTION_HEAD =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:("?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\.\s*)?("?)([A-Za-z_][A-Za-z0-9_]*)\3\s*\(/i;

function matchDollarTag(text, index) {
  return text.slice(index, index + 256).match(DOLLAR_TAG)?.[0];
}

function skipDollarQuoted(text, index, tag) {
  const end = text.indexOf(tag, index + tag.length);
  if (end < 0) return text.length;
  return end + tag.length;
}

function isEscapeStringStart(text, index) {
  const previous = text[index - 1];
  if (previous !== "E" && previous !== "e") return false;
  const beforePrevious = text[index - 2];
  return beforePrevious === undefined || !/[A-Za-z0-9_$]/.test(beforePrevious);
}

function skipSingleQuoted(text, index) {
  const escapes = isEscapeStringStart(text, index);
  let cursor = index + 1;
  while (cursor < text.length) {
    const char = text[cursor];
    if (escapes && char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "'") {
      if (text[cursor + 1] === "'") {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return text.length;
}

function skipDoubleQuoted(text, index) {
  let cursor = index + 1;
  while (cursor < text.length) {
    if (text[cursor] === '"') {
      if (text[cursor + 1] === '"') {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return text.length;
}

function skipLineComment(text, index) {
  const end = text.indexOf("\n", index);
  return end < 0 ? text.length : end + 1;
}

function skipBlockComment(text, index) {
  let depth = 1;
  let cursor = index + 2;
  while (cursor < text.length && depth > 0) {
    if (text[cursor] === "/" && text[cursor + 1] === "*") {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (text[cursor] === "*" && text[cursor + 1] === "/") {
      depth -= 1;
      cursor += 2;
      continue;
    }
    cursor += 1;
  }
  return cursor;
}

export function normalizeSqlSource(sql) {
  return String(sql).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

function scanTopLevel(text, onSemicolon, onDollarLiteral) {
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "-" && text[index + 1] === "-") {
      index = skipLineComment(text, index);
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index = skipBlockComment(text, index);
      continue;
    }
    if (char === "'") {
      index = skipSingleQuoted(text, index);
      continue;
    }
    if (char === '"') {
      index = skipDoubleQuoted(text, index);
      continue;
    }
    if (char === "$") {
      const tag = matchDollarTag(text, index);
      if (tag) {
        const end = skipDollarQuoted(text, index, tag);
        const bodyStart = index + tag.length;
        onDollarLiteral?.(text.slice(bodyStart, Math.max(bodyStart, end - tag.length)));
        index = end;
        continue;
      }
    }
    if (char === ";") {
      onSemicolon?.(index);
      index += 1;
      continue;
    }
    index += 1;
  }
}

/**
 * Split SQL into top-level statements, honouring the lexical rules that make a
 * naive split(";") dangerous here: dollar-quoted function bodies contain
 * semicolons, and comments and string literals contain everything.
 */
export function splitSqlStatements(sql) {
  const text = normalizeSqlSource(sql);
  const statements = [];
  let start = 0;
  scanTopLevel(text, (index) => {
    const statement = text.slice(start, index).trim();
    if (statement) statements.push(statement);
    start = index + 1;
  });
  const tail = text.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function dollarQuotedLiterals(statement) {
  const literals = [];
  scanTopLevel(statement, undefined, (value) => literals.push(value));
  return literals;
}

function stripLeadingNoise(statement) {
  let index = 0;
  while (index < statement.length) {
    if (/\s/.test(statement[index])) {
      index += 1;
      continue;
    }
    if (statement[index] === "-" && statement[index + 1] === "-") {
      index = skipLineComment(statement, index);
      continue;
    }
    if (statement[index] === "/" && statement[index + 1] === "*") {
      index = skipBlockComment(statement, index);
      continue;
    }
    break;
  }
  return statement.slice(index);
}

/**
 * Every CREATE [OR REPLACE] FUNCTION in `sql`, with the sha256 of the exact body
 * text PostgreSQL will store in pg_proc.prosrc.
 */
export function extractFunctionDefinitions(sql, path = "migration.sql") {
  const definitions = [];
  for (const rawStatement of splitSqlStatements(sql)) {
    const statement = stripLeadingNoise(rawStatement);
    const head = statement.match(FUNCTION_HEAD);
    if (!head) continue;
    const schema = head[2] ?? "public";
    const name = head[4];
    const qualifiedName = `${schema}.${name}`;
    const bodies = dollarQuotedLiterals(statement);
    if (bodies.length !== 1) {
      throw new Error(
        `Unreadable function body in ${path} for ${qualifiedName}: expected exactly one dollar-quoted ` +
          `body, found ${bodies.length}. The rollout proves this stage ran by digesting pg_proc.prosrc, ` +
          "so an unreadable body must fail the release rather than disappear from the evidence.",
      );
    }
    definitions.push({
      schema,
      name,
      qualifiedName,
      bodyDigest: sha256(bodies[0]),
      bodySize: bodies[0].length,
    });
  }
  return definitions;
}

export async function loadMigrationSources(manifest, repoRoot = REPO_ROOT) {
  const entries = await Promise.all(
    (manifest.migrations ?? []).map(async (migration) => [
      migration.path,
      normalizeSqlSource(await readFile(join(repoRoot, migration.path), "utf8")),
    ]),
  );
  return new Map(entries);
}

/**
 * Which stage owns which function body at the end of the release.
 *
 * Last writer wins: if stage 9 creates a function and stage 15 replaces it, only
 * stage 15 is expected to match the live body. Checking stage 9 against its own
 * text would demand a body the release deliberately superseded.
 */
export function resolveStageFunctionExpectations(manifest, sources) {
  const lastWriter = new Map();
  for (const migration of manifest.migrations ?? []) {
    const source = sources.get(migration.path);
    if (source === undefined) throw new Error(`Migration source missing: ${migration.path}`);
    const perName = new Map();
    for (const definition of extractFunctionDefinitions(source, migration.path)) {
      if (!perName.has(definition.qualifiedName)) perName.set(definition.qualifiedName, new Set());
      perName.get(definition.qualifiedName).add(definition.bodyDigest);
    }
    for (const [qualifiedName, digests] of perName) {
      lastWriter.set(qualifiedName, { path: migration.path, digests: [...digests] });
    }
  }
  const expectations = new Map((manifest.migrations ?? []).map((migration) => [migration.path, []]));
  for (const [qualifiedName, { path, digests }] of lastWriter) {
    for (const bodyDigest of digests) expectations.get(path).push({ qualifiedName, bodyDigest });
  }
  for (const list of expectations.values()) {
    list.sort(
      (left, right) =>
        left.qualifiedName.localeCompare(right.qualifiedName) ||
        left.bodyDigest.localeCompare(right.bodyDigest),
    );
  }
  return expectations;
}

export function expectedFunctionNames(expectations) {
  return [...new Set([...expectations.values()].flat().map((item) => item.qualifiedName))].sort();
}

// Statement shapes a SUBSUMED stage is allowed to contain - see
// assertStagesObservable. The list is deliberately tiny: it covers a stage whose
// only durable effect is the function bodies it declares, plus the ACL and
// comment that belong to those same functions. Anything outside it (DO blocks,
// ALTER, INSERT/UPDATE/DELETE, CREATE TABLE/INDEX/POLICY, DROP, ...) can leave a
// durable effect that a later CREATE OR REPLACE FUNCTION does NOT reproduce, so
// a stage carrying one is never eligible and the rollout keeps refusing it.
const SUBSUMABLE_STATEMENT = [
  /^BEGIN\b/i,
  /^COMMIT\b/i,
  /^SELECT\s+pg_advisory_xact_lock\s*\(/i,
  /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i,
  /^NOTIFY\s+pgrst\b/i,
];
// These three carry an effect that is only reproduced if it targets a function
// this stage itself declares, so they are checked against the declared names
// rather than merely allowed.
const FUNCTION_SCOPED_STATEMENT = [
  /^REVOKE\b/i,
  /^GRANT\b/i,
  /^COMMENT\s+ON\s+FUNCTION\b/i,
];

/**
 * A stage nothing can observe is a stage that will be skipped forever.
 *
 * The structural guarantee: a stage either adds at least one catalog descriptor
 * the previous stage did not require, or it owns at least one function body at
 * the end of the release. Either way the rollout can tell "already applied" from
 * "not applied yet", and guessing is what printed "Applied 15" after applying
 * nothing.
 *
 * THE THIRD CLASS: PROVABLY SUBSUMED, which is not the same as observable.
 *
 * A body-only forward fix owns exactly one thing - the function body it
 * declares - so a LATER forward fix to the same function takes that ownership
 * away and leaves the earlier stage owning nothing and adding nothing. That is
 * what 20260729146000 did to 20260729143000 and 20260729144000: each of those
 * stages declares exactly one function, and 146000 re-declares both.
 *
 * Such a stage genuinely cannot be observed, and the honest reason is that there
 * is nothing left to observe: applying it and skipping it reach a byte-identical
 * end state, because the later stage overwrites the body either way. Refusing it
 * would not protect anything - it would only make the release unshippable, since
 * the superseded stages are already applied in production and cannot be removed
 * from a manifest that must stay complete.
 *
 * This is NOT the "Applied 15" failure. There the tool skipped a stage whose
 * effect nothing else reproduced, so the fix was lost while success was
 * reported. Here the effect is reproduced, by construction, by a stage the
 * rollout can observe.
 *
 * The clause is kept narrow enough that it cannot be used as an escape hatch:
 *
 *   - The stage must DECLARE at least one function. A stage that declares
 *     nothing (a pure GRANT, policy or constraint stage) is still refused, which
 *     is the case that motivated the `policy:` descriptor rather than a
 *     relaxation.
 *   - Owning nothing while declaring something already means, by last-writer-
 *     wins, that EVERY function it declares is re-declared later. Partial
 *     subsumption cannot reach here: the stage would still own the remainder.
 *   - Every statement must be one this shape can reproduce. A subsumed stage
 *     that also backfills a table, alters a type or creates a policy is refused,
 *     because a later CREATE OR REPLACE FUNCTION does not reproduce that.
 *
 * Subsumed stages are RETURNED, not silently swallowed, so a caller can report
 * them and a reviewer can see that a stage in the release is now a no-op.
 */
export function assertStagesObservable(manifest, sources) {
  const expectations = resolveStageFunctionExpectations(manifest, sources);
  const migrations = manifest.migrations ?? [];
  const declaredNames = migrations.map((migration) => [
    ...new Set(
      extractFunctionDefinitions(sources.get(migration.path), migration.path).map(
        (definition) => definition.qualifiedName,
      ),
    ),
  ]);
  const seen = new Set();
  const subsumed = [];
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const required = migration.postApply?.required ?? [];
    const added = required.filter((descriptor) => !seen.has(descriptor));
    const owned = expectations.get(migration.path) ?? [];
    if (!added.length && !owned.length) {
      const declares = declaredNames[index];
      const refuse = (why) => {
        throw new Error(
          `Manifest rejected: rollout stage ${index + 1} ${migration.path} is unobservable. It adds no ` +
            "catalog descriptor beyond the previous stage and owns no function body at the end of the " +
            "release, so the rollout could never distinguish an applied stage from a skipped one and " +
            `would pass over it silently on every run. ${why} Give the stage a postApply descriptor, or ` +
            "express the change as a CREATE OR REPLACE FUNCTION whose body this release owns.",
        );
      };
      if (!declares.length) {
        refuse("It declares no function either, so nothing in this release reproduces its effect.");
      }
      for (const statement of splitSqlStatements(sources.get(migration.path))) {
        const head = stripLeadingNoise(statement);
        if (SUBSUMABLE_STATEMENT.some((pattern) => pattern.test(head))) continue;
        if (
          FUNCTION_SCOPED_STATEMENT.some((pattern) => pattern.test(head))
          && declares.some((name) => head.includes(name))
        ) {
          continue;
        }
        refuse(
          "Its function bodies are all re-declared by a later stage, but it also carries a statement "
            + `no later CREATE OR REPLACE FUNCTION reproduces: ${head.slice(0, 80).replace(/\s+/g, " ")}.`,
        );
      }
      subsumed.push({
        ordinal: index + 1,
        path: migration.path,
        supersededBy: declares.map((name) => {
          const later = migrations.findIndex(
            (_, laterIndex) => laterIndex > index && declaredNames[laterIndex].includes(name),
          );
          return { qualifiedName: name, by: migrations[later].path };
        }),
      });
    }
    for (const descriptor of required) seen.add(descriptor);
  }
  return { stages: migrations.length, subsumed };
}

/**
 * Read-only probe of the live bodies. sha256 over convert_to(prosrc,'UTF8')
 * matches Node's sha256 of the same UTF-8 text exactly, so the two sides are
 * directly comparable without normalization on either end.
 */
export function buildFunctionBodyProbeSql(qualifiedNames = []) {
  const unique = [...new Set(qualifiedNames)].sort();
  const list = unique.map((name) => `'${String(name).replaceAll("'", "''")}'`).join(", ");
  const filter = unique.length
    ? `(function_schema.nspname || '.' || function_row.proname) IN (${list})`
    : "false";
  return `BEGIN READ ONLY;
SELECT (function_schema.nspname || '.' || function_row.proname) AS qualified_name,
  pg_get_function_identity_arguments(function_row.oid) AS identity_arguments,
  encode(sha256(convert_to(function_row.prosrc, 'UTF8')), 'hex') AS body_digest
FROM pg_proc function_row
JOIN pg_namespace function_schema ON function_schema.oid = function_row.pronamespace
WHERE ${filter}
  AND function_row.prosrc IS NOT NULL
ORDER BY qualified_name, identity_arguments;
COMMIT;`;
}

export function liveFunctionBodiesFromResult(result) {
  const live = new Map();
  const visit = (value, depth = 0) => {
    if (depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.qualified_name === "string" && typeof value.body_digest === "string") {
      if (!live.has(value.qualified_name)) live.set(value.qualified_name, new Set());
      live.get(value.qualified_name).add(value.body_digest);
    }
    if (Array.isArray(value.result)) visit(value.result, depth + 1);
  };
  visit(result);
  return live;
}

/**
 * Per-stage verdict: does every function body this stage owns match what is
 * live? A stage that owns no body is vacuously satisfied - which is precisely
 * why assertStagesObservable exists.
 */
export function evaluateStageFunctionBodies(manifest, { expectations, live } = {}) {
  const satisfied = new Map();
  const mismatches = [];
  for (const migration of manifest.migrations ?? []) {
    const owned = expectations?.get(migration.path) ?? [];
    let stageOk = true;
    for (const { qualifiedName, bodyDigest } of owned) {
      const liveDigests = live?.get(qualifiedName);
      if (!liveDigests?.has(bodyDigest)) {
        stageOk = false;
        mismatches.push({
          migration: migration.path,
          qualifiedName,
          expectedBodyDigest: bodyDigest,
          liveBodyDigests: liveDigests ? [...liveDigests].sort() : [],
        });
      }
    }
    satisfied.set(migration.path, stageOk);
  }
  return { satisfied, mismatches };
}

export function functionBodyFingerprint(expectations, live) {
  const names = expectedFunctionNames(expectations);
  return sha256(JSON.stringify(names.map((name) => [name, [...(live?.get(name) ?? [])].sort()])));
}
