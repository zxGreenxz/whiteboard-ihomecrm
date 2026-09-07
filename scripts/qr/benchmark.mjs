import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build as buildHistorical } from 'esbuild';
import { build as buildVite, normalizePath } from 'vite';
import { chromium } from 'playwright';

function argumentsFor(argv, root) {
  let fixed = false, baselineOnly = false, baselineRef;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
    seen.add(arg);
    if (arg === '--fixed') fixed = true;
    else if (arg === '--baseline') baselineOnly = true;
    else if (arg === '--baseline-ref') {
      baselineRef = argv[++i];
      if (!baselineRef || baselineRef.startsWith('-')) throw new Error('--baseline-ref requires a git ref.');
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (fixed && (baselineOnly || baselineRef)) throw new Error('--fixed cannot be combined with baseline arguments.');
  if (!fixed && !baselineRef) throw new Error('Pass --fixed or --baseline-ref <git-ref>.');
  let baseline;
  if (baselineRef) {
    try {
      const sha = execFileSync('git', ['rev-parse', '--verify', `${baselineRef}^{commit}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      baseline = execFileSync('git', ['show', `${sha}:src/lib/qrDecoder.ts`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { throw new Error(`Cannot load src/lib/qrDecoder.ts from baseline ref ${baselineRef}.`); }
    // Historical lanes are self-contained decoders, never worker-era facades
    // resolved against today's client (which would compare current twice).
    if (/from\s*['"]\.|import\s*\(\s*['"]\.|import\.meta/.test(baseline)) {
      throw new Error('Baseline must be a historical self-contained decoder; use --fixed for the current worker pipeline.');
    }
  }
  return { baseline, engines: fixed ? ['fixed'] : baselineOnly ? ['baseline'] : ['baseline', 'fixed'] };
}

async function buildCurrent(root, outDir) {
  const entry = 'virtual:qr-benchmark';
  await buildVite({
    configFile: false, root, publicDir: false, logLevel: 'silent',
    resolve: { alias: { '@': path.join(root, 'src') } },
    worker: { format: 'es' },
    plugins: [{
      name: 'qr-benchmark-entry',
      resolveId(id) { if (id === entry) return '\0' + entry; },
      load(id) {
        if (id === '\0' + entry) return `import { createQrScanner } from ${JSON.stringify(normalizePath(path.join(root, 'src/lib/qr/client.ts')))}; export const scanner = createQrScanner();`;
      },
    }],
    build: { outDir, emptyOutDir: true, rollupOptions: { input: entry, preserveEntrySignatures: 'strict', output: { entryFileNames: 'current.mjs' } } },
  });
}

const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };

export async function runBenchmark(argv, dependencies = {}) {
  const root = dependencies.root ?? process.cwd();
  const write = dependencies.write ?? ((row) => console.log(JSON.stringify(row)));
  let stage = 'arguments', scratch, server, browser;
  try {
    const { baseline, engines } = argumentsFor(argv, root);
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'test/fixtures/qr/manifest.json'), 'utf8'));
    stage = 'fixtures';
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cccd-qr-'));
    const fixtureDir = path.join(scratch, 'fixtures');
    execFileSync(process.execPath, [path.join(root, 'scripts/qr/generate-fixtures.mjs'), fixtureDir], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsHide: true,
      env: { ...process.env, TMP: scratch, TEMP: scratch, TMPDIR: scratch },
    });
    stage = 'build';
    const outDir = path.join(scratch, 'built');
    await fs.mkdir(outDir);
    if (engines.includes('fixed')) await (dependencies.buildCurrent ?? buildCurrent)(root, outDir);
    if (baseline) {
      const built = await buildHistorical({ stdin: { contents: baseline, loader: 'ts', resolveDir: path.join(root, 'src/lib') }, bundle: true, format: 'esm', platform: 'browser', write: false });
      await fs.writeFile(path.join(outDir, 'baseline.mjs'), built.outputFiles[0].text);
    }
    stage = 'server';
    const config = JSON.parse(await fs.readFile(path.join(root, 'vercel.json'), 'utf8'));
    const csp = config.headers.flatMap((item) => item.headers).find((item) => item.key === 'Content-Security-Policy').value;
    server = http.createServer(async (req, res) => {
      res.setHeader('Content-Security-Policy', csp);
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Synthetic QR benchmark</title>'); return; }
      const directory = pathname.startsWith('/fixtures/') ? fixtureDir : pathname.startsWith('/qr-assets/') ? path.join(root, 'public') : outDir;
      const relative = pathname.startsWith('/fixtures/') ? pathname.slice('/fixtures/'.length) : pathname.slice(1);
      const file = path.resolve(directory, relative);
      if (!file.startsWith(path.resolve(directory) + path.sep)) { res.writeHead(403).end(); return; }
      try { res.setHeader('content-type', mime[path.extname(file)] ?? 'application/octet-stream'); res.end(await fs.readFile(file)); }
      catch { res.writeHead(404).end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    stage = 'browser';
    browser = await (dependencies.launchBrowser ?? (() => chromium.launch({ headless: true })))();
    const page = await browser.newPage({ bypassCSP: false });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await page.goto(baseUrl);
    stage = 'scan';
    let failed = false;
    for (const item of manifest.cases) {
      const extension = item.variant === 'cornerCompressed' ? 'jpg' : 'svg';
      const bytes = await fs.readFile(path.join(fixtureDir, `${item.caseId}.${extension}`));
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      for (const engine of engines) {
        const row = await page.evaluate(async ({ url, expected, engine }) => {
          const started = performance.now();
          let scanner, timer;
          try {
            const work = async () => {
              const img = new Image(); img.src = url; await img.decode();
              if (engine === 'baseline') {
                const { decodeQr } = await import('/baseline.mjs');
                const value = await decodeQr(img);
                return { value, terminationReason: value === null ? 'not-found' : 'decoded' };
              }
              ({ scanner } = await import('/current.mjs'));
              // Same image mode, 3000 ms decode budget and first candidate as
              // qrDecoder.ts, retaining the client's non-success status.
              const result = await scanner.scan(await createImageBitmap(img), { mode: 'image', budgetMs: 3000 });
              return { value: result.status === 'decoded' ? result.candidates[0]?.text ?? null : null, terminationReason: result.status };
            };
            const result = await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Benchmark deadline')), 20000); })]);
            const normal = result.terminationReason === 'decoded' || result.terminationReason === 'not-found';
            return { success: normal && result.value === expected, wrongPayload: result.value !== null && result.value !== expected, elapsedMs: Math.round((performance.now() - started) * 100) / 100, attempts: 1, terminationReason: result.terminationReason };
          } catch { scanner?.dispose(); return { success: false, wrongPayload: false, elapsedMs: Math.round((performance.now() - started) * 100) / 100, attempts: 1, terminationReason: 'engine-error' }; }
          finally { clearTimeout(timer); }
        }, { url: `${baseUrl}/fixtures/${item.caseId}.${extension}`, expected: item.payload, engine });
        if (!['decoded', 'not-found'].includes(row.terminationReason)) failed = true;
        write({ caseId: item.caseId, sourceGroup: item.sourceGroup, sha256, engine, ...row });
      }
    }
    if (engines.includes('fixed')) await page.evaluate(async () => { const { scanner } = await import('/current.mjs'); scanner.dispose(); });
    return { failed };
  } catch (error) {
    throw Object.assign(new Error(error.message, { cause: error }), { stage });
  } finally {
    // Settle every disposer even if another rejects. Scratch owns all build and
    // fixture output; production assets and shared temp paths are never deleted.
    const cleaned = await Promise.allSettled([
      Promise.resolve().then(() => browser?.close()),
      server ? new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) : undefined,
      scratch ? fs.rm(scratch, { recursive: true, force: true }) : undefined,
    ]);
    const failure = cleaned.find((result) => result.status === 'rejected');
    if (failure) throw Object.assign(new Error('Benchmark cleanup failed', { cause: failure.reason }), { stage: 'cleanup' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { if ((await runBenchmark(process.argv.slice(2))).failed) process.exitCode = 1; }
  catch (error) {
    console.error(JSON.stringify({ type: 'benchmark-error', stage: error.stage, message: error.message.slice(0, 500) }));
    process.exitCode = 1;
  }
}
