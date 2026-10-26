import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const METER_TEST_REF = 'hzulujxgonszuleqticb';
export const METER_TEST_URL = `https://${METER_TEST_REF}.supabase.co`;
const uuid = z.string().uuid();
const value = z.string().regex(/^\d{1,7}\.\d{2}$/);
const manifestSchema = z.object({
  version: z.literal(1), projectRef: z.literal(METER_TEST_REF), environment: z.literal('TEST'), disposable: z.literal(true),
  fixtureId: uuid, organizationId: uuid, actorId: uuid, actorEmail:z.string().email(), buildingId: uuid, roomId: uuid, meterId: uuid, contractId: uuid, serviceId: uuid, customerId: uuid,
  marker: z.string().regex(/^E2E-METER-[A-Za-z0-9-]+$/),
  internalAccountId: uuid, operatingAccountId: uuid,
  meterCode: z.string().regex(/^E2E-METER-[A-Za-z0-9-]+$/), serial: z.string().regex(/^E2E-METER-[A-Za-z0-9-]+$/),
  qrText: z.string().regex(/^ihome-meter:[0-9a-f-]{36}$/), registerCode: z.literal('1.8.0'),
  previousValue: value, currentValue: value, readingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bulkRoom: z.object({roomId:uuid,meterId:uuid,contractId:uuid,customerId:uuid,marker:z.string().regex(/^E2E-METER-[a-f0-9-]+-B$/),
    meterCode:z.string(),serial:z.string(),previousValue:z.literal('100.00'),currentValue:z.literal('140.50'),qrText:z.string().regex(/^ihome-meter:[0-9a-f-]{36}$/)}),
  expectedBuildSha: z.string().regex(/^[a-f0-9]{40}$/),
  lifecycle: z.object({ modulePath: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), retainImmutableAudit: z.literal(true) }),
});
export type MeterLiveFixture = z.infer<typeof manifestSchema>;

export interface MeterFixtureLifecycle {
  /** Parent runs only this fixture's queued capture through the real TEST worker. */
  processCapture(input: MeterLiveFixture, captureId: string): Promise<{ captureId: string; completed: true }>;
  /** Must inspect the disposable TEST fixture, including IDs, ownership marker,
   * active contract, exact baseline and absence of earlier captures. No seed/RPC
   * result may be fabricated to make this smoke pass. */
  verifyFixture(input: MeterLiveFixture): Promise<{
    projectRef: string; projectName: string; fixtureId: string; exclusive: boolean; noPriorCaptures: boolean;
  }>;
  /** Provisioner retires this dedicated fixture after success OR failure and
   * preserves immutable capture/reading audit in TEST. Never disable triggers,
   * delete shared data or reset a shared project to clean a single smoke test. */
  retireFixture(input: MeterLiveFixture, created: { clientIds: string[]; captureIds: string[] }): Promise<{
    fixtureId: string; state: 'RETIRED'; retainedImmutableAudit: true;
  }>;
}

/** Explicit opt-in spec still fails (not skips) when its real lifecycle is absent. */
export async function loadMeterLiveFixture(): Promise<{ fixture: MeterLiveFixture; lifecycle: MeterFixtureLifecycle }> {
  const location = process.env.FLEET_METER_FIXTURE_MANIFEST;
  if (!location || !isAbsolute(location)) throw new Error('FLEET_METER_FIXTURE_MANIFEST must be an absolute path to a disposable TEST fixture manifest.');
  const fixture = manifestSchema.parse(JSON.parse(await readFile(location, 'utf8')));
  if (fixture.readingDate.slice(8) === '01' || Number(fixture.currentValue) <= Number(fixture.previousValue)) {
    throw new Error('Fixture needs an in-month reading date after day 1 and a strictly increasing monthly value.');
  }
  if (!isAbsolute(fixture.lifecycle.modulePath)) throw new Error('Missing absolute TEST fixture lifecycle module path.');
  const modulePath = await realpath(fixture.lifecycle.modulePath);
  const digest = createHash('sha256').update(await readFile(modulePath)).digest('hex');
  if (digest !== fixture.lifecycle.sha256) throw new Error('TEST fixture lifecycle module digest mismatch.');
  const imported: unknown = await import(pathToFileURL(modulePath).href);
  if (!imported || typeof imported !== 'object' || !('verifyFixture' in imported) || typeof imported.verifyFixture !== 'function'
    || !('retireFixture' in imported) || typeof imported.retireFixture !== 'function'
    || !('processCapture' in imported) || typeof imported.processCapture !== 'function') throw new Error('TEST fixture lifecycle must implement verifyFixture, processCapture and retireFixture.');
  const lifecycle = imported as MeterFixtureLifecycle;
  const verified = await lifecycle.verifyFixture(fixture);
  if (verified.projectRef !== METER_TEST_REF || verified.projectName !== 'ihomecrm-test'
    || verified.fixtureId !== fixture.fixtureId || !verified.exclusive || !verified.noPriorCaptures) {
    throw new Error('Refusing to write: disposable TEST fixture ownership/project verification failed.');
  }
  return { fixture, lifecycle };
}
