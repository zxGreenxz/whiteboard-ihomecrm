import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Request } from '@playwright/test';
import { login } from './auth';
import { chanChayTrenProduction, xacMinhBanBuild } from './buildAttestation';
import { COPILOT_TEST_MODEL, pinCopilotTestModel, waitForCopilotAvailability } from './copilotTestModel';
import { guiVaChoModel } from './copilotModelCycle';
import { inspectModelStream } from './copilotSmokeOracle';
import { createG1Guard, initializeG1Browser, safeG1RequestFailure, type G1Request } from '../../scripts/lib/copilot-g1-guard.mjs';
import { DEMO, G1_ROUTES, MOBILE_MARKERS, admissionDigest, admissionFromBaseline, createReceipt, validateReceipt,
  addProof, pendingCases, navigationEvidence, knowledgeEvidence, safeG1Failure, type G1Receipt } from '../../scripts/lib/copilot-g1-acceptance.mjs';

const SOURCE_KEY = 'huong-dan-su-dung/03-quan-ly-van-hanh/hoa-don';
const requireThat = (ok: unknown, code: string): void => { if (!ok) throw new Error(code); };
function absoluteEnv(name: string): string {
  const path = process.env[name]; requireThat(path && isAbsolute(path), `g1_absolute_${name}_required`); return path!;
}
function save(path: string, receipt: G1Receipt): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
async function shape(request: Request): Promise<G1Request> {
  let body: unknown; try { body = request.postDataJSON(); } catch { /* GET / invalid payload */ }
  return { url: request.url(), method: request.method(), body, headers: await request.allHeaders() };
}
async function panel(page: Page): Promise<void> {
  if (!await page.getByTestId('copilot-panel').isVisible()) await page.getByTestId('copilot-launcher').click();
  await expect(page.getByTestId('copilot-model-select')).toHaveValue(COPILOT_TEST_MODEL);
  await expect(page.getByTestId('copilot-dang-tai-lich-su')).toHaveCount(0);
}
async function renderedRoute(page: Page, target: typeof G1_ROUTES[number]): Promise<void> {
  await expect(page).toHaveURL(url => url.pathname === target.route);
  // Three real pages have no h1. These witnesses belong to their page component,
  // not the sidebar (which remains visible even when a route fails to mount).
  if (target.key === 'services.list') await expect(page.getByRole('columnheader', { name: 'Tên dịch vụ', exact: true })).toBeVisible();
  else if (target.key === 'thu-tien.list') await expect(page.locator('.tt-stage .tt-page')).toBeVisible();
  else if (target.key === 'chat-zalo.list') await expect(page.getByRole('heading', { name: 'Hội thoại', exact: true })).toBeVisible();
  else await expect(page.getByRole('heading', { name: target.heading, exact: true }).first()).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 20_000 });
}

// Run explicitly with one worker. No flag mutation, business fixture, or room-pass
// acceptance is performed here. Every attempt uses a fresh owned chat thread.
test('G1 DEMO canary: canonical navigation, mobile controls, authorized knowledge and memory panel', async ({ page }) => {
  test.setTimeout(12 * 60_000);
  chanChayTrenProduction();
  requireThat(process.env.FLEET_G1_LIVE === '1' && !process.env.FLEET_HEADED, 'g1_explicit_headless_opt_in_required');
  const config = JSON.parse(readFileSync(absoluteEnv('FLEET_G1_CONFIG'), 'utf8')) as {
    sourceSha: string; actorId: string; organizationId: string; baseUrl: string; supabaseOrigin: string;
  };
  requireThat(config.organizationId === DEMO && config.sourceSha === process.env.EXPECTED_SOURCE_SHA
    && config.baseUrl === process.env.FLEET_BASE_URL, 'g1_config_identity_mismatch');
  const baselinePath = absoluteEnv('FLEET_G1_FLAGS'), receiptPath = absoluteEnv('FLEET_G1_RECEIPT');
  const rawBaseline = readFileSync(baselinePath, 'utf8');
  let receipt: G1Receipt | undefined = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : undefined;
  if (receipt) validateReceipt(receipt, receipt.admission);
  const guard = createG1Guard(config);
  // A crash leaves the lock for explicit operator reconciliation. Never infer
  // that an unknown concurrent attempt stopped merely because time passed.
  const lock = `${receiptPath}.lock`, fd = openSync(lock, 'wx', 0o600);
  const networkFailures = new Set<string>();
  let pageErrors = 0;
  const observers = new Set<Promise<void>>();
  let checkNetwork = false;
  let attempt: Record<string, unknown> | undefined;
  let stage = 'bootstrap';
  let pin: Awaited<ReturnType<typeof pinCopilotTestModel>> | undefined;
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, sourceSha: config.sourceSha }));
    pin = await pinCopilotTestModel(page);
    page.on('pageerror', () => { pageErrors += 1; });
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).pathname === '/rest/v1/ai_chat_messages' && route.request().method() === 'POST') await Promise.all([...observers]);
      if (guard.allow(await shape(route.request()), route.request())) await route.fallback(); else await route.abort();
    });
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (checkNetwork && path.startsWith('/rest/v1/') && !response.ok()) networkFailures.add(`${response.status()} ${response.request().method()} ${path}`);
      if (path !== '/rest/v1/ai_chat_threads' || response.request().method() !== 'POST') return;
      const observing = (async () => { guard.observeThread(await shape(response.request()), await response.json(), response.status()); })()
        .catch(() => { networkFailures.add('POST /rest/v1/ai_chat_threads identity_readback_failed'); });
      observers.add(observing); void observing.then(() => observers.delete(observing));
    });
    page.on('requestfinished', request => guard.finished(request));
    page.on('requestfailed', request => {
      guard.finished(request);
      if (checkNetwork && new URL(request.url()).pathname.startsWith('/rest/v1/'))
        networkFailures.add(safeG1RequestFailure({ method: request.method(), url: request.url() }, request.failure()?.errorText));
    });
    const settleRequests = async () => {
      await page.waitForLoadState('networkidle', { timeout: 20_000 });
      // A completed model cycle can precede async owned chat persistence.
      // HTTP response headers and thread identity readback do not prove the
      // full write request finished. Never waive this wait or ignore aborts.
      await expect.poll(() => guard.counters().pendingChatWrites, { timeout: 20_000 }).toBe(0);
      await Promise.all([...observers]);
    };
    await page.addInitScript(initializeG1Browser, config);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const available = await waitForCopilotAvailability(page, DEMO, async () => {
      await login(page, 'sysadmin'); await page.reload(); await xacMinhBanBuild(page); await panel(page);
    }, { timeoutMs: 60_000 });
    requireThat(new URL(available.url()).origin === config.supabaseOrigin, 'g1_backend_origin_mismatch');
    const observedHeaders = await available.request().allHeaders();
    // Credentials remain in memory, only for same-origin guarded fetches. They
    // never enter the config, receipt, assertions, logs, or test attachments.
    const headers = { Authorization: observedHeaders.authorization, apikey: observedHeaders.apikey,
      'Content-Type': 'application/json', 'Accept-Profile': 'public', 'Content-Profile': 'public' };
    const read = async (path: string, body?: unknown): Promise<unknown> => page.evaluate(async ({ origin, path, headers, body }) => {
      const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error(`g1_read_http_${response.status}`);
      return response.json();
    }, { origin: config.supabaseOrigin, path, headers, body });
    const refreshAdmission = async () => {
      const [availability, user, isSuperAdmin, authorization] = await Promise.all([
        read('/rest/v1/rpc/get_my_copilot_availability_v1', { p_organization_id: DEMO }), read('/auth/v1/user'),
        read('/rest/v1/rpc/is_super_admin', {}), read('/rest/v1/rpc/get_authorization_context_v1', { p_organization_id: DEMO }),
      ]);
      return admissionFromBaseline({ ...config, buildSha: await xacMinhBanBuild(page), model: COPILOT_TEST_MODEL }, rawBaseline, availability, user, isSuperAdmin, authorization);
    };
    const admission = await refreshAdmission();
    if (receipt) validateReceipt(receipt, admission); else receipt = createReceipt(admission);
    attempt = { startedAt: new Date().toISOString(), flagEvidenceDigest: admission.flagEvidenceDigest,
      availabilityDigest: admission.availabilityDigest, availabilityRevision: admission.availabilityRevision, status: 'running' };
    receipt.attempts.push(attempt); save(receiptPath, receipt); await settleRequests(); checkNetwork = true;
    const record = async (proof: Record<string, unknown>) => {
      const current = await refreshAdmission(); validateReceipt(receipt!, current);
      await Promise.all([...observers]);
      requireThat(guard.counters().blockedWrites === 0 && networkFailures.size === 0 && pageErrors === 0, 'g1_unexpected_request_or_network_failure');
      addProof(receipt!, { ...proof, observedAt: new Date().toISOString(), admissionDigest: admissionDigest(current),
        buildSha: current.buildSha, blockedWrites: 0 });
      save(receiptPath, receipt!);
    };
    const navigate = G1_ROUTES.filter(r => pendingCases(receipt!).includes(`route:${r.key}`));
    if (navigate.length || pendingCases(receipt).includes('knowledge')) {
      await page.getByTitle('Cuộc trò chuyện mới', { exact: true }).click();
    }
    for (let start = 0; start < navigate.length; start += 5) {
      stage = `navigation_batch_${start / 5 + 1}`; attempt.stage = stage; save(receiptPath, receipt);
      await panel(page);
      const targets = navigate.slice(start, start + 5);
      const prompt = `Chỉ dùng mo_trang một lần cho từng khoá sau: ${targets.map(r => r.key).join(', ')}. Trả đủ link của từng công cụ để tôi tự bấm. Không tra dữ liệu, không thực hiện thao tác ghi.`;
      const rounds = await guiVaChoModel(page, prompt, { organizationId: DEMO });
      const streams = rounds.map(r => inspectModelStream(r.body));
      for (const target of targets) {
        stage = `route:${target.key}`; attempt.stage = stage; save(receiptPath, receipt);
        const toolProof = navigationEvidence(streams, rounds, target);
        await panel(page);
        const link = page.getByTestId('copilot-panel').locator(`a[href="${target.route}"]`).last();
        await expect(link).toBeVisible(); await settleRequests(); await link.click();
        if (await page.getByTestId('copilot-panel').isVisible()) await page.getByTestId('copilot-close').click();
        await renderedRoute(page, target);
        await record({ caseId: `route:${target.key}`, ...toolProof, clickedHref: target.route, route: target.route, rendered: true, heading: target.heading });
      }
    }
    if (pendingCases(receipt).includes('knowledge')) {
      stage = 'knowledge'; attempt.stage = stage; save(receiptPath, receipt);
      await panel(page);
      const rounds = await guiVaChoModel(page, `Dùng huong_dan với tai_lieu="${SOURCE_KEY}": cách xem và lọc hoá đơn trên màn hình? Chỉ giải thích và giữ nguyên nguồn.`, { organizationId: DEMO });
      const streams = rounds.map(r => inspectModelStream(r.body));
      const assistant = page.getByTestId('copilot-panel').locator('.flex.justify-start.gap-2 > .bg-muted').last();
      await expect(assistant).toBeVisible();
      await record({ caseId: 'knowledge', ...knowledgeEvidence(streams, rounds, SOURCE_KEY, await assistant.innerText()) });
    }
    if (pendingCases(receipt).includes('memory')) {
      stage = 'memory'; attempt.stage = stage; save(receiptPath, receipt);
      await panel(page);
      const memory = await read('/rest/v1/rpc/copilot_memory_list_v1', { p_organization_id: DEMO }) as { items: unknown[] };
      requireThat(Array.isArray(memory.items), 'g1_memory_response_invalid');
      await page.getByTestId('copilot-ghi-nho-toggle').click();
      await expect(page.getByTestId('copilot-ghi-nho')).toBeVisible();
      await expect(page.getByTestId('copilot-ghi-nho-bo')).toHaveCount(memory.items.length);
      await record({ caseId: 'memory', scope: 'read-only-panel', rpcOrganizationId: DEMO, rpcActorId: config.actorId,
        listReadOk: true, panelVisible: true, itemCount: memory.items.length, deleteControlCount: memory.items.length });
    }
    for (const [key, marker] of Object.entries(MOBILE_MARKERS)) {
      if (!pendingCases(receipt).includes(`mobile:${key}`)) continue;
      stage = `mobile:${key}`; attempt.stage = stage; save(receiptPath, receipt);
      // Navigation has its independent real-tool proofs above. These direct
      // visits only measure the mobile component, never navigation success.
      await page.setViewportSize({ width: 375, height: 812 });
      await settleRequests();
      await page.goto(G1_ROUTES.find(r => r.key === key)!.route);
      await xacMinhBanBuild(page);
      if (await page.getByTestId('copilot-panel').isVisible()) await page.getByTestId('copilot-close').click();
      const control = page.locator(`[data-ai-safe="${marker}"]`);
      await expect(control).toHaveCount(1); await expect(control).toBeVisible(); await expect(control).toBeEditable();
      const previous = await control.inputValue();
      await control.fill('g1-fixture-no-match'); await expect(control).toHaveValue('g1-fixture-no-match'); await control.fill(previous);
      await expect(control).toHaveValue(previous); await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('copilot-launcher')).toBeVisible();
      const geometry = await control.evaluate(element => {
        const r = element.getBoundingClientRect(), fab = document.querySelector('[data-testid="copilot-launcher"]');
        const f = fab?.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const scroller = element.closest('.cm-app')?.querySelector('.mbody');
        return { hitTest: Boolean(hit && (hit === element || element.contains(hit))),
          fabOverlap: !f || !(r.right <= f.left || r.left >= f.right || r.bottom <= f.top || r.top >= f.bottom),
          inset: parseFloat(getComputedStyle(element).getPropertyValue('--copilot-fab-inset')),
          paddingBottom: scroller ? parseFloat(getComputedStyle(scroller).paddingBottom) : 0 };
      });
      await record({ caseId: `mobile:${key}`, marker, width: 375, height: 812, visibleCount: 1, editable: true, filledAndCleared: true, ...geometry });
    }
    await settleRequests();
    requireThat(guard.counters().blockedWrites === 0 && networkFailures.size === 0 && pendingCases(receipt).length === 0, 'g1_acceptance_incomplete');
    stage = 'teardown'; await pin.dispose(); pin = undefined;
    await settleRequests();
    await page.close(); await Promise.all([...observers]);
    requireThat(guard.counters().blockedWrites === 0 && networkFailures.size === 0 && pageErrors === 0, 'g1_teardown_failure');
    attempt.status = 'complete'; receipt.status = 'complete';
  } catch (error) {
    const code = safeG1Failure(error);
    if (attempt) { attempt.status = 'failed'; attempt.failureCode = code; }
    if (receipt) receipt.status = 'partial';
    // Detailed safe paths are in the receipt. Never serialize provider prose,
    // Supabase errors, auth headers, profile data or model request payloads.
    throw new Error(`G1 attempt failed at ${stage}: ${code}; inspect the sanitized receipt and pending case IDs.`);
  } finally {
    checkNetwork = false;
    if (receipt && attempt) {
      Object.assign(attempt, { finishedAt: new Date().toISOString(), ...guard.counters(), networkFailures: [...networkFailures], pageErrors });
      save(receiptPath, receipt);
    }
    try { await pin?.dispose(); } finally { closeSync(fd); unlinkSync(lock); }
  }
});
