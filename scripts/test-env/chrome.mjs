// Chrome lane riêng cho TEST. Caller giữ khoá DB xuyên suốt build + UI + cleanup.
// Không dùng storageState/trace/HAR/video: chúng có thể ghi JWT và mật khẩu ra đĩa.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { batBuocDichTest, lit, PROD_REF, psqlJson, repoRoot } from './lib.mjs';
import { matKhauTest } from './hau-ky.mjs';
import { trangLazy, chunkTrongDist, fileEntryTuHtml, bytesEntry, trangMatChunk } from '../generate-bundle-inventory.mjs';
import { createNavigationReadGuard } from '../lib/commission-e2e-network.mjs';
import { assertTestLease, markTestCleanupRequired, withTestCleanup } from './lock.mjs';

const exec = promisify(execFile);
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const OWNER = 'nguyentam@username.ihomecrm.local';
const CUSTODIAN = 'nguyentamca165@gmail.com';
const CHECKS = ['bundle', 'buildSha', 'loginOwner', 'testBanner', 'buildings', 'search', 'incomeExpense',
  'createUi', 'autoApprovedPosted', 'cancelUi', 'reversed', 'balanceRestored'];
const DIAGNOSTICS = ['consoleErrors', 'pageErrors', 'blockedRequests', 'httpErrors', 'requestFailures'];
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const navigationGuards = new WeakMap();

export function validateChromeTarget(cred, buildSha) {
  if (!/^[a-z0-9]{20}$/.test(cred.testRef ?? '') || cred.testRef === PROD_REF) {
    throw new Error('Chrome yêu cầu ref TEST hợp lệ, khác production.');
  }
  const key = cred.testPublishableKey;
  let publicKey = typeof key === 'string' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!publicKey && typeof key === 'string') {
    try {
      const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
      publicKey = claims.role === 'anon' && claims.ref === cred.testRef;
    } catch { /* key không hợp lệ */ }
  }
  if (!publicKey) throw new Error('Chrome cần TEST publishable/public anon key; cấm secret/service key.');
  if (!/^[a-f0-9]{40}$/.test(buildSha ?? '')) throw new Error('Chrome cần SHA commit đủ 40 ký tự.');
  return `https://${cred.testRef}.supabase.co`;
}

export function networkAllowed(raw, { localOrigin, testOrigin }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(localOrigin)) throw new Error('Chỉ serve Chrome trên loopback 127.0.0.1.');
  const target = new URL(testOrigin);
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(testOrigin) || target.hostname.startsWith(PROD_REF)) {
    throw new Error('Đích mạng Chrome không phải TEST.');
  }
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.origin === localOrigin || url.origin === testOrigin) return true;
  if (url.protocol === 'wss:' && url.host === target.host) return true;
  // Phông chữ là dependency tĩnh của index.html, không phải dịch vụ production CRM.
  return url.protocol === 'https:' && !url.port && FONT_HOSTS.has(url.hostname);
}

export function chromeBuildEnv(cred, buildSha, source = process.env) {
  const testOrigin = validateChromeTarget(cred, buildSha);
  const osKeys = /^(path|systemroot|windir|comspec|pathext|temp|tmp|userprofile|home|appdata|localappdata|programfiles|programfiles\(x86\)|programdata|lang|lc_all)$/i;
  return {
    ...Object.fromEntries(Object.entries(source).filter(([key]) => osKeys.test(key))),
    NODE_ENV: 'production', VITE_APP_ENV: 'test', VITE_SUPABASE_URL: testOrigin,
    VITE_SUPABASE_PUBLISHABLE_KEY: cred.testPublishableKey, VITE_BUILD_SHA: buildSha,
  };
}

export function expectedMissingMedia(raw, status, testOrigin) {
  try {
    const url = new URL(raw);
    return status === 404 && url.origin === testOrigin && /^\/storage\/v1\/(?:object|render\/image)\//.test(url.pathname);
  } catch { return false; }
}

export function expectedReadCancellation({ url: raw, method, reason, boundary, responseStatus }, testOrigin) {
  if (!boundary || reason !== 'net::ERR_ABORTED' || responseStatus >= 400) return false;
  try {
    const url = new URL(raw);
    if (url.origin !== testOrigin || url.username || url.password) return false;
    if (['GET', 'HEAD'].includes(method)) return /^\/rest\/v1\/[^/]+$/.test(url.pathname);
    // SELECT-only sidebar roster, source: 20260725001000_business_performance_rpc_authz.sql.
    return method === 'POST' && url.pathname === '/rest/v1/rpc/business_performance_organizations_v1';
  } catch { return false; }
}

/** Giữ browser tới khi writer đã gửi có kết quả; mất mạng/timeout là outcome chưa rõ. */
export function createChromeMutationDrain(testOrigin) {
  const pending = new Set(), ambiguous = new Set(), waiters = new Set();
  const receipt = () => ({ safe: pending.size === 0 && ambiguous.size === 0,
    pendingCount: pending.size, ambiguousCount: ambiguous.size });
  return {
    started(id, { url: raw, method }) {
      const url = new URL(raw);
      if (url.origin === testOrigin && method === 'POST'
        && /^\/rest\/v1\/rpc\/(?:create_income_expense_v1|ie_compat_insert_v2|cancel_income_voucher_v1)$/.test(url.pathname)) pending.add(id);
    },
    finished(id, failed = false, status) {
      if (!pending.delete(id)) return;
      // Gateway 502/504 có thể trả về trước khi transaction ở origin commit.
      if (failed || status >= 500) ambiguous.add(id);
      if (pending.size === 0) for (const done of waiters) done();
    },
    async drain(timeoutMs = 45_000) {
      if (pending.size > 0) await new Promise((resolveWait) => {
        const done = () => { clearTimeout(timer); waiters.delete(done); resolveWait(); };
        const timer = setTimeout(done, timeoutMs);
        waiters.add(done);
      });
      return receipt();
    },
  };
}

function navigationBoundary(context, action) { navigationGuards.get(context)?.snapshot(action); }
async function navigateChrome(page, url) {
  navigationBoundary(page.context(), `navigate:${url.split('?')[0]}`);
  await page.goto(url);
}
async function closeChromeContext(context) {
  navigationBoundary(context, 'close-context');
  await context.close();
}

export function sanitizeChromeEvidence(value, secrets = []) {
  if (Array.isArray(value)) return value.map((item) => sanitizeChromeEvidence(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeChromeEvidence(item, secrets)]));
  if (typeof value !== 'string') return value;
  let safe = value;
  for (const secret of secrets.filter((secret) => typeof secret === 'string' && secret.length >= 4).sort((a, b) => b.length - a.length)) {
    safe = safe.replaceAll(secret, '[REDACTED]');
  }
  return safe.replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT]')
    .replace(/sb(?:p_|_secret_|_publishable_)[A-Za-z0-9_-]+/g, '[KEY]')
    .replace(/([?&](?:token|apikey|access_token|refresh_token|key|password)=)[^&#\s"']+/gi, '$1[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
}

export function chromePassed(result) {
  return CHECKS.every((key) => result.checks?.[key] === true)
    && DIAGNOSTICS.every((key) => Array.isArray(result.diagnostics?.[key]) && result.diagnostics[key].length === 0)
    && Array.isArray(result.errors) && result.errors.length === 0
    && result.cleanup?.status === 'cancelled-audit-retained' && result.cleanup.balanceRestored === true;
}

/** Cùng phép đo và biên 5% với gate:bundle; không cập nhật baseline. */
export function assessChromeBundle({ lazySource, html, files, baseline }) {
  const sizes = new Map(files.map(({ file, bytes }) => [file, bytes]));
  const chunks = chunkTrongDist(files.map(({ file }) => file), (file) => sizes.get(file));
  const pages = trangLazy(lazySource);
  const entries = fileEntryTuHtml(html);
  const missingEntries = entries.filter((file) => !chunks.some((chunk) => chunk.file === file));
  const missingLazyChunks = trangMatChunk(pages, chunks);
  const entryBytes = bytesEntry(chunks, entries);
  const threshold = baseline?.nguongEntryBytes;
  const validThreshold = Number.isFinite(threshold) && threshold > 0;
  const errors = [];
  if (chunks.length < 100) errors.push('Không đo được: cần ít nhất 100 chunk JS.');
  if (pages.length < 50) errors.push('Không đo được: cần ít nhất 50 trang lazy.');
  if (!entries.length || missingEntries.length) errors.push('Không đo được: entry HTML thiếu hoặc trỏ tới chunk không tồn tại.');
  if (chunks.some((chunk) => !Number.isFinite(chunk.bytes) || chunk.bytes <= 0)) errors.push('Không đo được kích thước chunk.');
  if (!validThreshold) errors.push('Baseline entry không hợp lệ.');
  if (missingLazyChunks.length) errors.push('Có trang lazy mất chunk riêng.');
  if (validThreshold && entryBytes > threshold * 1.05) errors.push('Entry vượt ngưỡng baseline +5%.');
  return { passed: errors.length === 0, soChunk: chunks.length, soTrangLazy: pages.length,
    bytesEntry: entryBytes, bytesTong: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
    entryLimitBytes: validThreshold ? threshold * 1.05 : null, entryFiles: entries, missingEntries, missingLazyChunks, errors };
}

async function inspectChromeBundle(outDir, html) {
  const assetDir = join(outDir, 'assets');
  const [assetNames, lazySource, baselineSource] = await Promise.all([
    readdir(assetDir), readFile(join(repoRoot, 'src/app/lazyPages.ts'), 'utf8'),
    readFile(join(repoRoot, 'tooling/bundle-baseline.json'), 'utf8'),
  ]);
  const files = await Promise.all(assetNames.filter((file) => file.endsWith('.js')).map(async (file) => ({ file, bytes: (await stat(join(assetDir, file))).size })));
  return assessChromeBundle({ lazySource, html, files, baseline: JSON.parse(baselineSource) });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };

export async function serveChromeBuild(directory, testOrigin) {
  const root = await realpath(directory);
  const csp = `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ${testOrigin} ${testOrigin.replace('https:', 'wss:')}; img-src 'self' data: blob: ${testOrigin}; media-src 'self' blob: ${testOrigin}; worker-src 'self' blob:; frame-src 'none'; base-uri 'self'; form-action 'self'`;
  const server = createServer(async (request, response) => {
    const host = `127.0.0.1:${server.address().port}`;
    if (request.headers.host !== host) { response.writeHead(403).end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    try {
      const path = decodeURIComponent(new URL(request.url, `http://${host}`).pathname);
      if (path.includes('\\') || path.split('/').some((part) => part.startsWith('.'))) { response.writeHead(404).end(); return; }
      let file = resolve(root, `.${path}`);
      const rel = relative(root, file);
      if (rel.startsWith('..') || isAbsolute(rel)) { response.writeHead(404).end(); return; }
      try { if (!(await stat(file)).isFile()) file = join(root, 'index.html'); }
      catch {
        if (extname(path)) { response.writeHead(404).end(); return; }
        file = join(root, 'index.html');
      }
      const realRel = relative(root, await realpath(file));
      if (realRel.startsWith('..') || isAbsolute(realRel)) { response.writeHead(404).end(); return; }
      const bytes = await readFile(file);
      response.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store', 'Content-Security-Policy': csp, 'X-DNS-Prefetch-Control': 'off' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(500).end(); }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  return { origin: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); await new Promise((ok, fail) => server.close((error) => error ? fail(error) : ok())); } };
}

function resourceIdentity(raw) {
  try {
    const url = new URL(raw);
    // Paths to files can contain a customer's name; a digest is sufficient to correlate errors.
    const path = url.pathname.startsWith('/storage/') ? '/storage/[path-sha256:' + createHash('sha256').update(url.pathname).digest('hex').slice(0, 12) + ']' : url.pathname;
    return `${url.origin}${path}`;
  } catch { return '[invalid-url]'; }
}

async function guardedContext(browser, origin, testOrigin, diagnostics, { signal, mutations }) {
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const reads = createNavigationReadGuard({ appOrigin: origin, testOrigin });
  navigationGuards.set(context, reads);
  const policy = { localOrigin: origin, testOrigin };
  await context.route('**/*', async (route) => {
    const req = route.request();
    if (signal.aborted) { await route.abort('aborted'); return; }
    const allowed = networkAllowed(req.url(), policy)
      && (!FONT_HOSTS.has(new URL(req.url()).hostname) || ['GET', 'HEAD'].includes(req.method()));
    if (!allowed) {
      diagnostics.blockedRequests.push({ method: req.method(), resource: resourceIdentity(req.url()) });
      await route.abort('blockedbyclient');
      return;
    }
    mutations.started(req, { url: req.url(), method: req.method() });
    await route.continue();
  });
  if (typeof context.routeWebSocket !== 'function') throw new Error('Playwright thiếu routeWebSocket: không thể bảo vệ toàn bộ mạng Chrome.');
  await context.routeWebSocket('**/*', (socket) => {
    if (signal.aborted) { socket.close(); return; }
    if (networkAllowed(socket.url(), policy)) socket.connectToServer();
    else { diagnostics.blockedRequests.push({ method: 'WEBSOCKET', resource: resourceIdentity(socket.url()) }); socket.close(); }
  });
  context.on('page', (page) => {
    const statuses = new WeakMap();
    page.on('request', (request) => reads.started(request));
    page.on('requestfinished', (request) => { reads.finished(request); mutations.finished(request, false, statuses.get(request)); });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const url = message.location().url;
      const text = message.text();
      if (expectedMissingMedia(url, 404, testOrigin) && /Failed to load resource.*404/.test(text)) return;
      diagnostics.consoleErrors.push({ text, resource: resourceIdentity(url) });
    });
    page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
    page.on('response', (response) => {
      statuses.set(response.request(), response.status());
      if (response.status() < 400) return;
      const target = { status: response.status(), resource: resourceIdentity(response.url()) };
      if (expectedMissingMedia(response.url(), response.status(), testOrigin)) diagnostics.expectedMedia404.push(target);
      else diagnostics.httpErrors.push(target);
    });
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? 'request failed';
      mutations.finished(request, true);
      const readCancellation = reads.cancelled(request, reason, statuses.get(request));
      reads.finished(request);
      const failure = { resource: resourceIdentity(request.url()), method: request.method(), reason };
      if (expectedReadCancellation({ url: request.url(), method: request.method(), reason,
        boundary: readCancellation?.boundary, responseStatus: statuses.get(request) }, testOrigin)) {
        diagnostics.expectedReadCancellations.push({ ...failure, boundary: readCancellation.boundary });
        return;
      }
      if (reason === 'net::ERR_ABORTED' && request.isNavigationRequest()) return;
      diagnostics.requestFailures.push(failure);
    });
    page.setDefaultTimeout(45_000);
    page.setDefaultNavigationTimeout(45_000);
  });
  return context;
}

async function loginUi(page, email, password, testOrigin, expect) {
  // Đi thẳng tới hồ sơ bằng redirect hợp lệ của app: không mở Dashboard/onboarding
  // rồi huỷ các request còn chạy ngay sau khi đăng nhập.
  await navigateChrome(page, '/login?next=/account/profile');
  await expect(page.getByRole('status', { name: 'Môi trường TEST' })).toBeVisible();
  await page.getByLabel('Tài Khoản', { exact: true }).fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url().startsWith(`${testOrigin}/auth/v1/token?`) && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(),
  ]);
  assert.equal(response.status(), 200, 'Đăng nhập TEST phải trả 200');
  const session = await response.json();
  assert.equal(session.user?.email?.toLowerCase(), email.toLowerCase(), 'JWT đăng nhập phải thuộc đúng tài khoản TEST');
  assert.ok(session.access_token && session.user?.id, 'Đăng nhập phải trả phiên JWT thật');
  await page.waitForURL((url) => url.pathname === '/account/profile');
  return { authorization: `Bearer ${session.access_token}`, userId: session.user.id };
}

async function chooseOrganization(page, name, expect) {
  if (new URL(page.url()).pathname !== '/account/profile') await navigateChrome(page, '/account/profile');
  const select = page.getByRole('combobox', { name: 'Công ty đang chọn', exact: true });
  await expect(select).toBeEnabled();
  await select.click();
  navigationBoundary(page.context(), 'select-organization');
  await page.getByRole('option', { name, exact: true }).click();
  await expect(select).toHaveText(name);
}

export async function testApi(testOrigin, cred, session, path, body, { fetchImpl = fetch } = {}) {
  assert.ok(/^\/(?:rest\/v1\/|auth\/v1\/user$)/.test(path) && !path.includes('://'), 'Chỉ gọi API TEST định danh');
  const response = await fetchImpl(`${testOrigin}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { apikey: cred.testPublishableKey, Authorization: session.authorization, 'Content-Type': 'application/json',
      'Accept-Profile': 'public', 'Content-Profile': 'public' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`API TEST ${path.split('?')[0]} HTTP ${response.status}`);
  return response.json();
}

function fixtureRows(test, name) {
  return psqlJson(test, `select id, organization_id, account_id, approval_status, posting_status from public.income_expenses where organization_id=${lit(ORG)}::uuid and name=${lit(name)}`);
}

function accountBalance(test, accountId) {
  const rows = psqlJson(test, `select current_amount::text as amount from public.accounts_with_balance_v2 where organization_id=${lit(ORG)}::uuid and id=${lit(accountId)}::uuid`);
  assert.equal(rows.length, 1, 'Sổ quỹ TEST phải có đúng một dòng số dư');
  assert.match(rows[0].amount ?? '', /^-?\d+(?:\.\d+)?$/, 'Số dư không được rỗng');
  return rows[0].amount;
}

/**
 * Tự build chính source worktree, pin commit + digest bundle, rồi chạy Chrome cài sẵn.
 * Trả failed receipt thay vì vứt evidence khi UI hỏng. Caller PHẢI kiểm status.
 */
export async function runChrome({ cred, test, reportDir, buildSha, headed = false, lease }) {
  const started = Date.now();
  const result = { status: 'failed', requestedSha: buildSha, servedSha: null, assertionCount: 0, checks: {},
    browser: { channel: 'chrome', headless: !headed }, diagnostics: Object.fromEntries([...DIAGNOSTICS, 'expectedMedia404', 'expectedReadCancellations'].map((key) => [key, []])),
    cleanup: { status: 'not-created', balanceRestored: false, retainedFixtureIds: [] }, errors: [] };
  const secrets = Object.values(cred ?? {}).filter((value) => typeof value === 'string');
  const name = `TEST_ENV_CHROME_${randomUUID()}`;
  let temporary, server, browser, custodian, account, beforeBalance;
  let targetVerified = false;
  let testOrigin, mutations, stopping;
  let cleanupRequired = false;
  const closeBrowser = async () => {
    if (browser) for (const context of browser.contexts()) navigationBoundary(context, 'close-browser');
    await browser?.close();
  };
  const stopChrome = () => {
    if (stopping) return;
    result.interrupted = true;
    result.errors.push('Chrome dừng vì lease TEST bị ngắt hoặc mất.');
    stopping = (async () => {
      result.inflightMutation = await mutations.drain();
      await closeBrowser();
    })().catch((error) => { result.errors.push(`Dừng Chrome: ${error.message}`); });
  };
  const check = (key) => { result.checks[key] = true; result.assertionCount = Object.keys(result.checks).length; };
  try {
    testOrigin = validateChromeTarget(cred, buildSha);
    assert.ok(cred.passwordSeed, 'Chrome cần seed mật khẩu TEST');
    await assertTestLease(lease, test);
    mutations = createChromeMutationDrain(testOrigin);
    lease.signal.addEventListener('abort', stopChrome, { once: true });
    lease.signal.throwIfAborted();
    await batBuocDichTest(cred, test);
    targetVerified = true;
    const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, windowsHide: true });
    assert.equal(head.trim(), buildSha, 'SHA yêu cầu phải là HEAD của worktree đang build');
    const { stdout: changes } = await exec('git', ['status', '--porcelain'], { cwd: repoRoot, windowsHide: true });
    result.worktreeDirty = !!changes.trim();
    temporary = await mkdtemp(join(tmpdir(), 'ihomecrm-test-chrome-'));
    const outDir = join(temporary, 'build');
    const buildEnv = chromeBuildEnv(cred, buildSha);
    const assetManifests = ['src/lib/qr/assets.json', 'src/lib/ocr/assets.json'];
    const beforeAssets = await Promise.all(assetManifests.map((file) => readFile(join(repoRoot, file), 'utf8')));
    result.prebuild = { scripts: [], sourceManifestsUnchanged: false };
    for (const script of ['scripts/qr/build-wechat-wasm.mjs', 'scripts/ocr/build-assets.mjs']) {
      await exec(process.execPath, [join(repoRoot, script)], {
        cwd: repoRoot, env: buildEnv, windowsHide: true, timeout: 240_000, maxBuffer: 8 * 1024 * 1024, signal: lease.signal,
      });
      result.prebuild.scripts.push(script);
    }
    const afterAssets = await Promise.all(assetManifests.map((file) => readFile(join(repoRoot, file), 'utf8')));
    assert.deepEqual(afterAssets, beforeAssets, 'Prebuild đổi source assets; cần review source mới trước khi chạy Chrome');
    result.prebuild.sourceManifestsUnchanged = true;
    await exec(process.execPath, [join(repoRoot, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'], {
      cwd: repoRoot, env: buildEnv, windowsHide: true, timeout: 240_000, maxBuffer: 8 * 1024 * 1024, signal: lease.signal,
    });
    const index = await readFile(join(outDir, 'index.html'), 'utf8');
    result.bundle = await inspectChromeBundle(outDir, index);
    assert.equal(result.bundle.passed, true, `Bundle TEST: ${result.bundle.errors.join(' ')}`);
    check('bundle');
    assert.ok(index.includes(`name="build-sha" content="${buildSha}"`), 'SHA phải được Vite nhúng thật vào index');
    assert.ok(!/rel=["'](?:preconnect|dns-prefetch)["'][^>]*tryymsxyyckgbrmmvozx/.test(index), 'Build TEST không được preconnect production');
    result.indexSha256 = createHash('sha256').update(index).digest('hex');
    await writeFile(join(outDir, 'build-meta.json'), JSON.stringify({ buildSha, indexSha256: result.indexSha256, environment: 'test' }));
    await assertTestLease(lease, test);
    server = await serveChromeBuild(outDir, testOrigin);
    const { chromium, expect } = await import('@playwright/test');
    browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync'] });
    await assertTestLease(lease, test);
    result.browser.version = browser.version();
    const metadataResponse = await fetch(`${server.origin}/build-meta.json`);
    assert.equal(metadataResponse.status, 200);
    result.servedSha = (await metadataResponse.json()).buildSha;
    assert.equal(result.servedSha, buildSha);

    const [organization] = psqlJson(test, `select name from public.organizations where id=${lit(ORG)}::uuid`);
    assert.ok(organization?.name, 'TEST cần công ty bản sao để kiểm Chrome');
    secrets.push(organization.name);
    const ownerContext = await guardedContext(browser, server.origin, testOrigin, result.diagnostics, { signal: lease.signal, mutations });
    const ownerPage = await ownerContext.newPage();
    const ownerPassword = matKhauTest(cred.passwordSeed, OWNER);
    const custodianPassword = matKhauTest(cred.passwordSeed, CUSTODIAN);
    secrets.push(ownerPassword, custodianPassword);
    const owner = await loginUi(ownerPage, OWNER, ownerPassword, testOrigin, expect);
    secrets.push(owner.authorization, owner.authorization.replace(/^Bearer /, ''));
    const ownerIdentity = await testApi(testOrigin, cred, owner, '/auth/v1/user');
    assert.equal(ownerIdentity.id, owner.userId);
    check('loginOwner');
    await chooseOrganization(ownerPage, organization.name, expect);
    await expect(ownerPage.locator('meta[name="build-sha"]')).toHaveAttribute('content', buildSha);
    check('buildSha');
    await expect(ownerPage.getByRole('status', { name: 'Môi trường TEST' })).toBeVisible();
    await expect(ownerPage).toHaveTitle(/^\[TEST\]/);
    check('testBanner');
    await navigateChrome(ownerPage, '/buildings');
    const buildingRow = ownerPage.locator('tbody tr').first();
    await expect(buildingRow).toBeVisible();
    await expect(buildingRow.locator('td').nth(2)).toHaveText(/\S/);
    const buildingName = (await buildingRow.locator('td').nth(2).innerText()).trim();
    assert.ok(buildingName, 'Bảng toà nhà phải có dữ liệu thật');
    secrets.push(buildingName);
    check('buildings');
    const buildingSearch = ownerPage.getByPlaceholder('Tìm kiếm theo tên, mã, địa chỉ...');
    await buildingSearch.fill(name);
    await expect(ownerPage.locator('tbody tr')).toHaveCount(0);
    await buildingSearch.fill(buildingName);
    await expect(ownerPage.locator('tbody tr').first()).toContainText(buildingName);
    check('search');
    await navigateChrome(ownerPage, '/income-expense');
    await expect(ownerPage.getByPlaceholder(/mã phi[ếe]u|mã phòng/i).first()).toBeVisible();
    await expect(ownerPage.locator('tbody tr').first()).toBeVisible();
    await expect(ownerPage.locator('tbody tr').first()).toContainText(/\S/);
    check('incomeExpense');
    await closeChromeContext(ownerContext);

    // Chủ công ty thật không giữ sổ; dùng TEST system custodian để thử ghi thu trên UI.
    await assertTestLease(lease, test);
    const context = await guardedContext(browser, server.origin, testOrigin, result.diagnostics, { signal: lease.signal, mutations });
    const page = await context.newPage();
    custodian = await loginUi(page, CUSTODIAN, custodianPassword, testOrigin, expect);
    secrets.push(custodian.authorization, custodian.authorization.replace(/^Bearer /, ''));
    await chooseOrganization(page, organization.name, expect);
    const access = await testApi(testOrigin, cred, custodian, '/rest/v1/rpc/list_my_cashbook_access_v2', {});
    const accountRows = await testApi(testOrigin, cred, custodian, `/rest/v1/accounts?select=id,name,bank_name,user_id&organization_id=eq.${ORG}&deleted_at=is.null&is_virtual=is.false`);
    account = accountRows.find((row) => row.user_id === custodian.userId && access.some((item) => item.cashbook_id === row.id && item.possession_kind === 'CUSTODIAN'));
    assert.ok(account, 'Không có sổ quỹ legacy + CUSTODIAN hợp lệ; không được báo xanh rỗng');
    secrets.push(account.name);
    beforeBalance = accountBalance(test, account.id);
    assert.equal(fixtureRows(test, name).length, 0, 'Fixture mới phải chưa tồn tại');
    const [item] = psqlJson(test, `select id,name from public.income_expense_types where organization_id=${lit(ORG)}::uuid and type='income' and not system_only and not manual_hidden and not internal_transfer and not is_deposit and not is_restricted and archived_at is null order by name limit 1`);
    assert.ok(item, 'Cần hạng mục thu chọn tay không phải tiền cọc');
    secrets.push(item.name);
    await navigateChrome(page, '/income-expense');
    await page.getByRole('button', { name: 'Thêm phiếu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Thêm phiếu lẻ', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'THÊM PHIẾU THU/CHI', exact: true });
    await expect(form.getByRole('heading', { name: /THÊM PHIẾU THU\/CHI/i })).toBeVisible();
    await form.getByRole('combobox', { name: 'Tòa nhà *', exact: true }).click();
    await page.getByRole('option', { name: buildingName, exact: true }).click();
    await form.getByRole('combobox', { name: 'Sổ quỹ *', exact: true }).click();
    await page.getByRole('option', { name: `${account.name}${account.bank_name ? ` (${account.bank_name})` : ''}`, exact: true }).click();
    await form.getByRole('textbox', { name: /Tên phiếu thu/i }).fill(name);
    await form.getByRole('button', { name: 'Thêm hạng mục', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Chọn hạng mục thu', exact: true });
    await picker.getByRole('checkbox', { name: item.name, exact: true }).check();
    await picker.getByRole('button', { name: 'Xác nhận', exact: true }).click();
    await form.getByPlaceholder('Số tiền', { exact: true }).fill('1000');
    await assertTestLease(lease, test);
    markTestCleanupRequired(lease, test);
    cleanupRequired = true;
    result.cleanup.fixtureLabel = name;
    const [madeResponse] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${testOrigin}/rest/v1/rpc/create_income_expense_v1`),
      form.getByRole('button', { name: 'Lưu', exact: true }).click(),
    ]);
    assert.equal(madeResponse.status(), 200, 'UI tạo phiếu phải thành công');
    const made = await madeResponse.json();
    result.fixtureId = made.id;
    await assertTestLease(lease, test);
    const created = fixtureRows(test, name);
    assert.equal(created.length, 1, 'UI phải tạo đúng một fixture');
    assert.equal(created[0].id, made.id);
    assert.equal(created[0].account_id, account.id);
    check('createUi');
    assert.equal(created[0].approval_status, 'APPROVED');
    assert.equal(created[0].posting_status, 'POSTED');
    assert.equal(Number(accountBalance(test, account.id)) - Number(beforeBalance), 1000, 'Tạo phiếu phải tăng sổ quỹ đúng 1.000đ');
    check('autoApprovedPosted');
    await navigateChrome(page, '/income-expense');
    await page.getByPlaceholder(/mã phi[ếe]u|mã phòng/i).first().fill(name);
    const row = page.locator('tr', { hasText: name });
    await expect(row).toHaveCount(1);
    const cancel = row.locator('button[title="Huỷ phiếu"]');
    await expect(cancel).toBeEnabled();
    await cancel.click();
    const dialog = page.getByRole('alertdialog', { name: 'Xác nhận huỷ phiếu', exact: true });
    await dialog.getByRole('textbox').fill(`TEST cleanup ${name}`);
    await assertTestLease(lease, test);
    const [cancelled] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${testOrigin}/rest/v1/rpc/cancel_income_voucher_v1`),
      dialog.getByRole('button', { name: /^Huỷ phiếu(?: và cập nhật sổ quỹ)?$/ }).click(),
    ]);
    assert.equal(cancelled.status(), 200, 'UI huỷ phải thành công');
    await assertTestLease(lease, test);
    check('cancelUi');
    await expect(dialog).not.toBeVisible();
    const [after] = fixtureRows(test, name);
    assert.equal(after?.approval_status, 'CANCELLED');
    assert.equal(after?.posting_status, 'REVERSED');
    check('reversed');
    assert.equal(accountBalance(test, account.id), beforeBalance, 'Huỷ UI phải trả số dư sổ về ban đầu');
    check('balanceRestored');
    await closeChromeContext(context);
  } catch (error) {
    result.errors.push(error.message);
  } finally {
    if (stopping) await stopping;
    if (mutations) result.inflightMutation = await mutations.drain();
    // Dò bằng tên ngẫu nhiên ngay cả khi response tạo bị mất; không tạo lại/retry writer.
    if (targetVerified && cleanupRequired) {
      try {
        await withTestCleanup(lease, test, async (cleanupLease) => {
          assert.equal(result.inflightMutation?.safe, true, 'Outcome HTTP writer chưa rõ; giữ marker và nhãn fixture để xử lý sau, không quét rồi báo sạch trước commit muộn.');
          await assertTestLease(cleanupLease, test);
          let rows = fixtureRows(test, name);
          result.cleanup.retainedFixtureIds = rows.map((row) => row.id);
          assert.ok(rows.length <= 1, 'Fixture không được trùng');
          if (rows.length) {
            assert.ok(account && beforeBalance !== undefined && custodian, 'Thiếu danh tính/số dư để hoàn tác fixture');
            assert.equal(rows[0].account_id, account.id, 'Chỉ dọn fixture đúng sổ đã ghim');
            if (rows[0].approval_status !== 'CANCELLED' || rows[0].posting_status !== 'REVERSED') {
              await assertTestLease(cleanupLease, test);
              await testApi(testOrigin, cred, custodian, '/rest/v1/rpc/cancel_income_voucher_v1', { p_voucher: rows[0].id, p_reason: `TEST cleanup ${name}` });
            }
            await assertTestLease(cleanupLease, test);
            rows = fixtureRows(test, name);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].approval_status, 'CANCELLED');
            assert.equal(rows[0].posting_status, 'REVERSED');
            assert.equal(accountBalance(test, account.id), beforeBalance, 'Cleanup phải hoàn trả số dư');
            result.cleanup = { status: 'cancelled-audit-retained', balanceRestored: true, retainedFixtureIds: rows.map((row) => row.id),
              fixtureLabel: name, reason: 'Giữ phiếu CANCELLED/REVERSED cùng audit và posting reversal; không xoá lịch sử tiền bằng SQL.' };
          } else {
            assert.equal(accountBalance(test, account.id), beforeBalance, 'Không có fixture nhưng vẫn phải khớp số dư trước');
            result.cleanup = { status: 'not-created', balanceRestored: true, retainedFixtureIds: [], fixtureLabel: name };
          }
        });
      } catch (error) {
        result.cleanup.status = 'failed';
        result.cleanup.fixtureLabel = name;
        result.cleanup.pendingMarkerRetained = true;
        result.errors.push(`Cleanup: ${error.message}`);
      }
    }
    lease?.signal?.removeEventListener('abort', stopChrome);
    for (const [label, close] of [['Chrome', closeBrowser], ['server', () => server?.close()]]) {
      try { await close(); } catch (error) { result.errors.push(`${label}: ${error.message}`); }
    }
    if (temporary) {
      try {
        const path = resolve(temporary);
        assert.ok(path.startsWith(`${resolve(tmpdir())}\\ihomecrm-test-chrome-`) || path.startsWith(`${resolve(tmpdir())}/ihomecrm-test-chrome-`), 'Temp build phải nằm trong thư mục dự kiến');
        await rm(path, { recursive: true, force: true });
      } catch (error) { result.errors.push(`Dọn temp build: ${error.message}`); }
    }
  }
  result.elapsedMs = Date.now() - started;
  result.status = chromePassed(result) ? 'passed' : 'failed';
  result.passed = result.status === 'passed' ? result.assertionCount : 0;
  result.failed = result.status === 'failed' ? 1 : 0;
  result.skipped = 0;
  const sanitized = sanitizeChromeEvidence(result, secrets);
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'chrome.json'), `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
  return sanitized;
}
