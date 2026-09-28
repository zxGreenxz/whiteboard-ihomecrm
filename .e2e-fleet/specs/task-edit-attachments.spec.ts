import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { JobWithRelations } from '../../src/types/jobs';
import { login, trackConsoleErrors } from './auth';

/**
 * Chạy với FLEET_BASE_URL của bản cần kiểm và FLEET_PASS_CHUNHA từ vault.
 * Hai ca viewport đăng nhập DEMO thật; jobs và byte ảnh mock trong trình duyệt.
 * Ca "DEMO live" tạo fixture riêng trong org DEMO, upload thật rồi
 * đọc lại; dọn job và byte ảnh trong finally bằng chính JWT của DEMO chủ nhà.
 */
const JOB_ID = 'dddd0000-0000-4000-8000-00000000a771';
const TITLE = 'TEST bổ sung ảnh sau khi tạo công việc';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mockJobAndStorage(page: Page) {
  let job: JobWithRelations = {
    id: JOB_ID,
    code: 'CV-TEST-ANH',
    title: TITLE,
    description: 'Phiếu được tạo trước khi có ảnh.',
    building_id: null,
    room_id: null,
    job_type_id: null,
    priority: 'NORMAL',
    assignee_id: null,
    assignee_name: null,
    deadline: null,
    status: 'IN_PROGRESS',
    attachments: null,
    completion_time: null,
    completion_description: null,
    created_at: new Date().toISOString(),
    buildings: null,
    rooms: null,
    job_types: null,
    profiles: null,
  };
  const patches: Record<string, unknown>[] = [];
  const uploads: string[] = [];
  const unexpectedWrites: string[] = [];
  const firstUploadStarted = deferred();
  const releaseFirstUpload = deferred();

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/rest/v1/jobs') {
      if (method === 'GET') {
        // fetchAllRows dừng ở trang rỗng, không dừng chỉ vì trang có ít dòng.
        const firstPage = Number(url.searchParams.get('offset') ?? 0) === 0;
        await route.fulfill({
          json: firstPage ? [job] : [],
          headers: { 'content-range': firstPage ? '0-0/1' : '*/1' },
        });
        return;
      }
      if (method === 'PATCH' && url.searchParams.get('id') === `eq.${JOB_ID}`) {
        const patch = request.postDataJSON() as Record<string, unknown>;
        patches.push(patch);
        job = { ...job, ...patch };
        await route.fulfill({ json: job });
        return;
      }
      unexpectedWrites.push(`${method} jobs`);
      await route.abort('blockedbyclient');
      return;
    }

    const supabaseUpload = url.pathname.match(/^\/storage\/v1\/object\/job-attachments\/(.+)$/);
    const r2Key = url.searchParams.get('key');
    const r2Upload = url.pathname === '/upload' && r2Key?.startsWith('job-attachments/');
    if ((supabaseUpload && method === 'POST') || (r2Upload && method === 'PUT')) {
      const key = supabaseUpload ? `job-attachments/${supabaseUpload[1]}` : r2Key!;
      uploads.push(key);
      if (uploads.length === 1) {
        firstUploadStarted.resolve();
        await releaseFirstUpload.promise;
      }
      await route.fulfill({ json: { Key: key, Id: JOB_ID } });
      return;
    }

    if (url.pathname === '/storage/v1/object/sign/job-attachments' && method === 'POST') {
      const { paths } = request.postDataJSON() as { paths: string[] };
      await route.fulfill({
        json: paths.map((path) => ({
          path,
          signedURL: `/object/sign/job-attachments/${path}?token=fleet-fixture`,
        })),
      });
      return;
    }
    if (url.pathname === '/sign' && r2Key?.startsWith('job-attachments/')) {
      await route.fulfill({ json: { url: `https://task-attachments.invalid/${r2Key}` } });
      return;
    }
    if (method === 'GET' && (
      /^\/storage\/v1\/object\/(?:sign|public)\/job-attachments\//.test(url.pathname)
      || url.hostname === 'task-attachments.invalid'
    )) {
      await route.fulfill({ contentType: 'image/png', body: PNG });
      return;
    }
    if (url.pathname.includes('/job-attachments') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      unexpectedWrites.push(`${method} job-attachments`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  return { patches, uploads, unexpectedWrites, firstUploadStarted, releaseFirstUpload };
}

async function openDetails(page: Page, title = TITLE) {
  await page.getByText(title, { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Sửa phiếu', exact: true })).toBeVisible();
  return dialog;
}

test('DEMO live: upload thật khi sửa phiếu rồi đọc lại ảnh đã lưu', async ({ page }) => {
  if (!process.env.FLEET_BASE_URL) {
    throw new Error('Phải cấp FLEET_BASE_URL của bản cần kiểm.');
  }
  const demoOrg = 'dddd0000-0000-4000-8000-000000000001';
  const id = randomUUID();
  const title = `TEST ảnh sửa công việc ${id}`;
  const errors = trackConsoleErrors(page);
  page.on('pageerror', (error) => errors.push(error.message));
  const signedIn = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/auth/v1/token'
      && response.request().method() === 'POST' && response.status() === 200);
  await login(page, 'chunha');
  const authResponse = await signedIn;
  const auth = await authResponse.json() as {
    access_token: string;
    user: { id: string; email: string };
  };
  expect(auth.user.email).toBe('demo.chunha@username.ihomecrm.local');
  const base = new URL(authResponse.url()).origin;
  const headers = {
    apikey: authResponse.request().headers().apikey!,
    Authorization: `Bearer ${auth.access_token}`,
    'Content-Type': 'application/json',
    'Content-Profile': 'public',
    'Accept-Profile': 'public',
    Prefer: 'return=representation',
  };
  const fixtureQuery = `jobs?id=eq.${id}&organization_id=eq.${demoOrg}`;
  const uploadedPaths = new Set<string>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    const prefix = '/storage/v1/object/job-attachments/';
    if (url.origin === base && request.method() === 'POST' && url.pathname.startsWith(prefix)) {
      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      if (path.startsWith(`${auth.user.id}/`) && path.endsWith(`-${id}.png`)) uploadedPaths.add(path);
    }
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}/${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { code?: string; message?: string };
      throw new Error(`${method} fixture DEMO (${base}): HTTP ${response.status} ${detail.code ?? ''} ${detail.message ?? ''}`);
    }
    return response;
  };

  try {
    const seeded = await call('POST', 'rest/v1/jobs', {
      id, code: `TEST-ATT-${id}`, title, user_id: auth.user.id,
      organization_id: demoOrg, status: 'IN_PROGRESS', priority: 'NORMAL',
      attachments: null, building_id: null,
    });
    const rows = await seeded.json() as { id: string; organization_id: string; attachments: string[] | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.organization_id).toBe(demoOrg);
    expect(rows[0]!.attachments).toBeNull();

    await page.goto('/tasks');
    let details = await openDetails(page, title);
    await expectImages(details, 0);
    const edit = await openEdit(details, page);
    await edit.locator('input[type="file"]').setInputFiles({ name: `${id}.png`, mimeType: 'image/png', buffer: PNG });
    await expectImages(edit, 1);
    await edit.getByRole('button', { name: 'Lưu', exact: true }).click();
    await expect(edit).toBeHidden();

    const stored = await (await call('GET', `rest/v1/${fixtureQuery}&select=id,organization_id,attachments`)).json();
    expect(stored).toHaveLength(1);
    expect(stored[0].organization_id).toBe(demoOrg);
    expect(stored[0].attachments).toHaveLength(1);
    expect(stored[0].attachments[0]).toContain(`/job-attachments/${auth.user.id}/`);
    expect(uploadedPaths.size).toBe(1);
    await page.reload();
    details = await openDetails(page, title);
    await expectImages(details, 1);
    expect(errors).toEqual([]);
  } finally {
    const cleanup = await Promise.allSettled([
      call('DELETE', `rest/v1/${fixtureQuery}`),
      ...(uploadedPaths.size ? [call('DELETE', 'storage/v1/object/job-attachments', { prefixes: [...uploadedPaths] })] : []),
    ]);
    for (const result of cleanup) {
      if (result.status === 'rejected') throw result.reason;
    }
    const remaining = await (await call('GET', `rest/v1/${fixtureQuery}&select=id`)).json();
    expect(remaining, 'fixture công việc DEMO phải được dọn').toEqual([]);
  }
});

async function openEdit(details: Locator, page: Page) {
  await details.getByRole('button', { name: 'Sửa phiếu', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /sửa công việc/i }) });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[type="file"]')).toHaveCount(1);
  return dialog;
}

async function expectImages(dialog: Locator, count: number) {
  const images = dialog.getByRole('img', { name: 'Đính kèm', exact: true });
  await expect(images).toHaveCount(count);
  for (const img of await images.all()) {
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  }
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('sửa phiếu chưa có ảnh, lưu và mở lại; thêm ảnh giữ ảnh cũ', async ({ page }, testInfo) => {
      if (!process.env.FLEET_BASE_URL) {
        throw new Error('Phải cấp FLEET_BASE_URL của bản cần kiểm, không chạy ngầm trên production.');
      }
      const errors = trackConsoleErrors(page);
      page.on('pageerror', (error) => errors.push(error.message));
      const fixture = await mockJobAndStorage(page);
      try {
        await login(page, 'chunha');
        await page.goto('/tasks');
        let details = await openDetails(page);
        await expectImages(details, 0);
        let edit = await openEdit(details, page);
        await expectImages(edit, 0);

        await edit.locator('input[type="file"]').setInputFiles({ name: 'anh-dau.png', mimeType: 'image/png', buffer: PNG });
        await fixture.firstUploadStarted.promise;
        await expect(edit.getByRole('button', { name: /^(Lưu|Đang tải ảnh\.\.\.)$/ })).toBeDisabled();
        expect(fixture.patches).toHaveLength(0);
        fixture.releaseFirstUpload.resolve();
        await expectImages(edit, 1);
        await edit.getByRole('button', { name: 'Lưu', exact: true }).click();
        await expect(edit).toBeHidden();
        expect(fixture.patches).toHaveLength(1);
        const firstAttachments = fixture.patches[0]!.attachments as string[];
        expect(firstAttachments).toHaveLength(1);
        expect(firstAttachments[0]).toContain('/job-attachments/');

        // Reload bỏ React Query cache: ảnh phải đến từ dữ liệu đã gửi qua PATCH.
        await page.reload();
        details = await openDetails(page);
        await expectImages(details, 1);
        edit = await openEdit(details, page);
        await expectImages(edit, 1);
        await edit.locator('input[type="file"]').setInputFiles({ name: 'anh-bo-sung.png', mimeType: 'image/png', buffer: PNG });
        await expectImages(edit, 2);
        await edit.getByRole('img', { name: 'Đính kèm', exact: true }).last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`task-attachments-${viewport.name}.png`) });
        await edit.getByRole('button', { name: 'Lưu', exact: true }).click();
        await expect(edit).toBeHidden();
        expect(fixture.patches).toHaveLength(2);
        const secondAttachments = fixture.patches[1]!.attachments as string[];
        expect(secondAttachments).toHaveLength(2);
        expect(secondAttachments[0]).toBe(firstAttachments[0]);
        expect(secondAttachments[1]).not.toBe(firstAttachments[0]);
        expect(fixture.uploads).toHaveLength(2);

        await page.reload();
        details = await openDetails(page);
        await expectImages(details, 2);
        expect(fixture.unexpectedWrites).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        fixture.releaseFirstUpload.resolve();
      }
    });
  });
}
