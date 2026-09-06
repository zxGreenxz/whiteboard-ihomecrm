import { expect, test, type Request, type Response } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { login, trackConsoleErrors } from './auth';
import { chanChayTrenProduction, xacMinhBanBuild } from './buildAttestation';
import { COPILOT_TEST_MODEL, pinCopilotTestModel } from './copilotTestModel';
import { guiVaChoModel } from './copilotModelCycle';
import { assertReadonlyResult, unexpectedReadonlyMutation } from './copilotSmokeOracle';
import { bindRoomScenario, createRun, DEMO_ORG, digest, IMPLEMENTED_ORACLES, summarizeRun, transitionCase, writeCheckpoint } from '../../scripts/copilot-golden-browser-evidence.mjs';

const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const golden = load(fileURLToPath(new URL('../../tooling/copilot-golden-eval.json', import.meta.url)));
const manifest = load(fileURLToPath(new URL('../../tooling/copilot-golden-scenarios.json', import.meta.url)));

// Full inventory stays visible. An unimplemented executor/oracle is incomplete
// engineering work, never an environmental skip and never a passing case.
test('full golden corpus executes attested ChatPanel observations', async ({ page }) => {
  const output = process.env.COPILOT_GOLDEN_RESULTS;
  const attestationPath = process.env.COPILOT_GOLDEN_ATTESTATION;
  if (!output || !attestationPath) throw new Error('Missing golden results/attestation paths');
  const attestation = load(attestationPath);
  const run = createRun(golden, manifest, attestation);
  const save = () => writeCheckpoint(output, run, golden, manifest);
  for (const c of run.cases) if (!IMPLEMENTED_ORACLES.has(c.oracle)) transitionCase(run, c.id, { status: 'blocked', reason: 'oracle_not_implemented' });
  save();
  let reason = 'preflight_missing';
  let fatalProvider = false;
  const pending = () => run.cases.filter(c => c.status === 'pending' || c.status === 'running');
  try {
    chanChayTrenProduction();
    expect(COPILOT_TEST_MODEL).toBe(attestation.providerModel);
    expect(process.env.EXPECTED_SOURCE_SHA).toBe(attestation.buildSha);
    // The launcher wrapper needs independent reviewed/deployed edge attestation.
    expect(process.env.COPILOT_DEPLOYED_EDGE_DIGEST).toBe(attestation.deployedEdgeSourceDigest);
    expect(process.env.COPILOT_REVIEWED_EDGE_DIGEST).toBe(attestation.edgeSourceDigest);
    await pinCopilotTestModel(page);
    reason = 'browser_failed';
    const consoleErrors = trackConsoleErrors(page);
    const availability: Response[] = [];
    const onAvailability = (r: Response) => { if (r.url().split('?')[0].endsWith('/rpc/get_my_copilot_availability_v1')) availability.push(r); };
    page.on('response', onAvailability);
    await login(page, 'chunha');
    reason = 'attestation_failed';
    await xacMinhBanBuild(page);
    await page.goto('/apartments');
    await page.getByTestId('copilot-launcher').click();
    await expect(page.getByTestId('copilot-model-select')).toHaveValue(COPILOT_TEST_MODEL);
    await expect(page.getByTestId('copilot-dang-tai-lich-su')).toHaveCount(0);
    page.off('response', onAvailability);
    expect(availability.length).toBeGreaterThan(0);
    const latest = availability.at(-1)!;
    expect(latest.ok()).toBe(true);
    expect(latest.request().postDataJSON().p_organization_id).toBe(DEMO_ORG);
    const headers = await latest.request().allHeaders();
    const auth = { Authorization: headers.authorization, apikey: headers.apikey, 'Accept-Profile': 'public', 'Content-Profile': 'public' };
    const api = latest.url().split('/rest/v1/')[0];
    const policy = await latest.json();
    delete policy.fetched_at; delete policy.fetchedAt;
    const perms = await page.request.post(`${api}/rest/v1/rpc/get_my_permissions`, { headers: auth, data: {} });
    expect(perms.ok()).toBe(true);
    expect(digest({ permissions: await perms.json(), availability: policy })).toBe(attestation.policyDigest);
    const token = headers.authorization.replace(/^Bearer /i, '');
    const subject = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
    expect(digest(subject)).toBe(attestation.actorDigest);
    const before = await page.request.post(`${api}/rest/v1/rpc/copilot_available_rooms_v1`, { headers: auth, data: { p_organization_id: DEMO_ORG } });
    expect(before.ok()).toBe(true);
    const fixture = await before.json();
    expect(digest(fixture)).toBe(attestation.fixtureDigest);

    for (const c of pending()) {
      if (fatalProvider) { transitionCase(run, c.id, { status: 'blocked', reason }); save(); continue; }
      const scenario = manifest.cases.find(s => s.id === c.id);
      let bound;
      try { bound = bindRoomScenario(scenario, fixture); }
      catch { transitionCase(run, c.id, { status: 'blocked', reason: 'fixture_unbound' }); save(); continue; }
      await page.getByTitle('Cuộc trò chuyện mới', { exact: true }).click();
      const assistant = page.getByTestId('copilot-panel').locator('.flex.justify-start.gap-2 > .bg-muted');
      await expect(assistant).toHaveCount(0);
      const reads: Response[] = [], modelRequests: Request[] = [];
      let writes = 0, networkErrors = 0;
      const onRequest = (r: Request) => {
        if (unexpectedReadonlyMutation(r.method(), r.url())) writes += 1;
        if (/\/functions\/v1\/llm-proxy(?:\/|$)/.test(new URL(r.url()).pathname)) modelRequests.push(r);
      };
      const onResponse = (r: Response) => {
        if (/\/(rest|functions)\/v1\//.test(r.url()) && !r.ok()) networkErrors += 1;
        if (r.url().split('?')[0].endsWith('/rpc/copilot_available_rooms_v1')) reads.push(r);
        if (/\/functions\/v1\/llm-proxy(?:\/|$)/.test(new URL(r.url()).pathname) && !r.ok()) {
          fatalProvider = true;
          reason = r.status() === 429 ? 'rate_exhausted' : r.status() === 403 ? 'quota_exhausted' : 'provider_failed';
        }
      };
      const onFailed = () => { networkErrors += 1; };
      page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onFailed);
      transitionCase(run, c.id, { status: 'running' }); save();
      const started = Date.now();
      let completed = started;
      reason = 'browser_failed';
      try {
        // C01's intent is immediate availability. This explicit clarification is
        // declared in the scenario manifest, never derived from expected fields.
        const prompt = bound.prompt;
        const rounds = await guiVaChoModel(page, prompt);
        completed = Date.now();
        await page.waitForLoadState('networkidle');
        await expect(assistant.last()).toBeVisible();
        const answer = await assistant.last().innerText();
        reason = 'oracle_failed';
        expect(reads).toHaveLength(1);
        expect(reads[0].ok()).toBe(true);
        expect(reads[0].request().postDataJSON().p_organization_id).toBe(DEMO_ORG);
        const payload = await reads[0].json();
        expect(digest(payload)).toBe(digest(fixture));
        for (const r of modelRequests) {
          expect((await r.allHeaders())['x-organization-id']).toBe(DEMO_ORG);
          expect(r.postDataJSON().model).toBe(COPILOT_TEST_MODEL);
        }
        assertReadonlyResult({ prompt, answer, rounds, payload: bindRoomScenario(scenario, payload).payload });
        expect(writes).toBe(0); expect(networkErrors).toBe(0); expect(consoleErrors.length).toBe(0);
        transitionCase(run, c.id, { status: 'pass', timing: {
          startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(), totalMs: completed-started, humanWaitMs: 0, processingMs: completed-started,
        }, observed: { answerDigest: digest(answer), promptDigest: digest(prompt), promptTemplateDigest: digest(scenario.prompt), bindingDigest: bound.bindingDigest, rpcDigest: digest(payload), modelRounds: rounds.length,
          toolResultLinked: true, finalAnswerMounted: true, readRpc: 'copilot_available_rooms_v1', businessWrites: writes, networkErrors, oracleVersion: c.oracle } });
      } catch {
        completed = Date.now();
        transitionCase(run, c.id, { status: reason === 'oracle_failed' ? 'fail' : 'blocked', reason,
          timing: { startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(), totalMs: completed-started, humanWaitMs: 0, processingMs: completed-started } });
      } finally {
        page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onFailed); save();
      }
    }
  } catch {
    for (const c of pending()) transitionCase(run, c.id, { status: 'blocked', reason });
    save();
  }
  // Do not let an incomplete live run look green in CI, even with an approved
  // mock-only SLA exception. The checkpoint is the sanitized diagnostic artifact.
  expect(summarizeRun(run).verdict, 'Full live evidence and owner SLA are not complete; inspect checkpoint').toBe('pass');
});
