import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { build } from 'vite';
import { parse } from 'yaml';

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
      /75ms.*completed response/i,
    );
  } finally {
    await page.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('availability helper bounds a response body that never finishes', async () => {
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://local').pathname.endsWith('/rpc/get_my_copilot_availability_v1')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"state":"unfinished"');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body><button id="start">Start</button><script>start.onclick=()=>void fetch("/rest/v1/rpc/get_my_copilot_availability_v1",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({p_organization_id:"dddd0000-0000-4000-8000-000000000001"})})</script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const outcome = waitForCopilotAvailability(
      page,
      org,
      () => page.locator('#start').click(),
      { timeoutMs: 75 },
    ).then(
      () => ({ kind: 'resolved' }),
      error => ({ kind: 'rejected', error }),
    );
    const bounded = await Promise.race([
      outcome,
      new Promise(resolve => setTimeout(() => resolve({ kind: 'hung' }), 300)),
    ]);
    assert.equal(bounded.kind, 'rejected', 'stalled response body escaped the availability deadline');
    assert.match(bounded.error.message, /75ms.*completed response/i);
  } finally {
    await page.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});

test('availability helper supervises a slow failing trigger and removes its observer', async () => {
  const page = await browser.newPage();
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const listenersBefore = page.listenerCount('response');
    let triggerSettled = false;
    await assert.rejects(
      () => waitForCopilotAvailability(
        page,
        org,
        async () => {
          try {
            await new Promise(resolve => setTimeout(resolve, 60));
            throw new Error('synthetic slow trigger failure');
          } finally {
            triggerSettled = true;
          }
        },
        { timeoutMs: 20 },
      ),
      /20ms.*completed response/i,
    );
    assert.equal(triggerSettled, false, 'slow trigger escaped the single deadline');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, []);
    assert.equal(page.listenerCount('response'), listenersBefore);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await page.close();
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
  const bytes = Buffer.from(input);
  const chunks = Array.from(bytes, (_value, index) => bytes.subarray(index, index + 1));
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
    FLEET_PASS_KETOAN: 'MậtKhẩu-Điện-987',
    COPILOT_E2E_PIN: '24682468',
    VERCEL_AUTOMATION_BYPASS_SECRET: 'synthetic-bypass-secret-456',
  };
  const authorizationValues = [
    'Basic c3ludGhldGljOnBhc3N3b3Jk',
    'Bearer x',
    `Bearer ${syntheticAuthorization}`,
    'Custom q',
  ];
  const authorizationLines = [
    `Authorization: ${authorizationValues[0]}`,
    `authorization=${authorizationValues[1]}`,
    `"Authorization":"${authorizationValues[2]}"`,
    `'authorization': '${authorizationValues[3]}'`,
  ];
  const raw = [
    ...authorizationLines,
    `apikey: ${syntheticJwt}`,
    `password=${env.FLEET_PASS_CHUNHA}`,
    `trước=${env.FLEET_PASS_KETOAN}=sau`,
    `pin=${env.COPILOT_E2E_PIN}`,
    `bypass=${env.VERCEL_AUTOMATION_BYPASS_SECRET}`,
  ].join('\n');
  const redacted = await runRedactor(createCopilotE2ERedactor, raw, env);
  for (const secret of [syntheticJwt, ...authorizationValues, ...Object.values(env)]) {
    assert.equal(redacted.includes(secret), false, 'redactor leaked a synthetic secret');
  }
  assert.equal(redacted.match(/\[REDACTED_AUTHORIZATION\]/g)?.length, authorizationValues.length);
  assert.match(redacted, /trước=\*\*\*=sau/);

  const dir = mkdtempSync(join(tmpdir(), 'copilot-artifact-guard-'));
  try {
    writeFileSync(join(dir, 'clean.log'), redacted);
    let inspection = inspectCopilotE2EArtifactDirectory(dir, { env });
    assert.deepEqual(inspection.findings, []);
    assert.equal(inspection.passwordSecretCount, 2);
    let cli = spawnSync(process.execPath, [artifactSafetyPath, 'guard', dir], {
      encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true,
    });
    assert.equal(cli.status, 0);

    writeFileSync(join(dir, 'dynamic.log'), `token=${syntheticJwt}`);
    authorizationLines.forEach((line, index) => {
      writeFileSync(join(dir, `authorization-${index}.log`), line);
    });
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
    assert.equal(
      inspection.findings.filter(finding => finding.code === 'authorization-header').length,
      authorizationLines.length,
    );
    assert.equal(JSON.stringify(inspection.findings).includes(syntheticJwt), false);
    cli = spawnSync(process.execPath, [artifactSafetyPath, 'guard', dir], {
      encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true,
    });
    assert.equal(cli.status, 1);
    for (const secret of [syntheticJwt, ...authorizationValues, ...Object.values(env)]) {
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

test('authorization diagnostics never retain credential suffixes', async (t) => {
  const { createCopilotE2ERedactor, inspectCopilotE2EArtifactDirectory } = await import(
    pathToFileURL(artifactSafetyPath).href
  );
  const env = { FLEET_PASS_CHUNHA: 'synthetic-suffix-test-password' };
  const cases = [
    {
      name: 'Digest parameters',
      line: 'Authorization: Digest username="synthetic-user", realm="synthetic-realm", response="synthetic-digest-response"',
      fragments: ['synthetic-user', 'synthetic-realm', 'synthetic-digest-response'],
    },
    {
      name: 'escaped quote in JSON',
      line: JSON.stringify({ Authorization: 'Custom synthetic-prefix"synthetic-quoted-suffix' }),
      fragments: ['synthetic-prefix', 'synthetic-quoted-suffix'],
    },
    {
      name: 'apostrophe in JSON',
      line: JSON.stringify({ Authorization: "Custom synthetic-prefix'synthetic-apostrophe-suffix" }),
      fragments: ['synthetic-prefix', 'synthetic-apostrophe-suffix'],
    },
    {
      name: 'partial marker followed by Digest parameters',
      line: 'Authorization: [REDACTED_AUTHORIZATION], response="synthetic-marker-suffix"',
      fragments: ['synthetic-marker-suffix'],
    },
    {
      name: 'partial marker followed by a brace',
      line: 'Authorization: [REDACTED_AUTHORIZATION]}synthetic-brace-suffix',
      fragments: ['synthetic-brace-suffix'],
    },
  ];
  for (const specimen of cases) {
    await t.test(specimen.name, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'copilot-authorization-suffix-'));
      try {
        const file = join(dir, 'diagnostic.log');
        writeFileSync(file, specimen.line);
        assert.ok(
          inspectCopilotE2EArtifactDirectory(dir, { env }).findings.some(
            finding => finding.code === 'authorization-header',
          ),
          'guard accepted a partial Authorization redaction',
        );
        const input = `before diagnostic\n${specimen.line}\nafter diagnostic`;
        const output = await runRedactor(createCopilotE2ERedactor, input, env);
        for (const fragment of specimen.fragments) {
          assert.equal(output.includes(fragment), false, 'redactor leaked a credential suffix');
        }
        assert.ok(output.startsWith('before diagnostic\n'));
        assert.ok(output.endsWith('\nafter diagnostic'));
        assert.equal(await runRedactor(createCopilotE2ERedactor, output, env), output);
        writeFileSync(file, output);
        assert.deepEqual(inspectCopilotE2EArtifactDirectory(dir, { env }).findings, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('multiline Authorization logs stop before any credential emission', async () => {
  const { createCopilotE2ERedactor, redactCopilotE2EText } = await import(
    pathToFileURL(artifactSafetyPath).href
  );
  const env = { FLEET_PASS_CHUNHA: 'synthetic-multiline-test-password' };
  const credential = 'synthetic-next-line-credential';
  const input = `{\n  "Authorization":\n    "Basic ${credential}"\n}\n`;
  const bytes = Buffer.from(input);
  const chunks = Array.from(bytes, (_value, index) => bytes.subarray(index, index + 1));
  let emitted = '';
  await assert.rejects(async () => {
    for await (const chunk of Readable.from(chunks).pipe(createCopilotE2ERedactor({ env }))) {
      emitted += chunk.toString();
    }
  }, /Authorization value is not on the same diagnostic line/);
  assert.equal(emitted.includes(credential), false);
  assert.throws(
    () => redactCopilotE2EText('Authorization:', { env }),
    /Authorization value is not on the same diagnostic line/,
  );
  await assert.rejects(
    () => runRedactor(createCopilotE2ERedactor, 'Authorization: ', env),
    /Authorization value is not on the same diagnostic line/,
  );
  const cli = spawnSync(process.execPath, [artifactSafetyPath], {
    input, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true,
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /log redaction failed; output suppressed/);
  assert.equal(`${cli.stdout}${cli.stderr}`.includes(credential), false);
});

test('workflow guard wrapper fails closed when its artifact directory is missing', () => {
  const workflow = parse(readFileSync(join(root, '.github', 'workflows', 'copilot-e2e.yml'), 'utf8'));
  const guard = workflow.jobs['copilot-e2e'].steps.find(step => step.id === 'guard');
  assert.equal(typeof guard?.run, 'string', 'workflow guard wrapper must exist');
  const missing = join(tmpdir(), `copilot-missing-artifact-${process.pid}-${Date.now()}`);
  rmSync(missing, { recursive: true, force: true });
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
  const cli = spawnSync(bash, ['-c', guard.run], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      THU_MUC_TAI_LEN: missing,
      FLEET_PASS_CHUNHA: 'synthetic-wrapper-password',
    },
    windowsHide: true,
  });
  assert.equal(cli.status, 1, `${cli.stdout}\n${cli.stderr}`);
  assert.match(`${cli.stdout}${cli.stderr}`, /missing-directory/);
});
