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

for (const [code, reason] of [['quota_exhausted','quota_exhausted'], ['rate_limit_exceeded','rate_exhausted']]) {
  test(`HTTP200 SSE ${code} sends exactly one model request and blocks remaining executable cases`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'golden-controlled-stop-'));
    const attestation = { buildSha: sha, edgeSourceDigest: hash, deployedEdgeSourceDigest: hash, providerModel: model, organizationId: org,
      corpusDigest: digest(golden), manifestDigest: digest(manifest), fixtureDigest: digest(fixture), policyDigest: digest({ permissions: {}, availability: {} }),
      actorDigest: digest(actor), observedAt: new Date().toISOString(), contextId: 'controlled-browser-stop' };
    writeFileSync(join(dir, 'attestation.json'), JSON.stringify(attestation));
    let modelCalls = 0;
    const server = createServer((req, res) => {
      const path = new URL(req.url, 'http://local').pathname;
      const send = (data, type = 'application/json') => { res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
      if (path.endsWith('/rpc/get_my_copilot_availability_v1') || path.endsWith('/rpc/get_my_permissions')) return send({});
      if (path.endsWith('/rpc/copilot_available_rooms_v1')) return send(fixture);
      if (path.includes('/functions/v1/llm-proxy')) {
        modelCalls++;
        return send('data: ' + JSON.stringify({ error: { code, message: 'synthetic controlled failure' } }) + '\n\ndata: [DONE]\n\n', 'text/event-stream');
      }
      if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (path === '/login') return send(`<html><head><meta name="build-sha" content="${sha}"></head><body><input aria-label="Tài Khoản"><input aria-label="Mật khẩu"><button onclick="location.href='/apartments'">Đăng nhập</button></body></html>`, 'text/html');
      return send(`<!doctype html><html><head><meta name="build-sha" content="${sha}"></head><body>
        <button data-testid="copilot-launcher" style="display:none">Open</button>
        <div data-testid="copilot-panel"><select data-testid="copilot-model-select"><option value="${model}">${model}</option></select>
        <button title="Cuộc trò chuyện mới">New</button><input data-testid="copilot-input"><button data-testid="copilot-send">Send</button></div>
        <script>
        const auth={Authorization:${JSON.stringify('Bearer ' + token)},apikey:'synthetic-key','Content-Type':'application/json'};
        fetch('/rest/v1/rpc/get_my_copilot_availability_v1',{method:'POST',headers:auth,body:JSON.stringify({p_organization_id:${JSON.stringify(org)}})}).then(r=>r.json()).then(()=>document.querySelector('[data-testid="copilot-launcher"]').style.display='block');
        document.querySelector('[data-testid="copilot-send"]').onclick=async()=>{
          const button=document.querySelector('[data-testid="copilot-send"]');button.style.display='none';
          const text=document.querySelector('[data-testid="copilot-input"]').value;
          await fetch('/functions/v1/llm-proxy/chat/completions',{method:'POST',headers:{...auth,'x-organization-id':${JSON.stringify(org)}},body:JSON.stringify({model:${JSON.stringify(model)},messages:[{role:'user',content:text}]})}).then(r=>r.text());
          button.style.display='block';
        };
        </script></body></html>`, 'text/html');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const env = { ...process.env, FLEET_BASE_URL: `http://127.0.0.1:${server.address().port}`, FLEET_PASS_CHUNHA: 'synthetic-controlled-only',
        EXPECTED_SOURCE_SHA: sha, COPILOT_E2E_MODEL: model, COPILOT_REVIEWED_EDGE_DIGEST: hash, COPILOT_DEPLOYED_EDGE_DIGEST: hash, VERCEL_AUTOMATION_BYPASS_SECRET: '' };
      const child = spawn(process.execPath, ['scripts/generate-copilot-golden-real-results.mjs', '--attestation', join(dir, 'attestation.json'), '--results-out', join(dir, 'results.json')],
        { cwd: root, env, windowsHide: true, stdio: 'ignore' });
      const exit = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
      const run = JSON.parse(readFileSync(join(dir, 'results.json')));
      assert.equal(exit, 1, 'Full75 live acceptance must remain blocked');
      assert.equal(modelCalls, 1, 'Quota/rate exhaustion must prevent the next model request');
      assert.deepEqual(validateBrowserRun(golden, manifest, run), []);
      assert.equal(run.cases.length, 75);
      for (const id of ['C01','C13']) {
        const c = run.cases.find(c => c.id === id);
        assert.equal(c.status, 'blocked'); assert.equal(c.reason, reason);
        assert.equal(c.observed, undefined);
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
