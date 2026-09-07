import { expect, type Page, type Response } from '@playwright/test';
import { inspectModelStream, type ReadonlyEvidence } from './copilotSmokeOracle';
import { COPILOT_TEST_MODEL } from './copilotTestModel';

export type ModelCycleStage = 'input' | 'send' | 'response' | 'stream' | 'completion' | 'rounds' | 'panel';
interface ModelCycleExpectation {
  organizationId?: string;
  completionTimeoutMs?: number;
  onStage?: (stage: ModelCycleStage) => void;
}

export async function guiVaChoModel(
  page: Page,
  noiDung: string,
  expected: ModelCycleExpectation = {},
): Promise<ReadonlyEvidence['rounds']> {
  const laModel = (r: Response) => /\/functions\/v1\/llm-proxy(?:\/|$)/.test(new URL(r.url()).pathname) && r.request().method() === 'POST';
  const responses: Response[] = [];
  const ghiResponse = (r: Response) => { if (laModel(r)) responses.push(r); };
  page.on('response', ghiResponse);
  try {
    const response = page.waitForResponse(laModel);
    expected.onStage?.('input');
    await page.getByTestId('copilot-input').fill(noiDung);
    expected.onStage?.('send');
    await page.getByTestId('copilot-send').click();
    expected.onStage?.('response');
    const model = await response;
    expect(model.status(), `Mô hình ${COPILOT_TEST_MODEL} không hoạt động; chưa đo được vòng chat`).toBe(200);
    expected.onStage?.('stream');
    expect(await model.finished(), 'Luồng phản hồi mô hình bị đứt').toBeNull();
    // Send returns only after the entire model/tool cycle, not after first delta.
    // This timeout is a test ceiling, not an agreed product SLA.
    expected.onStage?.('completion');
    await expect(page.getByTestId('copilot-send')).toBeVisible({
      timeout: expected.completionTimeoutMs ?? 60_000,
    });
    expect(responses.length, 'Phải quan sát được request mô hình').toBeGreaterThan(0);
    expected.onStage?.('rounds');
    const rounds: ReadonlyEvidence['rounds'] = [];
    for (const r of responses) {
      const request = r.request();
      expect(request.postDataJSON().model, 'Request gửi sai model đã ghim cho bài kiểm').toBe(
        COPILOT_TEST_MODEL,
      );
      if (expected.organizationId) {
        expect(
          (await request.allHeaders())['x-organization-id'],
          'Request mô hình đi sai phạm vi tổ chức',
        ).toBe(expected.organizationId);
      }
      expect(r.status(), 'Một vòng gọi mô hình thất bại').toBe(200);
      expect(await r.finished(), 'Một vòng phản hồi mô hình bị đứt').toBeNull();
      const body = await r.text();
      inspectModelStream(body);
      rounds.push({ body, messages: request.postDataJSON().messages });
    }
    expected.onStage?.('panel');
    await expect(page.getByTestId('copilot-panel').locator('.bg-red-50.text-red-600')).toHaveCount(0);
    await expect(page.getByTestId('copilot-quyen-chua-tuoi')).toHaveCount(0);
    return rounds;
  } finally {
    page.off('response', ghiResponse);
  }
}
