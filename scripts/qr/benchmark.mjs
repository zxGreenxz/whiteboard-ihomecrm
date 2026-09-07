import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = process.cwd();
const manifest = JSON.parse(await fs.readFile(path.join(root, 'test/fixtures/qr/manifest.json'), 'utf8'));
const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cccd-qr-'));
execFileSync(process.execPath, [path.join(root, 'scripts/qr/generate-fixtures.mjs'), fixtureDir], { cwd: root, stdio: 'ignore' });
const current = await fs.readFile(path.join(root, 'src/lib/qrDecoder.ts'), 'utf8');
const baselineArg = process.argv.indexOf('--baseline-ref');
const fixedOnly = process.argv.includes('--fixed');
if (!fixedOnly && baselineArg === -1) throw new Error('Pass --baseline-ref <git-ref> to compare against an explicit reviewed baseline.');
const baselineRef = baselineArg === -1 ? null : process.argv[baselineArg + 1];
if (baselineArg !== -1 && (!baselineRef || baselineRef.startsWith('--'))) throw new Error('--baseline-ref requires a git ref.');
let baseline = null;
if (baselineRef) {
  try { baseline = execFileSync('git', ['show', `${baselineRef}:src/lib/qrDecoder.ts`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error(`Cannot load src/lib/qrDecoder.ts from baseline ref ${baselineRef}.`); }
}
const sources = fixedOnly ? [['fixed', current]] : process.argv.includes('--baseline') ? [['baseline', baseline]] : [['baseline', baseline], ['fixed', current]];
const bundles = {};
for (const [name, source] of sources) {
  const built = await build({ stdin: { contents: source, loader: 'ts', resolveDir: root }, bundle: true, format: 'iife', globalName: name, platform: 'browser', write: false });
  bundles[name] = built.outputFiles[0].text;
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.end('<!doctype html><title>Synthetic QR benchmark</title>');
  const file = path.join(fixtureDir, path.basename(req.url));
  try { res.setHeader('content-type', file.endsWith('.jpg') ? 'image/jpeg' : 'image/svg+xml'); res.end(await fs.readFile(file)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await page.goto(baseUrl);
  for (const [name] of sources) await page.addScriptTag({ content: bundles[name] });
  for (const item of manifest.cases) {
    const extension = item.variant === 'cornerCompressed' ? 'jpg' : 'svg';
    const bytes = await fs.readFile(path.join(fixtureDir, `${item.caseId}.${extension}`));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    for (const [engine] of sources) {
      const row = await page.evaluate(async ({ url, expected, engine }) => {
        const img = new Image(); img.src = url; await img.decode();
        const started = performance.now();
        try {
          const value = await window[engine].decodeQr(img);
          return { success: value === expected, wrongPayload: value !== null && value !== expected, elapsedMs: Math.round((performance.now() - started) * 100) / 100, attempts: 1, terminationReason: value === null ? 'not-found' : 'decoded' };
        } catch { return { success: false, wrongPayload: false, elapsedMs: Math.round((performance.now() - started) * 100) / 100, attempts: 1, terminationReason: 'engine-error' }; }
      }, { url: `${baseUrl}/${item.caseId}.${extension}`, expected: item.payload, engine });
      console.log(JSON.stringify({ caseId: item.caseId, sourceGroup: item.sourceGroup, sha256, engine, ...row }));
    }
  }
} finally { await browser?.close(); server.close(); await fs.rm(fixtureDir, { recursive: true, force: true }); }
