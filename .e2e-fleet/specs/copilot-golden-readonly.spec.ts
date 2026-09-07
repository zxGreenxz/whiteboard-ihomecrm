import { expect, test, type Request, type Response } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { login, trackConsoleErrors } from './auth';
import { chanChayTrenProduction, xacMinhBanBuild } from './buildAttestation';
import { COPILOT_TEST_MODEL, pinCopilotTestModel } from './copilotTestModel';
import { guiVaChoModel, type ModelCycleStage } from './copilotModelCycle';
import { assertReadonlyResult, inspectModelStream, ModelStreamFailure, unexpectedReadonlyMutation } from './copilotSmokeOracle';
import { diagnosticEndpoint, diagnosticToolName, diagnosticRequestFailure, type GoldenRequestFailure, type GoldenCallDiagnostic } from './copilotGoldenDiagnostics';
import { bindContractScenario, contractQuery, CONTRACT_CASES, type ContractFixture } from '../../scripts/copilot-contract-fixtures.mjs';
import { assertContractResult, contractOracleDiagnostic, isC32CustomerRead, type ContractRead } from './copilotContractOracle';
import { bindIncomeApprovalScenario, incomeApprovalRequest, INCOME_APPROVAL_CASES, type IncomeApprovalFixture } from '../../scripts/copilot-income-approval-fixtures.mjs';
import { assertIncomeApprovalResult, incomeApprovalOracleDiagnostic, incomeApprovalFixtureFailureReason, isIncomeApprovalReadonlyRequest, type IncomeApprovalRead } from './copilotIncomeApprovalOracle';
import { bindRoomScenario, createRun, DEMO_ORG, digest, IMPLEMENTED_ORACLES, summarizeRun, transitionCase, writeCheckpoint } from '../../scripts/copilot-golden-browser-evidence.mjs';
import type { CaseReason, GoldenManifest } from '../../scripts/copilot-golden-browser-evidence.mjs';

const load = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
function assertManifest(value: unknown): asserts value is GoldenManifest {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('scope' in value) || value.scope !== 'full-corpus' || !('cases' in value) || !Array.isArray(value.cases)
    || !value.cases.every((c: unknown) => c && typeof c === 'object'
      && 'id' in c && typeof c.id === 'string' && 'fixture' in c && typeof c.fixture === 'string'
      && 'oracle' in c && typeof c.oracle === 'string' && 'kind' in c && typeof c.kind === 'string'
      && 'prompt' in c && typeof c.prompt === 'string' && 'acceptance' in c && Array.isArray(c.acceptance)
      && c.acceptance.every((item: unknown) => typeof item === 'string'))) throw new Error('Invalid golden manifest');
}
const golden = load(fileURLToPath(new URL('../../tooling/copilot-golden-eval.json', import.meta.url)));
const manifest = load(fileURLToPath(new URL('../../tooling/copilot-golden-scenarios.json', import.meta.url)));
assertManifest(manifest);

// Full inventory stays visible. An unimplemented executor/oracle is incomplete
// engineering work, never an environmental skip and never a passing case.
test('full golden corpus executes attested ChatPanel observations', async ({ page }) => {
  const output = process.env.COPILOT_GOLDEN_RESULTS;
  const attestationPath = process.env.COPILOT_GOLDEN_ATTESTATION;
  if (!output || !attestationPath) throw new Error('Missing golden results/attestation paths');
  const caseIds = process.env.COPILOT_GOLDEN_CASE_IDS;
  const run = createRun(golden, manifest, load(attestationPath), caseIds ? caseIds.split(',') : undefined);
  const attestation = run.attestation;
  const save = () => writeCheckpoint(output, run, golden, manifest);
  for (const c of run.cases) if (c.status === 'pending' && !IMPLEMENTED_ORACLES.has(c.oracle)) transitionCase(run, c.id, { status: 'blocked', reason: 'oracle_not_implemented' });
  save();
  let reason: CaseReason = 'preflight_missing';
  let fatalProvider = false;
  let modelPin: Awaited<ReturnType<typeof pinCopilotTestModel>> | undefined;
  const pending = () => run.cases.filter(c => c.status === 'pending' || c.status === 'running');
  try {
    chanChayTrenProduction();
    expect(COPILOT_TEST_MODEL).toBe(attestation.providerModel);
    expect(process.env.EXPECTED_SOURCE_SHA).toBe(attestation.buildSha);
    // The launcher wrapper needs independent reviewed/deployed edge attestation.
    expect(process.env.COPILOT_DEPLOYED_EDGE_DIGEST).toBe(attestation.deployedEdgeSourceDigest);
    expect(process.env.COPILOT_REVIEWED_EDGE_DIGEST).toBe(attestation.edgeSourceDigest);
    modelPin = await pinCopilotTestModel(page);
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
    await expect(page.getByTestId('copilot-model-select')).toBeEnabled();
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
      if (!scenario) throw new Error('Golden scenario missing from manifest');
      let bound: ReturnType<typeof bindRoomScenario> | ContractFixture | IncomeApprovalFixture;
      let contract: ContractFixture | undefined;
      let financial: IncomeApprovalFixture | undefined;
      try {
        if (Object.hasOwn(CONTRACT_CASES, c.id)) {
          const read = async (rpc: string, data: Record<string, unknown>): Promise<unknown> => {
            const response = await page.request.post(`${api}/rest/v1/rpc/${rpc}`, { headers: auth, data });
            expect(response.ok()).toBe(true); return response.json();
          };
          const listing = c.id === 'C32' ? undefined : await read('copilot_contract_search_v1', { p_organization_id: DEMO_ORG, p_query: null, p_status: null, p_limit: 50 });
          const query = contractQuery(c.id, attestation.contextId, listing);
          const searchPayload = await read('copilot_contract_search_v1', { p_organization_id: DEMO_ORG, p_query: query, p_status: null, p_limit: 20 });
          const customerPayload = c.id === 'C32' ? await read('copilot_customer_search_v1', { p_organization_id: DEMO_ORG, p_search: query }) : undefined;
          // Bind search first to validate a unique UUID before requesting detail.
          const searchScenario = c.id === 'C33' ? { ...scenario, id: 'C31', oracle: CONTRACT_CASES.C31 } : scenario;
          const searched = bindContractScenario(searchScenario, { query, searchPayload, customerPayload });
          const detailPayload = c.id === 'C33' ? await read('copilot_contract_detail_v1', { p_organization_id: DEMO_ORG, p_contract_id: searched.contractId }) : undefined;
          contract = bindContractScenario(scenario, { query, searchPayload, detailPayload, customerPayload });
          expect(digest(contract.attestation)).toBe(digest(attestation.contractFixtures?.[c.id as 'C31'|'C32'|'C33']));
          bound = contract;
        } else if (Object.hasOwn(INCOME_APPROVAL_CASES,c.id)) {
          const request=incomeApprovalRequest(c.id);
          const response=await page.request.post(`${api}/rest/v1/rpc/${request.rpc}`,{headers:auth,data:request.args});
          expect(response.ok()).toBe(true);
          financial=bindIncomeApprovalScenario(scenario,{request,payload:await response.json(),actorDigest:digest(subject)});
          expect(digest(financial.attestation)).toBe(digest(attestation.incomeApprovalFixtures?.[c.id as 'C34'|'C35'|'C36']));
          bound=financial;
        } else bound = bindRoomScenario(scenario, fixture);
      }
      catch { transitionCase(run, c.id, { status: 'blocked', reason: 'fixture_unbound' }); save(); continue; }
      await page.getByTitle('Cuộc trò chuyện mới', { exact: true }).click();
      const assistant = page.getByTestId('copilot-panel').locator('.flex.justify-start.gap-2 > .bg-muted');
      await expect(assistant).toHaveCount(0);
      const reads: Response[] = [], modelRequests: Request[] = [];
      const modelHttpStatuses: number[] = [];
      const callDiagnostics = new Map<Request,GoldenCallDiagnostic>();
      const toolDiagnostics: string[] = [];
      let diagnosticsTruncated = false;
      const requestFailures: GoldenRequestFailure[] = [];
      let requestFailureCount = 0;
      const appOrigin = new URL(page.url()).origin;
      let writes = 0, networkErrors = 0;
      const onRequest = (r: Request) => {
        const contractRead = contract && new URL(r.url()).origin === api && r.method() === 'POST' && /\/rest\/v1\/rpc\/copilot_contract_(search|detail)_v1$/.test(new URL(r.url()).pathname);
        const financialRead = isIncomeApprovalReadonlyRequest(financial,api,r.method(),r.url());
        const customerRead = isC32CustomerRead(c.id,r.method(),r.url(),api);
        const countedAsMutation = !contractRead && !financialRead && !customerRead && unexpectedReadonlyMutation(r.method(), r.url());
        if (countedAsMutation) writes += 1;
        const observedRead = /\/rpc\/copilot_(available_rooms|contract_search|contract_detail)_v1$/.test(new URL(r.url()).pathname);
        if (countedAsMutation || observedRead || financialRead || customerRead) {
          if (callDiagnostics.size < 60) callDiagnostics.set(r,{ endpoint: diagnosticEndpoint(r.url()), httpStatus: null, countedAsMutation });
          else diagnosticsTruncated = true;
        }
        if (/\/functions\/v1\/llm-proxy(?:\/|$)/.test(new URL(r.url()).pathname)) modelRequests.push(r);
      };
      const onResponse = (r: Response) => {
        const diagnostic = callDiagnostics.get(r.request());
        if (diagnostic) diagnostic.httpStatus = r.status();
        if (/\/functions\/v1\/llm-proxy(?:\/|$)/.test(new URL(r.url()).pathname)) modelHttpStatuses.push(r.status());
        if (/\/(rest|functions)\/v1\//.test(r.url()) && !r.ok()) networkErrors += 1;
        if (/\/rpc\/copilot_(available_rooms|contract_search|contract_detail|income_expense_search|pending_requests)_v1$/.test(r.url().split('?')[0])
          || (c.id === 'C32' && new URL(r.url()).pathname.startsWith('/rest/v1/rpc/copilot_customer_search_v1'))) reads.push(r);
        if (/\/functions\/v1\/llm-proxy(?:\/|$)/.test(new URL(r.url()).pathname) && !r.ok()) {
          fatalProvider = true;
          reason = r.status() === 429 ? 'rate_exhausted' : r.status() === 403 ? 'quota_exhausted' : 'provider_failed';
        }
      };
      const onFailed = (r: Request) => {
        networkErrors += 1; requestFailureCount += 1;
        if (requestFailures.length < 60) requestFailures.push(diagnosticRequestFailure(r.url(),r.resourceType(),r.failure()?.errorText,api,appOrigin));
      };
      page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onFailed);
      transitionCase(run, c.id, { status: 'running' }); save();
      const started = Date.now();
      let completed = started;
      let phase: ModelCycleStage | 'idle' | 'mounted' | 'oracle' = 'idle';
      reason = 'browser_failed';
      try {
        // C01's intent is immediate availability. This explicit clarification is
        // declared in the scenario manifest, never derived from expected fields.
        const prompt = bound.prompt;
        const rounds = await guiVaChoModel(page, prompt, { onStage: stage => { phase = stage; } });
        for (const round of rounds) for (const tool of inspectModelStream(round.body).tools) {
          if (toolDiagnostics.length < 40) toolDiagnostics.push(diagnosticToolName(tool.name));
          else diagnosticsTruncated = true;
        }
        phase = 'mounted';
        completed = Date.now();
        await page.waitForLoadState('networkidle');
        await expect(assistant.last()).toBeVisible();
        const answer = await assistant.last().innerText();
        reason = 'oracle_failed';
        phase = 'oracle';
        let rpcDigest: string;
        let absentCounts: { contractCalls: number; customerCalls: number; customerDigest?: string } | undefined;
        for (const r of modelRequests) {
          expect((await r.allHeaders())['x-organization-id']).toBe(DEMO_ORG);
          expect(r.postDataJSON().model).toBe(COPILOT_TEST_MODEL);
        }
        if (contract) {
          for (const r of reads) expect(new URL(r.url()).origin).toBe(api);
          const observedReads: ContractRead[] = await Promise.all(reads.map(async r => {
            const url = new URL(r.url());
            const rpc = url.pathname.split('/').at(-1)!;
            const actualHeaders = await r.request().allHeaders();
            let actorDigest: string | undefined;
            try { const jwt = actualHeaders.authorization.replace(/^Bearer /i,''); actorDigest = digest(JSON.parse(Buffer.from(jwt.split('.')[1],'base64url').toString()).sub); } catch { /* oracle rejects missing actor */ }
            return { rpc, args: r.request().postDataJSON(), payload: await r.json(), ok: r.ok(), actorDigest,
              exactEndpoint: r.request().method() === 'POST' && url.origin === api && !url.search && !url.hash
                && ['/rest/v1/rpc/copilot_contract_search_v1','/rest/v1/rpc/copilot_customer_search_v1'].includes(url.pathname) };
          }));
          assertContractResult({ scenario, fixture: contract, prompt, answer, rounds, reads: observedReads, actorDigest: attestation.actorDigest });
          if (c.id === 'C32') {
            const customerCalls = observedReads.filter(r => r.rpc === 'copilot_customer_search_v1').length;
            absentCounts = { contractCalls: observedReads.length-customerCalls, customerCalls,
              ...(customerCalls ? {customerDigest:digest(observedReads.find(r => r.rpc === 'copilot_customer_search_v1')!.payload)} : {}) };
          }
          rpcDigest = digest(contract.detailPayload ?? contract.searchPayload);
        } else if (financial) {
          for(const r of reads)expect(new URL(r.url()).origin).toBe(api);
          const observedReads:IncomeApprovalRead[]=await Promise.all(reads.map(async r=>{
            const readHeaders=await r.request().allHeaders();
            const readToken=readHeaders.authorization.replace(/^Bearer /i,'');
            const readSubject:unknown=JSON.parse(Buffer.from(readToken.split('.')[1],'base64url').toString()).sub;
            expect(typeof readSubject).toBe('string');
            return {rpc:new URL(r.url()).pathname.split('/').at(-1)!,args:r.request().postDataJSON(),payload:await r.json(),ok:r.ok(),actorDigest:digest(readSubject)};
          }));
          assertIncomeApprovalResult({scenario,fixture:financial,actorDigest:digest(subject),prompt,answer,rounds,reads:observedReads});
          rpcDigest=digest(financial.payload);
        } else {
          expect(reads).toHaveLength(1);
          expect(reads[0].ok()).toBe(true);
          expect(reads[0].url().split('?')[0].endsWith('/rpc/copilot_available_rooms_v1')).toBe(true);
          expect(reads[0].request().postDataJSON().p_organization_id).toBe(DEMO_ORG);
          const payload = await reads[0].json();
          expect(digest(payload)).toBe(digest(fixture));
          assertReadonlyResult({ prompt, answer, rounds, payload, buildingScope: 'buildingScope' in bound ? bound.buildingScope : undefined });
          rpcDigest = digest(payload);
        }
        expect(writes).toBe(0); expect(networkErrors).toBe(0); expect(consoleErrors.length).toBe(0);
        transitionCase(run, c.id, { status: 'pass', timing: {
          startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(), totalMs: completed-started, humanWaitMs: 0, processingMs: completed-started,
        }, observed: { answerDigest: digest(answer), promptDigest: digest(prompt), promptTemplateDigest: digest(scenario.prompt), bindingDigest: bound.bindingDigest, rpcDigest, modelRounds: rounds.length,
          toolResultLinked: true, finalAnswerMounted: true, readRpc: financial ? financial.request.rpc : contract ? (c.id === 'C33' ? 'copilot_contract_detail_v1' : 'copilot_contract_search_v1') : 'copilot_available_rooms_v1',
          ...(financial ? {fixtureDigest:digest(financial.attestation),queryDigest:financial.attestation.queryDigest,identityDigest:financial.attestation.identityDigest,responseDigest:financial.attestation.responseDigest}:{}),
          ...(contract ? { fixtureDigest: digest(contract.attestation), queryDigest: contract.attestation.queryDigest, identityDigest: contract.attestation.identityDigest, searchDigest: contract.attestation.searchDigest, ...(contract.attestation.detailDigest ? { detailDigest: contract.attestation.detailDigest } : {}) } : {}), ...absentCounts, businessWrites: writes, networkErrors, oracleVersion: c.oracle } });
      } catch (error) {
        console.log(JSON.stringify({kind:'golden-request-failures',caseId:c.id,count:requestFailureCount,failures:requestFailures,truncated:requestFailureCount > 60}));
        console.log(JSON.stringify({ kind: 'golden-call-diagnostics', caseId: c.id, tools: toolDiagnostics,
          calls: [...callDiagnostics.values()], truncated: diagnosticsTruncated }));
        console.log(JSON.stringify({ kind: 'golden-case-failure', caseId: c.id, phase,
          modelRequests: modelRequests.length, readResponses: reads.length, modelHttpStatuses,
          businessWrites: writes, networkErrors, consoleErrors: consoleErrors.length }));
        const diagnostic = contractOracleDiagnostic(c.id,error) ?? incomeApprovalOracleDiagnostic(c.id,error);
        if (diagnostic) console.log(JSON.stringify(diagnostic));
        reason = incomeApprovalFixtureFailureReason(error) ?? reason;
        if (error instanceof ModelStreamFailure) { fatalProvider = true; reason = error.reason; }
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
  } finally {
    await modelPin?.dispose();
  }
  // Do not let an incomplete live run look green in CI, even with an approved
  // mock-only SLA exception. The checkpoint is the sanitized diagnostic artifact.
  const summary = summarizeRun(run);
  console.log(JSON.stringify({ selectedScope: summary.selectedScope, selectedCounts: summary.selectedCounts, selectedVerdict: summary.selectedVerdict, fullPlanAccepted: summary.fullPlanAccepted, fullCorpusVerdict: summary.verdict }));
  expect(run.selection ? summary.selectedVerdict : summary.verdict, 'Live evidence incomplete; selected green never implies fullPlanAccepted').toBe('pass');
});
