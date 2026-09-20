#!/usr/bin/env node
/**
 * Opt-in live verification for the accounting E2E fixture access lifecycle.
 *
 * Usage (Node 24.18.0):
 *   npx --yes --package=node@24.18.0 node scripts/verify-accounting-fixture-access.mjs
 *
 * Requires SUPABASE_PAT and SUPABASE_PROJECT_REF loaded into the process from
 * the main checkout's vault. It writes only temporary,
 * marker-owned KNOWER bindings in org DEMO and restores the binding snapshot.
 * The script exits 3 before any write when the actor already has a real,
 * active cashbook grant; it never removes that grant to manufacture a
 * "missing grant" case.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  cleanupAccountingFixtureAccess,
  getAccountingPreflight,
  prepareAccountingFixtureAccess,
} from '../.e2e-fleet/specs/accounting-admin.ts';
import { DEMO_ORG_ID, runQuery, sqlLiteral, uuidLiteral } from './lib/v5-collection-harness.mjs';

const REQUIRED_NODE_MAJOR = 24;

class PreflightBlockedError extends Error {
  exitCode = 3;
}

function requireNode24() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== REQUIRED_NODE_MAJOR) {
    throw new PreflightBlockedError(
      `Cần Node ${REQUIRED_NODE_MAJOR}.x; đang chạy Node ${process.versions.node}. `
      + 'Dùng lệnh trong phần Usage của script.',
    );
  }
}

let config;
const query = (sql) => runQuery(sql, config);

function assertFixturePreflight(preflight) {
  assert(preflight.ready, `Preflight accounting chưa sẵn sàng: ${preflight.reason}`);
  assert(preflight.actorId, 'Preflight không trả actor DEMO.');
  assert(preflight.fixture, 'Preflight không trả fixture DEMO.');
}

function scopeFrom(preflight, marker) {
  return {
    actorId: preflight.actorId,
    buildingId: preflight.fixture.buildingId,
    receivingAccountId: preflight.fixture.receivingAccountId,
    marker,
  };
}

/** Snapshot is deliberately limited to this DEMO org, cashbook, and actor membership. */
async function snapshotBindings(scope) {
  return query(`
SELECT binding.id, binding.reason, binding.possession_kind, binding.valid_from, binding.valid_to
FROM public.cashbook_possession_bindings binding
JOIN public.organization_memberships membership ON membership.id = binding.membership_id
WHERE binding.organization_id = ${uuidLiteral(DEMO_ORG_ID)}
  AND binding.cashbook_id = ${uuidLiteral(scope.receivingAccountId)}
  AND membership.organization_id = ${uuidLiteral(DEMO_ORG_ID)}
  AND membership.user_id = ${uuidLiteral(scope.actorId)}
ORDER BY binding.id;
`);
}

/** A real grant is non-fixture and currently effective; never delete it to run this probe. */
async function activeRealGrants(scope) {
  return query(`
SELECT binding.id, binding.reason, binding.possession_kind, binding.valid_from, binding.valid_to
FROM public.cashbook_possession_bindings binding
JOIN public.organization_memberships membership ON membership.id = binding.membership_id
WHERE binding.organization_id = ${uuidLiteral(DEMO_ORG_ID)}
  AND binding.cashbook_id = ${uuidLiteral(scope.receivingAccountId)}
  AND membership.organization_id = ${uuidLiteral(DEMO_ORG_ID)}
  AND membership.user_id = ${uuidLiteral(scope.actorId)}
  AND binding.possession_kind IN ('CUSTODIAN', 'KNOWER')
  AND binding.valid_from <= now()
  AND (binding.valid_to IS NULL OR binding.valid_to > now())
  AND COALESCE(binding.reason, '') NOT LIKE '[E2E-ACCOUNTING:%'
ORDER BY binding.id;
`);
}

async function expectDemoOnlyRejection(scope) {
  // Read an actual foreign pair; fabricated UUIDs only prove "missing row".
  const [foreign] = await query(`SELECT building.id AS "buildingId",
    account.id AS "receivingAccountId"
    FROM public.buildings building
    JOIN public.accounts account ON account.id = building.default_account_id_tt
      AND account.organization_id = building.organization_id
    WHERE building.organization_id <> ${uuidLiteral(DEMO_ORG_ID)}
      AND building.deleted_at IS NULL AND account.deleted_at IS NULL
      AND building.is_virtual = false AND account.is_virtual = false
    ORDER BY building.id LIMIT 1;`);
  if (!foreign) throw new PreflightBlockedError('Không có cặp toà/sổ ngoài DEMO để kiểm từ chối cross-tenant.');
  await assert.rejects(
    prepareAccountingFixtureAccess({
      ...scope,
      ...foreign,
      marker: `[E2E-ACCOUNTING:outside-demo-${randomUUID()}]`,
    }),
    /expected DEMO fixture/,
  );
  console.log('PASS cặp toà/sổ có thật ngoài DEMO bị từ chối trước khi ghi.');
}

async function removeSimulatedExisting(scope, bindingId, reason) {
  await query(`
DELETE FROM public.cashbook_possession_bindings binding
USING public.organization_memberships membership
WHERE binding.id = ${uuidLiteral(bindingId)}
  AND binding.organization_id = ${uuidLiteral(DEMO_ORG_ID)}
  AND binding.cashbook_id = ${uuidLiteral(scope.receivingAccountId)}
  AND binding.membership_id = membership.id
  AND membership.organization_id = ${uuidLiteral(DEMO_ORG_ID)}
  AND membership.user_id = ${uuidLiteral(scope.actorId)}
  AND binding.reason = ${sqlLiteral(reason)};
`);
}

async function main() {
  requireNode24();
  const pat = process.env.SUPABASE_PAT?.trim();
  const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
  if (!pat || !projectRef || !/^[a-z0-9]+$/i.test(projectRef)) {
    throw new PreflightBlockedError('Nạp SUPABASE_PAT và SUPABASE_PROJECT_REF vào process trước khi chạy.');
  }
  config = { pat, projectRef };
  const preflight = await getAccountingPreflight(113_000, 47_000);
  assertFixturePreflight(preflight);
  assert.equal(preflight.managementProjectRef, config.projectRef, 'Mọi query phải trỏ cùng project.');

  const firstScope = scopeFrom(preflight, `[E2E-ACCOUNTING:lifecycle-${randomUUID()}]`);
  const secondScope = scopeFrom(preflight, `[E2E-ACCOUNTING:lifecycle-${randomUUID()}]`);
  const before = await snapshotBindings(firstScope);
  const realGrants = await activeRealGrants(firstScope);
  if (realGrants.length > 0) {
    throw new PreflightBlockedError(
      `DỪNG preflight: actor DEMO đã có ${realGrants.length} grant thật còn hiệu lực `
      + `trên sổ ${firstScope.receivingAccountId}. Không xóa quyền thật để ép ca missing.`,
    );
  }

  let simulatedExistingId;
  let simulatedExistingReason;
  let primaryError;
  try {
    await expectDemoOnlyRejection(firstScope);

    const first = await prepareAccountingFixtureAccess(firstScope);
    assert.equal(first.length, 1, 'Ca missing grant phải tạo đúng một grant fixture.');
    assert.deepEqual(
      await prepareAccountingFixtureAccess(firstScope),
      first,
      'Setup lặp lại phải giữ nguyên định danh grant do run này sở hữu.',
    );
    console.log('PASS missing grant + repeated setup giữ một grant sở hữu.');

    const second = await prepareAccountingFixtureAccess(secondScope);
    assert.equal(second.length, 1, 'Run chồng lấn phải có grant riêng.');
    assert.notEqual(first[0], second[0], 'Hai run chồng lấn không được dùng chung grant.');
    await cleanupAccountingFixtureAccess(firstScope);
    assert((await snapshotBindings(firstScope)).some((row) => row.id === second[0]));
    await cleanupAccountingFixtureAccess(secondScope);
    assert.deepEqual(await snapshotBindings(firstScope), before);
    console.log('PASS overlap: cleanup một run giữ nguyên grant run còn lại.');

    const expired = await prepareAccountingFixtureAccess(firstScope);
    await query(`
UPDATE public.cashbook_possession_bindings
SET valid_from = now() - interval '2 minutes', valid_to = now() - interval '1 minute'
WHERE id = ${uuidLiteral(expired[0])}
  AND organization_id = ${uuidLiteral(DEMO_ORG_ID)}
  AND reason = ${sqlLiteral(firstScope.marker)};
`);
    const replacement = await prepareAccountingFixtureAccess(firstScope);
    assert.equal(replacement.length, 2, 'Grant hết hạn phải được thay bằng grant fixture mới.');
    await cleanupAccountingFixtureAccess(firstScope);
    assert.deepEqual(await snapshotBindings(firstScope), before);
    console.log('PASS expired grant được thay và mọi grant sở hữu được dọn.');

    [simulatedExistingId] = await prepareAccountingFixtureAccess(firstScope);
    simulatedExistingReason = `[E2E-EXISTING:${randomUUID()}]`;
    await query(`
UPDATE public.cashbook_possession_bindings
SET reason = ${sqlLiteral(simulatedExistingReason)}
WHERE id = ${uuidLiteral(simulatedExistingId)}
  AND organization_id = ${uuidLiteral(DEMO_ORG_ID)}
  AND reason = ${sqlLiteral(firstScope.marker)};
`);
    assert.equal((await activeRealGrants(firstScope)).length, 1);
    const existing = await snapshotBindings(firstScope);
    assert.deepEqual(
      await prepareAccountingFixtureAccess(firstScope),
      [],
      'Grant thật giả lập còn hiệu lực phải được tái sử dụng, không bị sở hữu bởi run.',
    );
    await cleanupAccountingFixtureAccess(firstScope);
    assert.deepEqual(await snapshotBindings(firstScope), existing);
    console.log('PASS existing grant được giữ nguyên, không bị cleanup của fixture xóa.');
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    try {
      try {
        await cleanupAccountingFixtureAccess(firstScope);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await cleanupAccountingFixtureAccess(secondScope);
      } catch (error) {
        cleanupErrors.push(error);
      }
    } finally {
      // This must run even if either fixture cleanup above fails: it is a
      // separately-owned simulated pre-existing grant, not a fixture grant.
      if (simulatedExistingId && simulatedExistingReason) {
        await removeSimulatedExisting(firstScope, simulatedExistingId, simulatedExistingReason);
      }
    }
    assert.deepEqual(await snapshotBindings(firstScope), before);
    console.log('PASS snapshot org+sổ+membership actor đã được khôi phục.');

    if (primaryError) throw primaryError;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Có lỗi khi cleanup grant fixture.');
    }
  }
}

main().catch((error) => {
  const exitCode = error instanceof PreflightBlockedError ? error.exitCode : 1;
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = exitCode;
});
