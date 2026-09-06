import { expect, test, type Request, type Response } from '@playwright/test';
import { login, trackConsoleErrors } from './auth';
import { chanChayTrenProduction, xacMinhBanBuild } from './buildAttestation';
import { COPILOT_TEST_MODEL, pinCopilotTestModel } from './copilotTestModel';
import { guiVaChoModel } from './copilotModelCycle';
import { assertReadonlyResult, unexpectedReadonlyMutation } from './copilotSmokeOracle';

const ORG_DEMO = 'dddd0000-0000-4000-8000-000000000001';
const PROMPT = 'Dùng phong_trong để tra dữ liệu hiện tại: liệt kê mã của tất cả phòng đang trống ngay trong công ty DEMO, không cần phòng sắp trống. Nếu không có, nói rõ không có phòng trống.';

test.beforeAll(() => { chanChayTrenProduction(); });
test('Copilot readonly smoke completes a real DEMO read and assistant answer without business writes', async ({ page }, testInfo) => {
  const errors = trackConsoleErrors(page);
  await pinCopilotTestModel(page);
  await login(page, 'chunha');
  await xacMinhBanBuild(page);
  await page.goto('/apartments');
  await expect(page.getByTestId('copilot-launcher')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('copilot-launcher').click();
  await expect(page.getByTestId('copilot-model-select')).toBeEnabled();
  await expect(page.getByTestId('copilot-model-select')).toHaveValue(COPILOT_TEST_MODEL);
  await expect(page.getByTestId('copilot-dang-tai-lich-su')).toHaveCount(0);
  await page.getByTitle('Cuộc trò chuyện mới', { exact: true }).click();
  // This locator excludes user bubbles; send has returned before it is read,
  // so the temporary streaming bubble has also been removed.
  const assistant = page.getByTestId('copilot-panel').locator('.flex.justify-start.gap-2 > .bg-muted');
  await expect(assistant).toHaveCount(0);
  const mutations: string[] = [];
  const networkErrors: string[] = [];
  const reads: Response[] = [];
  const requests: Request[] = [];
  const onRequest = (r: Request) => {
    requests.push(r);
    if (unexpectedReadonlyMutation(r.method(), r.url())) mutations.push(`${r.method()} ${new URL(r.url()).pathname}`);
  };
  const onResponse = (r: Response) => {
    if (/\/(rest|functions)\/v1\//.test(r.url()) && !r.ok()) networkErrors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
    if (r.url().split('?')[0].endsWith('/rpc/copilot_available_rooms_v1')) reads.push(r);
  };
  const onFailed = (r: Request) => { networkErrors.push(`Failed ${new URL(r.url()).pathname}`); };
  page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onFailed);
  try {
    const rounds = await guiVaChoModel(page, PROMPT);
    await page.waitForLoadState('networkidle');
    await expect(assistant.last()).toBeVisible();
    const answer = await assistant.last().innerText();
    expect(reads, 'Phải gọi RPC đọc phòng thật sau câu hỏi').toHaveLength(1);
    const read = reads[0];
    expect(read.request().postDataJSON().p_organization_id, 'Chỉ đọc org DEMO').toBe(ORG_DEMO);
    expect(read.ok(), 'RPC phòng phải thành công').toBe(true);
    expect(await read.finished(), 'RPC đọc bị đứt').toBeNull();
    const payload: unknown = await read.json();
    for (const request of requests.filter(r => /\/functions\/v1\/llm-proxy(?:\/|$)/.test(r.url()))) {
      expect((await request.allHeaders())['x-organization-id'], 'Mọi vòng model phải trong DEMO').toBe(ORG_DEMO);
    }
    assertReadonlyResult({ prompt: PROMPT, answer, rounds, payload });
    expect(mutations, 'Không được có ghi nghiệp vụ/RPC chưa được phép trong smoke đọc').toEqual([]);
    expect(networkErrors, 'HTTP/mạng thất bại không phải smoke xanh').toEqual([]);
    expect(errors, `Lỗi console: ${errors.join(' | ')}`).toEqual([]);
    await testInfo.attach('readonly-cycle-summary', { body: JSON.stringify({ model: COPILOT_TEST_MODEL, organization: ORG_DEMO, rounds: rounds.length, readRpc: 'copilot_available_rooms_v1', businessWrites: mutations.length, assistantCharacters: answer.length }), contentType: 'application/json' });
  } finally {
    page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onFailed);
  }
});
