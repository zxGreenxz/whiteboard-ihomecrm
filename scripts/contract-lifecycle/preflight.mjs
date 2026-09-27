#!/usr/bin/env node
// Local, credential-free preflight contracts. The caller owns TEST transport and
// must use withVerifiedTestTarget before any fixture or catalog mutation.

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PROD_REF } from '../test-env/lib.mjs';

const REF = /^[a-z0-9]{20}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function validateTestTarget({ expectedRef, url } = {}) {
  if (!REF.test(expectedRef ?? '') || expectedRef === PROD_REF) {
    throw new Error('Explicit non-production TEST project ref is required.');
  }
  if (typeof url !== 'string' || url !== `https://${expectedRef}.supabase.co`) {
    throw new Error('Explicit TEST URL must match the expected project ref exactly.');
  }
  return { expectedRef, url };
}

// readMarker must read test_env.danh_dau on the same server/connection that
// mutate will use. There is deliberately no marker creation or default target.
export async function withVerifiedTestTarget(config, { readMarker, mutate } = {}) {
  const target = validateTestTarget(config);
  if (typeof readMarker !== 'function' || typeof mutate !== 'function') {
    throw new Error('TEST marker reader and mutation callback are required.');
  }
  const marker = await readMarker(target);
  if (!marker || marker.ref !== target.expectedRef) {
    throw new Error('Server-side TEST marker is missing or does not match the target.');
  }
  return mutate(target);
}

const REQUIRED_ROLES = ['manager', 'accountant', 'sale', 'crossOrg', 'revoked'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

// Presence contract only. JWT signature, tenant and revocation are exercised by
// the later live TEST harness; this function cannot turn placeholders into proof.
export function assertRequiredFixtures({ fixtureIds, jwtByRole } = {}) {
  if (!fixtureIds || typeof fixtureIds !== 'object' || Object.keys(fixtureIds).length === 0 ||
      Object.values(fixtureIds).some((id) => typeof id !== 'string' || !UUID.test(id))) {
    throw new Error('Deterministic fixture IDs are missing or invalid.');
  }
  if (!jwtByRole || REQUIRED_ROLES.some((role) => typeof jwtByRole[role] !== 'string' || !jwtByRole[role].trim())) {
    throw new Error('Required TEST role JWT is missing.');
  }
  return { fixtureIds, jwtByRole };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function catalogHash(rows) {
  if (!Array.isArray(rows)) throw new Error('Catalog rows must be an array.');
  return createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex');
}

// fetchPage(name, offset, limit) must issue a stable ORDER BY on key inside a
// repeatable snapshot and return {rows, totalCount}. Missing count is unsafe.
export async function captureNamedCatalog({ requirements, fetchPage, pageSize = 1000, maxRows = 100000 } = {}) {
  if (!Array.isArray(requirements) || requirements.length === 0 || typeof fetchPage !== 'function') {
    throw new Error('Named catalog requirements and fetchPage are required.');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      !Number.isSafeInteger(maxRows) || maxRows < pageSize) {
    throw new Error('Unsafe catalog pagination limit.');
  }
  const result = {};
  for (const requirement of requirements) {
    const { name, minRows = 1, key = 'id' } = requirement ?? {};
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(name) ||
        Object.hasOwn(result, name) || !Number.isSafeInteger(minRows) || minRows < 1 ||
        typeof key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(key)) {
      throw new Error('Invalid or duplicate named catalog requirement.');
    }
    const rows = [];
    let expectedCount;
    while (expectedCount === undefined || rows.length < expectedCount) {
      const page = await fetchPage(name, rows.length, pageSize);
      if (!page || !Array.isArray(page.rows) || !Number.isSafeInteger(page.totalCount) || page.totalCount < 0) {
        throw new Error(`Catalog ${name}: missing page or total count.`);
      }
      if (expectedCount === undefined) {
        expectedCount = page.totalCount;
        if (expectedCount > maxRows) throw new Error(`Catalog ${name}: unsafe row cap.`);
      } else if (page.totalCount !== expectedCount) {
        throw new Error(`Catalog ${name}: count changed across pages.`);
      }
      const remaining = expectedCount - rows.length;
      if (page.rows.length !== Math.min(pageSize, remaining) || page.rows.length === 0) {
        throw new Error(`Catalog ${name}: missing, short or extra page.`);
      }
      for (const row of page.rows) {
        const id = row?.[key];
        const previous = rows.at(-1)?.[key];
        if (typeof id !== 'string' || !id || (previous !== undefined && id <= previous)) {
          throw new Error(`Catalog ${name}: duplicate or unordered key.`);
        }
        rows.push(row);
      }
    }
    if (rows.length < minRows) throw new Error(`Catalog ${name}: missing required rows.`);
    result[name] = { rowCount: rows.length, sha256: catalogHash(rows), rows };
  }
  return result;
}

export function compareNamedCatalog(actual, expected) {
  const errors = [];
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length === 0) {
    return { ready: false, errors: ['Expected named catalog manifest is missing.'] };
  }
  for (const [name, requirement] of Object.entries(expected)) {
    const captured = actual?.[name];
    if (!captured) {
      errors.push(`Catalog ${name}: missing capture.`);
    } else if (!Number.isSafeInteger(requirement?.minRows) || requirement.minRows < 1 ||
               !SHA256.test(requirement?.sha256 ?? '')) {
      errors.push(`Catalog ${name}: incomplete requirement.`);
    } else if (!Array.isArray(captured.rows) || !Number.isSafeInteger(captured.rowCount) ||
               captured.rowCount !== captured.rows.length || !SHA256.test(captured.sha256 ?? '')) {
      errors.push(`Catalog ${name}: invalid capture.`);
    } else if (captured.rowCount < requirement.minRows || captured.sha256 !== requirement.sha256 ||
               catalogHash(captured.rows) !== captured.sha256) {
      errors.push(`Catalog ${name}: missing rows or hash drift.`);
    }
  }
  for (const name of Object.keys(actual ?? {})) {
    if (!Object.hasOwn(expected, name)) errors.push(`Catalog ${name}: unapproved capture.`);
  }
  return { ready: errors.length === 0, errors };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.error('NOT READY: provide an explicit TEST transport, server marker reader, fixtures and approved catalog manifest through the exported API.');
  process.exitCode = 3;
}
