import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { build } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const model = '9router:ag/gemini-3.6-flash-high(high)';
const org = 'dddd0000-0000-4000-8000-000000000001';
const syntheticJwt = 'syntheticHeader.syntheticPayload0123456789.syntheticSignature0123456789';
const syntheticAuthorization = 'opaqueSyntheticCredential123';
const artifactSafetyPath = join(root, 'scripts', 'copilot-e2e-artifact-safety.mjs');

let browser;
let bundleDir;
let pinCopilotTestModel;
let waitForCopilotAvailability;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
  bundleDir = mkdtempSync(join(root, '.e2e-fleet', 'controlled', '.workflow-safety-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: join(root, '.e2e-fleet', 'specs', 'copilotTestModel.ts'),
      outDir: bundleDir,
      emptyOutDir: false,
      rollupOptions: { output: { entryFileNames: 'copilotTestModel.mjs' } },
    },
  });
  ({ pinCopilotTestModel, waitForCopilotAvailability } = await import(
    pathToFileURL(join(bundleDir, 'copilotTestModel.mjs')).href
  ));
});

test.after(async () => {
  await browser?.close();
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

test('availability helper waits for the delayed DEMO response body after the picker is ready', async () => {
  assert.equal(typeof waitForCopilotAvailability, 'function', 'shared availability waiter must exist');
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://local').pathname;
    if (path.endsWith('/rpc/get_my_copilot_availability_v1')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"state":"ena');
      return setTimeout(() => res.end('bled"}'), 150);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body>
      <button data-testid="copilot-launcher">Open</button>
      <select data-testid="copilot-model-select"><option value="${model}">${model}</option></select>
      <script>
      document.querySelector('[data-testid="copilot-launcher"]').onclick=()=>{
        void fetch('/rest/v1/rpc/get_my_copilot_availability_v1',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({p_organization_id:${JSON.stringify(org)}})
        });
      };
      </script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    assert.equal(await page.getByTestId('copilot-model-select').isVisible(), true);
    const startedAt = Date.now();
    const response = await waitForCopilotAvailability(
      page,
      org,
      () => page.getByTestId('copilot-launcher').click(),
      { timeoutMs: 1_000 },
    );
    assert.ok(Date.now() - startedAt >= 120, 'waiter returned before the delayed body completed');
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).state, 'enabled');
  } finally {
    await page.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('availability helper fails at its bounded ceiling when no DEMO response arrives', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body><button id="ready">Ready</button></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(
      () => waitForCopilotAvailability(page, org, () => page.locator('#ready').click(), { timeoutMs: 75 }),
      /Timeout 75ms exceeded/,
    );
  } finally {
    await page.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('model pin settles an unfinished route and exposes only method/path/status evidence', async () => {
  let markUpstreamStarted;
  const upstreamStarted = new Promise(resolve => { markUpstreamStarted = resolve; });
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://local').pathname.endsWith('/rest/v1/profiles')) {
      markUpstreamStarted();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body>unfinished profile transport</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage();
  try {
    const pin = await pinCopilotTestModel(page, { fetchTimeoutMs: 75 });
    assert.equal(typeof pin?.dispose, 'function', 'model pin must expose bounded route disposal');
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const requestStarted = page.waitForRequest(request => request.url().includes('/rest/v1/profiles?'));
    await page.evaluate(jwt => {
      void fetch('/rest/v1/profiles?select=ui_preferences&id=eq.synthetic', {
        headers: { Authorization: `Bearer ${jwt}`, apikey: jwt },
      }).catch(() => undefined);
    }, syntheticJwt);
    await requestStarted;
    await upstreamStarted;
    let error;
    try {
      await pin.dispose();
      assert.fail('unfinished route disposal must reject');
    } catch (caught) {
      error = caught;
    }
    assert.match(error.message, /GET \/rest\/v1\/profiles transport_error/);
    assert.doesNotMatch(error.message, /syntheticHeader|Bearer|authorization|apikey/i);
  } finally {
    await page.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});

async function runRedactor(createCopilotE2ERedactor, input, env) {
  const chunks = [...input];
  let output = '';
  for await (const chunk of Readable.from(chunks).pipe(createCopilotE2ERedactor({ env }))) {
    output += chunk.toString();
  }
  return output;
}

test('artifact redactor and guard cover dynamic credentials across arbitrary chunks', async () => {
  assert.equal(existsSync(artifactSafetyPath), true, 'reviewed reusable artifact safety module must exist');
  const {
    createCopilotE2ERedactor,
    inspectCopilotE2EArtifactDirectory,
  } = await import(`${pathToFileURL(artifactSafetyPath).href}?test=${Date.now()}`);
  const env = {
    FLEET_PASS_CHUNHA: 'synthetic-demo-password-123',
    COPILOT_E2E_PIN: '24682468',
    VERCEL_AUTOMATION_BYPASS_SECRET: 'synthetic-bypass-secret-456',
  };
  const raw = [
    `authorization: Bearer ${syntheticAuthorization}`,
    `apikey: ${syntheticJwt}`,
    `password=${env.FLEET_PASS_CHUNHA}`,
    `pin=${env.COPILOT_E2E_PIN}`,
    `bypass=${env.VERCEL_AUTOMATION_BYPASS_SECRET}`,
  ].join('\n');
  const redacted = await runRedactor(createCopilotE2ERedactor, raw, env);
  for (const secret of [syntheticJwt, syntheticAuthorization, ...Object.values(env)]) {
    assert.equal(redacted.includes(secret), false, 'redactor leaked a synthetic secret');
  }
  assert.match(redacted, /\[REDACTED(?:_JWT)?\]|\*\*\*/);

  const dir = mkdtempSync(join(tmpdir(), 'copilot-artifact-guard-'));
  try {
    writeFileSync(join(dir, 'clean.log'), redacted);
    let inspection = inspectCopilotE2EArtifactDirectory(dir, { env });
    assert.deepEqual(inspection.findings, []);
    assert.equal(inspection.passwordSecretCount, 1);
    let cli = spawnSync(process.execPath, [artifactSafetyPath, 'guard', dir], {
      encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true,
    });
    assert.equal(cli.status, 0);

    writeFileSync(join(dir, 'dynamic.log'), `token=${syntheticJwt}\nauthorization: Bearer ${syntheticAuthorization}`);
    writeFileSync(join(dir, 'known.log'), Object.values(env).join('\n'));
    writeFileSync(join(dir, 'encoded.html'), 'data:application/zip;base64,synthetic');
    inspection = inspectCopilotE2EArtifactDirectory(dir, { env });
    const codes = new Set(inspection.findings.map(finding => finding.code));
    assert.deepEqual(
      [...codes].sort(),
      ['authorization-header', 'dynamic-jwt', 'encoded-report', 'known-secret'].sort(),
    );
    assert.deepEqual(
      inspection.findings
        .filter(finding => finding.code === 'known-secret')
        .map(finding => finding.detail)
        .sort(),
      Object.keys(env).sort(),
    );
    assert.equal(JSON.stringify(inspection.findings).includes(syntheticJwt), false);
    cli = spawnSync(process.execPath, [artifactSafetyPath, 'guard', dir], {
      encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true,
    });
    assert.equal(cli.status, 1);
    for (const secret of [syntheticJwt, syntheticAuthorization, ...Object.values(env)]) {
      assert.equal(`${cli.stdout}${cli.stderr}`.includes(secret), false);
    }
    cli = spawnSync(process.execPath, [artifactSafetyPath, 'guard', dir], {
      encoding: 'utf8', env: { PATH: process.env.PATH }, windowsHide: true,
    });
    assert.equal(cli.status, 3, 'guard must fail closed when no FLEET_PASS value is measurable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
