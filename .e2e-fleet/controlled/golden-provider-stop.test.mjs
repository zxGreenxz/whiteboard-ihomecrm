// Controlled browser regression only: a local synthetic page/transport tests the
// evaluator's stop behavior, not product quality and never a live golden pass.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { build } from 'vite';
import { DEMO_ORG as org, digest, validateBrowserRun } from '../../scripts/copilot-golden-browser-evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const model = '9router:ag/gemini-3.6-flash-high(high)', sha = 'a'.repeat(40), hash = 'b'.repeat(64);
const actor = 'synthetic-controlled-actor';
const token = 'synthetic.' + Buffer.from(JSON.stringify({ sub: actor })).toString('base64url') + '.synthetic';
const fixture = { buildings: [{ id: 'a', name: 'DEMO Toà A' }], rooms: [{ building_id: 'a', code: '101', status_public: 'free' }] };
const golden = JSON.parse(readFileSync(join(root, 'tooling/copilot-golden-eval.json')));
const manifest = JSON.parse(readFileSync(join(root, 'tooling/copilot-golden-scenarios.json')));

for (const [code, reason, readiness] of [
  ['quota_exhausted','quota_exhausted','ready'],
  ['rate_limit_exceeded','rate_exhausted','ready'],
  ['quota_exhausted','quota_exhausted','delayed'],
  ['quota_exhausted','attestation_failed','never'],
]) {
  test(`HTTP200 SSE ${code} with ${readiness} model readiness preserves the preflight and provider stop`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-controlled-stop-'));
    const attestation = { buildSha: sha, edgeSourceDigest: hash, deployedEdgeSourceDigest: hash, providerModel: model, organizationId: org,
      corpusDigest: digest(golden), manifestDigest: digest(manifest), fixtureDigest: digest(fixture), policyDigest: digest({ permissions: {}, availability: {} }),
      actorDigest: digest(actor), observedAt: new Date().toISOString(), contextId: 'controlled-browser-stop' };
    writeFileSync(join(dir, 'attestation.json'), JSON.stringify(attestation));
    let modelCalls = 0;
    let prematureModelCalls = 0, prematureCaseStarts = 0, caseStarts = 0, discoveryAborts = 0;
    let providersReady = readiness === 'ready';
    const waitingModelResponses = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url, 'http://local').pathname;
      const send = (data, type = 'application/json') => { res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
      if (path === '/controlled-provider-discovery') {
        // Only the controlled fixture delays/aborts discovery. The real harness
        // must wait for enabled state, never sleep or exempt request failures.
        req.on('close', () => { discoveryAborts++; });
        return;
      }
      if (path === '/controlled-provider-ready') {
        providersReady = true;
        send({});
        for (const reply of waitingModelResponses) reply();
        return;
      }
      if (path === '/controlled-case-start') {
        caseStarts++;
        if (!providersReady) prematureCaseStarts++;
        return send({});
      }
      if (path.endsWith('/rpc/get_my_copilot_availability_v1') || path.endsWith('/rpc/get_my_permissions')) return send({});
      if (path.endsWith('/rpc/copilot_available_rooms_v1')) return send(fixture);
      if (path.includes('/functions/v1/llm-proxy')) {
        modelCalls++;
        if (req.headers['x-controlled-selector-disabled'] === 'true') prematureModelCalls++;
        const reply = () => send('data: ' + JSON.stringify({ error: { code, message: 'synthetic controlled failure' } }) + '\n\ndata: [DONE]\n\n', 'text/event-stream');
        // Keep an illegally early model cycle open through the discovery abort:
        // removing the readiness gate then reproduces first-case contamination.
        if (readiness === 'delayed' && !providersReady) return waitingModelResponses.push(reply);
        return reply();
      }
      if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (path === '/login') return send(`<html><head><meta name="build-sha" content="${sha}"></head><body><input aria-label="Tài Khoản"><input aria-label="Mật khẩu"><button onclick="location.href='/apartments'">Đăng nhập</button></body></html>`, 'text/html');
      return send(`<!doctype html><html><head><meta name="build-sha" content="${sha}"></head><body>
        <button data-testid="copilot-launcher" style="display:none">Open</button>
        <div data-testid="copilot-panel"><select data-testid="copilot-model-select" ${readiness === 'ready' ? '' : 'disabled'}><option value="${model}">${readiness === 'ready' ? model : 'Loading providers'}</option></select>
        <button title="Cuộc trò chuyện mới">New</button><input data-testid="copilot-input"><button data-testid="copilot-send">Send</button></div>
        <script>
        const auth={Authorization:${JSON.stringify('Bearer ' + token)},apikey:'synthetic-key','Content-Type':'application/json'};
        const selector=document.querySelector('[data-testid="copilot-model-select"]');
        document.querySelector('[title="Cuộc trò chuyện mới"]').onclick=()=>fetch('/controlled-case-start');
        document.querySelector('[data-testid="copilot-launcher"]').onclick=async()=>{
          ${readiness === 'delayed' ? `try { await fetch('/controlled-provider-discovery',{signal:AbortSignal.timeout(1500)}); } catch {}
          await fetch('/controlled-provider-ready');
          selector.disabled=false;` : ''}
        };
        fetch('/rest/v1/rpc/get_my_copilot_availability_v1',{method:'POST',headers:auth,body:JSON.stringify({p_organization_id:${JSON.stringify(org)}})}).then(r=>r.json()).then(()=>document.querySelector('[data-testid="copilot-launcher"]').style.display='block');
        document.querySelector('[data-testid="copilot-send"]').onclick=async()=>{
          const button=document.querySelector('[data-testid="copilot-send"]');button.style.display='none';
          const text=document.querySelector('[data-testid="copilot-input"]').value;
          await fetch('/functions/v1/llm-proxy/chat/completions',{method:'POST',headers:{...auth,'x-organization-id':${JSON.stringify(org)},'x-controlled-selector-disabled':String(selector.disabled)},body:JSON.stringify({model:${JSON.stringify(model)},messages:[{role:'user',content:text}]})}).then(r=>r.text());
          button.style.display='block';
        };
        </script></body></html>`, 'text/html');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const env = { ...process.env, FLEET_BASE_URL: `http://127.0.0.1:${server.address().port}`, FLEET_PASS_CHUNHA: 'synthetic-controlled-only',
        EXPECTED_SOURCE_SHA: sha, COPILOT_E2E_MODEL: model, COPILOT_REVIEWED_EDGE_DIGEST: hash, COPILOT_DEPLOYED_EDGE_DIGEST: hash, VERCEL_AUTOMATION_BYPASS_SECRET: '' };
      const child = spawn(process.execPath, ['scripts/generate-copilot-golden-real-results.mjs', '--attestation', join(dir, 'attestation.json'), '--results-out', join(dir, 'results.json')],
        { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const exit = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
      const run = JSON.parse(readFileSync(join(dir, 'results.json')));
      const failureLine = output.split(/\r?\n/).find(line => line.startsWith('{"kind":"golden-case-failure"'));
      const caseFailure = failureLine ? JSON.parse(failureLine) : undefined;
      t.diagnostic(JSON.stringify({ readiness, modelCalls, prematureModelCalls, caseStarts, prematureCaseStarts, discoveryAborts, caseFailure }));
      assert.equal(exit, 1, 'Full75 live acceptance must remain blocked');
      assert.equal(prematureModelCalls, 0, 'Disabled pinned-value placeholder must not permit model submission');
      assert.equal(prematureCaseStarts, 0, 'No case may start before provider readiness');
      assert.equal(modelCalls, readiness === 'never' ? 0 : 1, 'Readiness must precede submission; provider exhaustion must prevent another request');
      assert.equal(caseStarts, readiness === 'never' ? 0 : 1);
      if (readiness === 'delayed') {
        assert.equal(discoveryAborts, 1, 'Controlled initialization discovery must actually abort');
        assert.ok(caseFailure, 'Actual golden harness must emit case diagnostics');
        assert.equal(caseFailure.networkErrors, 0, 'Initialization abort must settle before case listeners attach');
      }
      assert.deepEqual(validateBrowserRun(golden, manifest, run), []);
      assert.equal(run.cases.length, 75);
      for (const id of ['C01','C13']) {
        const c = run.cases.find(c => c.id === id);
        assert.equal(c.status, 'blocked'); assert.equal(c.reason, reason);
        assert.equal(c.observed, undefined);
        if (readiness === 'never') assert.equal(c.timing, undefined, 'Never-enabled UI cannot start a timed case');
      }
      assert.equal(run.cases.find(c => c.id === 'C13').timing, undefined, 'Unsent case must have no measured timing');
    } finally {
      await new Promise(resolve => server.close(resolve));
      // mkdtemp result under OS temp is the exact directory owned by this test.
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

const validStream = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Đã giữ nguyên bước xác nhận.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
const providerErrorStream = 'data: ' + JSON.stringify({ error: { code: 'quota_exhausted', message: 'synthetic controlled failure' } }) + '\n\ndata: [DONE]\n\n';
const missingDoneStream = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'incomplete' }, finish_reason: 'stop' }] }) + '\n\n';
const cycleCases = [
  { name: 'rejects no model request', sendModel: false, error: /Timeout .* exceeded/ },
  { name: 'rejects HTTP 403', status: 403, body: '{}', error: /không hoạt động/ },
  { name: 'rejects an HTTP 200 provider error', status: 200, body: providerErrorStream, error: /Provider error/ },
  { name: 'rejects a stream without DONE', status: 200, body: missingDoneStream, error: /missing DONE/ },
  { name: 'rejects the wrong outbound model', status: 200, body: validStream, outboundModel: '9router:ag/gemini-3.7-flash-high(high)', error: /sai model/ },
  { name: 'rejects the wrong organization header', status: 200, body: validStream, outboundOrganization: 'ffffffff-0000-4000-8000-0000000000ff', error: /sai phạm vi/ },
  { name: 'rejects a model cycle that does not quiesce before its ceiling', status: 200, body: validStream, sendDelayMs: 300, completionTimeoutMs: 75, error: /toBeVisible/ },
  { name: 'accepts a valid completed cycle', status: 200, body: validStream, rounds: 1 },
];

let browser;
let cycleBundleDir;
let guiVaChoModel;
let taoBoThuGomKeHoachChat;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
  cycleBundleDir = mkdtempSync(join(root, '.e2e-fleet', 'controlled', '.model-cycle-'));
  const outfile = join(cycleBundleDir, 'copilotModelCycle.mjs');
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: join(root, '.e2e-fleet', 'specs', 'copilotModelCycle.ts'),
      outDir: cycleBundleDir,
      emptyOutDir: false,
      rollupOptions: {
        external: ['@playwright/test'],
        output: { entryFileNames: 'copilotModelCycle.mjs' },
      },
    },
  });
  ({ guiVaChoModel } = await import(pathToFileURL(outfile).href));
  const cleanupOutfile = join(cycleBundleDir, 'copilotPlanCleanup.mjs');
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: join(root, '.e2e-fleet', 'specs', 'copilotPlanCleanup.ts'),
      outDir: cycleBundleDir,
      emptyOutDir: false,
      rollupOptions: {
        external: ['@playwright/test'],
        output: { entryFileNames: 'copilotPlanCleanup.mjs' },
      },
    },
  });
  ({ taoBoThuGomKeHoachChat } = await import(pathToFileURL(cleanupOutfile).href));
});

test.after(async () => {
  await browser?.close();
  if (cycleBundleDir) rmSync(cycleBundleDir, { recursive: true, force: true });
});

for (const scenario of cycleCases) {
  test(`shared model-cycle helper ${scenario.name}`, async () => {
    const server = createServer((req, res) => {
      const path = new URL(req.url, 'http://local').pathname;
      if (path.includes('/functions/v1/llm-proxy')) {
        res.writeHead(scenario.status ?? 200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        return res.end(scenario.body ?? validStream);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><body>
        <div data-testid="copilot-panel"></div>
        <input data-testid="copilot-input"><button data-testid="copilot-send">Send</button>
        <script>
        document.querySelector('[data-testid="copilot-send"]').onclick=async()=>{
          ${scenario.sendModel === false ? '' : `const button=document.querySelector('[data-testid="copilot-send"]');button.style.display='none';
          await fetch('/functions/v1/llm-proxy/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','x-organization-id':${JSON.stringify(scenario.outboundOrganization ?? org)}},body:JSON.stringify({model:${JSON.stringify(scenario.outboundModel ?? model)},messages:[{role:'user',content:document.querySelector('[data-testid="copilot-input"]').value}]})}).then(r=>r.text());
          ${scenario.sendDelayMs ? `await new Promise(resolve=>setTimeout(resolve,${scenario.sendDelayMs}));` : ''}
          button.style.display='block';`}
        };
        </script></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const page = await browser.newPage();
    page.setDefaultTimeout(500);
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const run = () => guiVaChoModel(page, 'synthetic safety prompt', {
        organizationId: org,
        completionTimeoutMs: scenario.completionTimeoutMs,
      });
      if (scenario.error) await assert.rejects(run, scenario.error);
      else assert.equal((await run()).length, scenario.rounds);
    } finally {
      await page.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('plan cleanup leaves replay/malformed plans and still cancels a proven fresh plan', async () => {
  const preExistingId = '11111111-1111-4111-8111-111111111111';
  const freshId = '22222222-2222-4222-8222-222222222222';
  const malformedId = '44444444-4444-4444-8444-444444444444';
  const wrongOrgReplayId = '55555555-5555-4555-8555-555555555555';
  const marker = 'E2E-G3-ownership-controlled';
  const plans = new Map([
    [preExistingId, { organization_id: org, plan_status: 'DRAFT', plan_version: 7 }],
    [freshId, { organization_id: org, plan_status: 'DRAFT', plan_version: 1 }],
    [malformedId, { organization_id: org, plan_status: 'DRAFT', plan_version: 4 }],
    [wrongOrgReplayId, { organization_id: 'ffffffff-0000-4000-8000-0000000000ff', plan_status: 'APPROVED', plan_version: 9 }],
  ]);
  const cancelled = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const path = new URL(req.url, 'http://local').pathname;
      const body = raw ? JSON.parse(raw) : {};
      const send = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (path.endsWith('/rpc/copilot_plan_create_v1')) {
        const replay = body.p_client_request_id === 'controlled-replay';
        const malformed = body.p_client_request_id === 'controlled-malformed';
        const wrongOrgReplay = body.p_client_request_id === 'controlled-wrong-org-replay';
        const plan_id = replay ? preExistingId : malformed ? malformedId : wrongOrgReplay ? wrongOrgReplayId : freshId;
        if (malformed) return send({ ok: true, plan_id, organization_id: org, plan_status: 'DRAFT', plan_version: plans.get(plan_id).plan_version });
        const plan = plans.get(plan_id);
        return send({ ok: true, da_ton_tai: replay || wrongOrgReplay, plan_id, organization_id: plan.organization_id, plan_status: plan.plan_status, plan_version: plan.plan_version });
      }
      if (path.endsWith('/rpc/copilot_plan_get_v1')) return send(plans.get(body.p_plan_id));
      if (path.endsWith('/rpc/copilot_plan_cancel_v1')) {
        const plan = plans.get(body.p_plan_id);
        cancelled.push(body.p_plan_id);
        plan.plan_status = 'CANCELLED';
        plan.plan_version++;
        return send({ ok: true, plan_id: body.p_plan_id, plan_status: 'CANCELLED' });
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body>controlled cleanup</body></html>');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (name, body) => {
    const response = await page.request.post(`${base}/rest/v1/rpc/${name}`, {
      headers: { Authorization: `Bearer ${token}` }, data: body,
    });
    return { status: response.status(), body: await response.json() };
  };
  try {
    await page.goto(base);
    const collector = taoBoThuGomKeHoachChat({
      page, actor, organizationId: org, marker,
      readPlan: async id => (await rpc('copilot_plan_get_v1', { p_plan_id: id })).body,
      cancelPlan: (id, version) => rpc('copilot_plan_cancel_v1', { p_plan_id: id, p_expected_plan_version: version }),
    });
    const common = { p_organization_id: org, p_steps: [{ ten: `synthetic ${marker}` }] };
    await page.evaluate(async ({ common, token }) => {
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      await fetch('/rest/v1/rpc/copilot_plan_create_v1', { method: 'POST', headers, body: JSON.stringify({ ...common, p_client_request_id: 'controlled-replay' }) });
      await fetch('/rest/v1/rpc/copilot_plan_create_v1', { method: 'POST', headers, body: JSON.stringify({ ...common, p_client_request_id: 'controlled-malformed' }) });
      await fetch('/rest/v1/rpc/copilot_plan_create_v1', { method: 'POST', headers, body: JSON.stringify({ ...common, p_client_request_id: 'controlled-wrong-org-replay' }) });
      await fetch('/rest/v1/rpc/copilot_plan_create_v1', { method: 'POST', headers, body: JSON.stringify({ p_organization_id: common.p_organization_id, p_steps: [{ ten: 'model omitted marker' }], p_client_request_id: 'controlled-fresh' }) });
    }, { common, token });
    await assert.rejects(
      () => collector.finish(),
      error => error.message.includes('không cho biết đây là tạo mới hay phát lại')
        && error.message.includes('thiếu marker riêng')
        && error.message.includes('trả về sai tổ chức'),
    );
    assert.deepEqual(cancelled, [freshId]);
    assert.equal(plans.get(preExistingId).plan_status, 'DRAFT');
    assert.equal(plans.get(malformedId).plan_status, 'DRAFT');
    assert.equal(plans.get(wrongOrgReplayId).plan_status, 'APPROVED');
    assert.equal(plans.get(freshId).plan_status, 'CANCELLED');
  } finally {
    await page.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('plan cleanup settles a delayed fresh create after model wait failure and stop', async () => {
  const freshId = '33333333-3333-4333-8333-333333333333';
  const marker = 'E2E-G3-delayed-controlled';
  const plan = { organization_id: org, plan_status: 'DRAFT', plan_version: 1 };
  const cancelled = [];
  let createCalls = 0;
  let stopped = false;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const path = new URL(req.url, 'http://local').pathname;
      const body = raw ? JSON.parse(raw) : {};
      const send = (data, type = 'application/json') => {
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        res.end(typeof data === 'string' ? data : JSON.stringify(data));
      };
      if (path.includes('/functions/v1/llm-proxy')) return send(validStream, 'text/event-stream');
      if (path.endsWith('/rpc/copilot_plan_create_v1')) {
        createCalls++;
        return setTimeout(() => send({
          ok: true, da_ton_tai: false, plan_id: freshId,
          organization_id: org, plan_status: 'DRAFT', plan_version: plan.plan_version,
        }), 300);
      }
      if (path.endsWith('/rpc/copilot_plan_get_v1')) return send(plan);
      if (path.endsWith('/rpc/copilot_plan_cancel_v1')) {
        cancelled.push(body.p_plan_id);
        plan.plan_status = 'CANCELLED';
        plan.plan_version++;
        return send({ ok: true, plan_id: body.p_plan_id, plan_status: 'CANCELLED' });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <div data-testid="copilot-panel"></div>
        <input data-testid="copilot-input"><button data-testid="copilot-send">Send</button>
        <button title="Dừng" style="display:none">Stop</button>
        <script>
        const auth={Authorization:${JSON.stringify(`Bearer ${token}`)},'Content-Type':'application/json'};
        const send=document.querySelector('[data-testid="copilot-send"]'), stop=document.querySelector('[title="Dừng"]');
        stop.onclick=()=>{window.controlledStopped=true;};
        send.onclick=async()=>{
          send.style.display='none';stop.style.display='block';
          await fetch('/functions/v1/llm-proxy/chat/completions',{method:'POST',headers:{...auth,'x-organization-id':${JSON.stringify(org)}},body:JSON.stringify({model:${JSON.stringify(model)},messages:[{role:'user',content:'controlled'}]})}).then(r=>r.text());
          await fetch('/rest/v1/rpc/copilot_plan_create_v1',{method:'POST',headers:auth,body:JSON.stringify({p_organization_id:${JSON.stringify(org)},p_client_request_id:'controlled-delayed',p_steps:[{ten:${JSON.stringify(marker)}}]})});
          stop.style.display='none';send.style.display='block';
        };
        </script></body></html>`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (name, body) => {
    const response = await page.request.post(`${base}/rest/v1/rpc/${name}`, {
      headers: { Authorization: `Bearer ${token}` }, data: body,
    });
    return { status: response.status(), body: await response.json() };
  };
  try {
    await page.goto(base);
    const collector = taoBoThuGomKeHoachChat({
      page, actor, organizationId: org, marker, settleTimeoutMs: 1_000,
      readPlan: async id => (await rpc('copilot_plan_get_v1', { p_plan_id: id })).body,
      cancelPlan: (id, version) => rpc('copilot_plan_cancel_v1', { p_plan_id: id, p_expected_plan_version: version }),
    });
    await assert.rejects(
      () => guiVaChoModel(page, 'synthetic safety prompt', { organizationId: org, completionTimeoutMs: 75 }),
      /toBeVisible/,
    );
    const result = await collector.finish(async () => {
      await page.getByTitle('Dừng', { exact: true }).click();
      stopped = await page.evaluate(() => window.controlledStopped === true);
    });
    assert.equal(stopped, true);
    assert.equal(createCalls, 1);
    assert.equal(result.startedRequests, 1);
    assert.deepEqual(result.freshPlanIds, [freshId]);
    assert.deepEqual(cancelled, [freshId]);
    assert.equal(plan.plan_status, 'CANCELLED');
  } finally {
    await page.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('plan cleanup reports exact ownership evidence when transport stays unknown', async () => {
  const marker = 'E2E-G3-unknown-controlled';
  const clientRequestId = 'controlled-unknown-request';
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://local').pathname;
    if (path.endsWith('/rpc/copilot_plan_create_v1')) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>unknown transport</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(base);
    const collector = taoBoThuGomKeHoachChat({
      page, actor, organizationId: org, marker, settleTimeoutMs: 75,
      readPlan: async () => { throw new Error('read must not run for unknown transport'); },
      cancelPlan: async () => { throw new Error('cancel must not run for unknown transport'); },
    });
    const started = page.waitForRequest(request => request.url().endsWith('/rpc/copilot_plan_create_v1'));
    await page.evaluate(({ token, org, marker, clientRequestId }) => {
      void fetch('/rest/v1/rpc/copilot_plan_create_v1', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p_organization_id: org,
          p_client_request_id: clientRequestId,
          p_steps: [{ ten: marker }],
        }),
      });
    }, { token, org, marker, clientRequestId });
    await started;
    await assert.rejects(
      () => collector.finish(),
      error => error.message.includes('không được tuyên bố cleanup')
        && error.message.includes(`actor=${actor}`)
        && error.message.includes(`organization=${org}`)
        && error.message.includes(`client_request_id=${clientRequestId}`),
    );
    assert.equal(collector.startedCount(), 1);
  } finally {
    await page.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});

// The actual registered browser executor, with loopback synthetic transport.
// A controlled pass is harness proof only; it is never a live model result.
for(const caseId of ['C14','C02'])test(`${caseId} registered customer cycle requires bound fixture evidence`,async()=>{
  const {bindCustomerScenario,customerQuery}=await import('../../scripts/copilot-customer-fixtures.mjs');
  const dir=mkdtempSync(join(tmpdir(),'golden-controlled-customer-'));
  const contextId='controlled-customer',query=customerQuery(caseId,contextId),scenario=manifest.cases.find(c=>c.id===caseId);
  const row={customer_id:'aaaa4000-0000-4000-8000-000000000071',customer_name:'Nguyễn An',phone:customerQuery('C14',contextId),contract_id:'10b1a785-6344-4598-812c-6dc6e98837ed',contract_number:'HD-GOLDEN',contract_status:'TERMINATED',room_id:'aaaa4000-0000-4000-8000-000000000073',room_name:'G701',building_id:'aaaa4000-0000-4000-8000-000000000074',building_name:'DEMO Toà A',is_representative:false};
  const payload=caseId==='C02'?[row]:[];
  const ownership={kind:'owned-c02-v1',state:'ready',organizationId:org,implementationSha:sha,customerId:row.customer_id,associationId:'aaaa4000-0000-4000-8000-000000000075',hostId:row.contract_id,roomId:row.room_id,buildingId:row.building_id,actorDigest:digest(actor),contextDigest:digest(contextId),phoneDigest:digest(row.phone),markerDigest:digest(`COPILOT_C02_${contextId}_${row.customer_id}`),hostDigest:hash,associationsDigest:hash,customerDigest:hash,associationDigest:hash,responseDigest:digest(payload),reviewDigest:hash};
  const bound=bindCustomerScenario(scenario,{query,contextId,actorDigest:digest(actor),payload,ownership:caseId==='C02'?ownership:undefined});
  const attestation={buildSha:sha,edgeSourceDigest:hash,deployedEdgeSourceDigest:hash,providerModel:model,organizationId:org,corpusDigest:digest(golden),manifestDigest:digest(manifest),fixtureDigest:digest(fixture),policyDigest:digest({permissions:{},availability:{}}),actorDigest:digest(actor),observedAt:new Date().toISOString(),contextId,customerFixtures:{[caseId]:bound.attestation}};
  writeFileSync(join(dir,'attestation.json'),JSON.stringify(attestation));
  const text=caseId==='C02'?`- Nguyễn An — ${row.phone.slice(0,3)}***${row.phone.slice(-4)} — phòng G701 (DEMO Toà A) [link: /customers/${row.customer_id}]`:`Không tìm thấy khách hàng nào khớp "${query}".`;
  let modelCalls=0,customerReads=0;
  const sse=(delta,finish_reason)=>'data: '+JSON.stringify({choices:[{delta,finish_reason}]})+'\n\ndata: [DONE]\n\n';
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://local').pathname;
    const send=(data,type='application/json')=>{res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(typeof data==='string'?data:JSON.stringify(data));};
    if(path.endsWith('/rpc/get_my_copilot_availability_v1')||path.endsWith('/rpc/get_my_permissions'))return send({});
    if(path.endsWith('/rpc/copilot_available_rooms_v1'))return send(fixture);
    if(path.endsWith('/rpc/copilot_customer_search_v1')){customerReads++;return send(payload);}
    if(path.includes('/functions/v1/llm-proxy')){modelCalls++;return send(modelCalls===1?sse({tool_calls:[{index:0,id:'customer-controlled-call',function:{name:'tim_khach_hang',arguments:JSON.stringify({tu_khoa:query})}}]},'tool_calls'):sse({content:text},'stop'),'text/event-stream');}
    if(path==='/favicon.ico'){res.writeHead(204);return res.end();}
    if(path==='/login')return send(`<html><head><meta name="build-sha" content="${sha}"></head><body><input aria-label="Tài Khoản"><input aria-label="Mật khẩu"><button onclick="location.href='/apartments'">Đăng nhập</button></body></html>`,'text/html');
    return send(`<!doctype html><html><head><meta name="build-sha" content="${sha}"></head><body>
      <button data-testid="copilot-launcher" style="display:none">Open</button><div data-testid="copilot-panel"><select data-testid="copilot-model-select"><option value="${model}">${model}</option></select><button title="Cuộc trò chuyện mới">New</button><input data-testid="copilot-input"><button data-testid="copilot-send">Send</button><div id="answer"></div></div>
      <script>
      const auth={Authorization:${JSON.stringify('Bearer '+token)},apikey:'synthetic-key','Content-Type':'application/json'};
      fetch('/rest/v1/rpc/get_my_copilot_availability_v1',{method:'POST',headers:auth,body:JSON.stringify({p_organization_id:${JSON.stringify(org)}})}).then(r=>r.json()).then(()=>document.querySelector('[data-testid="copilot-launcher"]').style.display='block');
      document.querySelector('[data-testid="copilot-send"]').onclick=async()=>{
        const button=document.querySelector('[data-testid="copilot-send"]');button.style.display='none';
        const prompt=document.querySelector('[data-testid="copilot-input"]').value,messages=[{role:'user',content:prompt}];
        const modelRequest=()=>fetch('/functions/v1/llm-proxy/chat/completions',{method:'POST',headers:{...auth,'x-organization-id':${JSON.stringify(org)}},body:JSON.stringify({model:${JSON.stringify(model)},messages})}).then(r=>r.text());
        await modelRequest();
        await fetch('/rest/v1/rpc/copilot_customer_search_v1',{method:'POST',headers:auth,body:JSON.stringify({p_organization_id:${JSON.stringify(org)},p_search:${JSON.stringify(query)}})}).then(r=>r.json());
        messages.push({role:'tool',tool_call_id:'customer-controlled-call',content:${JSON.stringify(text)}});await modelRequest();
        document.querySelector('#answer').innerHTML='<div class="flex justify-start gap-2"><div class="bg-muted"></div></div>';
        document.querySelector('.bg-muted').textContent=${JSON.stringify(text)};button.style.display='block';
      };
      </script></body></html>`,'text/html');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const env={...process.env,FLEET_BASE_URL:`http://127.0.0.1:${server.address().port}`,FLEET_PASS_CHUNHA:'synthetic-controlled-only',EXPECTED_SOURCE_SHA:sha,COPILOT_E2E_MODEL:model,COPILOT_REVIEWED_EDGE_DIGEST:hash,COPILOT_DEPLOYED_EDGE_DIGEST:hash,VERCEL_AUTOMATION_BYPASS_SECRET:''};
    const child=spawn(process.execPath,['scripts/generate-copilot-golden-real-results.mjs','--attestation',join(dir,'attestation.json'),'--results-out',join(dir,'results.json'),'--case-ids',caseId==='C02'?'C02':'C02,C14'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',c=>{output+=c;});child.stderr.on('data',c=>{output+=c;});
    const exit=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);});
    const run=JSON.parse(readFileSync(join(dir,'results.json')));
    assert.equal(exit,caseId==='C02'?0:1,output);
    if(caseId==='C14'){assert.equal(run.cases.find(c=>c.id==='C02').reason,'fixture_unbound');assert.equal(run.cases.find(c=>c.id==='C02').timing,undefined);}
    assert.equal(run.cases.find(c=>c.id===caseId).status,'pass',output);assert.equal(modelCalls,2);assert.equal(customerReads,2);
    assert.equal(run.cases.find(c=>c.id==='C01').status,'not_selected');assert.equal(run.cases.find(c=>c.id==='C13').status,'not_selected');assert.equal(run.cases.length,75);assert.deepEqual(validateBrowserRun(golden,manifest,run),[]);
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
