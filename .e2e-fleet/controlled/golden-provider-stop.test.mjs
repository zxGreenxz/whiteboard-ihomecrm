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
  { name: 'accepts a valid completed cycle', status: 200, body: validStream, rounds: 1 },
];

let browser;
let cycleBundleDir;
let guiVaChoModel;

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
          button.style.display='block';`}
        };
        </script></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const page = await browser.newPage();
    page.setDefaultTimeout(500);
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const run = () => guiVaChoModel(page, 'synthetic safety prompt', { organizationId: org });
      if (scenario.error) await assert.rejects(run, scenario.error);
      else assert.equal((await run()).length, scenario.rounds);
    } finally {
      await page.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
